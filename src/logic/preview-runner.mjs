// Standalone preview runner: serve a workspace, load one HTML entry in headless
// chromium, and print a JSON report of what actually happened — page errors,
// console messages, failed resource loads, server-side misses — plus a screenshot.
//
// This is its own process (invoked via execFileSync, like the repo_map extractors)
// because the tool registry's answer() contract is synchronous: the caller blocks,
// while in here the HTTP server and browser run concurrently.
//
//   node preview-runner.mjs <workspaceAbs> <entryRel> <optsJson>
//   optsJson: { screenshot, virtualTimeMs, timeoutMs, network, interact, chromium }
//
// stdout: one JSON object (see buildReport). Exit 0 even for pages full of errors —
// errors in the PAGE are the product being reported; only runner-level failures exit 1.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { runViewportBrowser } from "./preview-viewport.mjs";

const [workspaceArg, entryArg, optsArg] = process.argv.slice(2);
const workspace = path.resolve(workspaceArg ?? ".");
const entry = String(entryArg ?? "index.html");
const opts = JSON.parse(optsArg ?? "{}");
const virtualTimeMs = opts.virtualTimeMs ?? 8000;
const timeoutMs = opts.timeoutMs ?? 20000;

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

// Installed FIRST in <head> so it observes everything the page does afterward. State is
// mirrored into a JSON <script> node: script bodies pass through --dump-dom unescaped.
const COLLECTOR = `<script id="__bantam_collector">(() => {
  const REALTIME_PROBE = new URLSearchParams(location.search).has("__bantam_rt");
  // The realtime pass must watch the app RUN: the interaction smoke's quiesce
  // halts every wrapped animation frame when it finishes, which froze the app
  // loop and left the probe measuring an empty compositor at a perfect 60.
  const INTERACT = ${Boolean(opts.interact)} && !REALTIME_PROBE;
  const POINTER_HIT_TEST = ${opts.pointerHitTest !== false};
  const S = {
    pageErrors: [], console: [], rejections: [], resourceErrors: [], layout: null,
    pointerOcclusions: [],
    // issues are defects in the PAGE and are load-bearing: they make the report
    // interaction-problems and can block a done. notes are limits of the SMOKE --
    // true, worth showing, never a defect. Keep them apart: a note promoted to an
    // issue tells the model its correct page is broken. (No backticks in here: this
    // whole collector is a template literal.)
    interaction: INTERACT
      ? { requested: true, completed: false, actions: [], issues: [], notes: [], snapshots: {} }
      : null
  };
  // Interactive previews deliberately start apps that may schedule an endless
  // requestAnimationFrame render loop. Headless Chromium's --dump-dom waits for
  // that work and can hit the outer process timeout even after our bounded smoke
  // is complete. Track frames scheduled after this early collector is injected,
  // then quiesce only at the end of interaction mode so Chromium can return the
  // evidence it already gathered.
  let haltAnimationFrames = false;
  const pendingAnimationFrames = new Map();
  let stepAnimationFrames = false, nextSteppedFrame = -1;
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    if (haltAnimationFrames) return 0;
    if (stepAnimationFrames) {
      const id = nextSteppedFrame--;
      pendingAnimationFrames.set(id, callback);
      return id;
    }
    let id = 0;
    id = nativeRequestAnimationFrame((time) => {
      pendingAnimationFrames.delete(id);
      if (haltAnimationFrames) return;
      callback.call(window, time);
    });
    pendingAnimationFrames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    pendingAnimationFrames.delete(id);
    return nativeCancelAnimationFrame(id);
  };
  // Realtime framerate probe (own pass, no virtual time): two rAF-count
  // windows -- early (~0.3-1.5s) and late (~3-4.2s). A page whose first frame
  // renders and whose main thread then saturates shows late ~= 0 while every
  // virtual-time pass stays green; that class shipped as pass-done once.
  if (REALTIME_PROBE) {
    let frames = 0;
    const tick = () => { frames += 1; nativeRequestAnimationFrame(tick); };
    nativeRequestAnimationFrame(tick);
    const win = (fromMs, toMs) => new Promise((res) => {
      setTimeout(() => {
        const a = frames;
        setTimeout(() => res(((frames - a) * 1000) / (toMs - fromMs)), toMs - fromMs);
      }, fromMs);
    });
    const post = (framerate) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/__bantam_interaction", false);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(JSON.stringify({ realtime: true, framerate }));
      } catch (e) { /* the probe must never break the page */ }
    };
    // Post the early window IMMEDIATELY: on a saturated page the late window's
    // timers may never get a turn before the pass is killed, and that absence
    // is itself the finding — the partial post is what makes it readable.
    win(300, 1500).then((early) => {
      post({ early: Math.round(early * 10) / 10, late: null, partial: true });
      win(1800, 3000).then((late) => {
        post({ early: Math.round(early * 10) / 10, late: Math.round(late * 10) / 10 });
      });
    });
  }
  const boundAnimationFrames = () => {
    stepAnimationFrames = true;
    // Keep the scheduled callbacks: the next control may only change game state,
    // with its visible score/overlay updated by the already-scheduled renderer.
    for (const id of pendingAnimationFrames.keys()) if (id >= 0) nativeCancelAnimationFrame(id);
  };
  const stopAnimationFrames = () => {
    haltAnimationFrames = true;
    for (const id of pendingAnimationFrames.keys()) if (id >= 0) nativeCancelAnimationFrame(id);
    pendingAnimationFrames.clear();
  };
  let node = null;
  // Measured geometry — the grader's kind of eyes. A prose vision description cannot
  // perceive a 6px misalignment; a rect table makes it text the model can reason about.
  const layoutDigest = () => {
    try {
      if (!document.body) return null;
      const out = { viewport: { w: innerWidth, h: innerHeight },
        page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        blocks: [] };
      const take = (el, depth) => {
        if (out.blocks.length >= 24 || el.id === "__bantam_report" || el.id === "__bantam_collector") return;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const text = (el.innerText || "").split("\\n")[0].slice(0, 36);
        out.blocks.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          cls: (el.classList && el.classList[0]) || undefined,
          x: Math.round(r.left), y: Math.round(r.top),
          w: Math.round(r.width), h: Math.round(r.height),
          text: text || undefined,
        });
        if (depth < 2) for (const c of el.children) take(c, depth + 1);
      };
      for (const c of document.body.children) take(c, 1);
      return out;
    } catch (e) { return { error: String(e && e.message || e) }; }
  };
  const flush = () => {
    if (!node) { node = document.createElement("script"); node.id = "__bantam_report"; node.type = "application/json"; }
    S.layout = layoutDigest();
    S.pointerOcclusions = POINTER_HIT_TEST ? pointerOcclusionDigest() : [];
    // innerText is layout-aware: it excludes display:none/visibility:hidden subtrees
    // the way a human's eyes do. It must be read in the page -- the host only has the
    // dumped DOM string, which cannot know what CSS rendered.
    try {
      const shown = String(document.body?.innerText || "").replace(/\\s+/g, " ").trim();
      S.visibleTextLength = shown.length;
      S.visibleText = shown.slice(0, 300);
    } catch { /* a body-less document is reported by the empty-page path */ }
    node.textContent = JSON.stringify(S);
    if (!node.isConnected) (document.head || document.documentElement).appendChild(node);
  };
  setInterval(flush, 150);
  const push = (arr, v) => { if (arr.length < 50) { arr.push(String(v).slice(0, 500)); } flush(); };
  // Two bounded frame batches also admit render-loop and double-rAF UI updates.
  // Do not fast-forward virtual time through an endless game/WebGL loop.
  const settle = async () => {
    await Promise.resolve();
    if (!stepAnimationFrames || haltAnimationFrames) return;
    for (let frame = 0; frame < 2; frame++) {
      const callbacks = [...pendingAnimationFrames.entries()];
      for (const [id, callback] of callbacks) {
        if (!pendingAnimationFrames.delete(id)) continue;
        try { callback.call(window, performance.now()); }
        catch (error) { S.pageErrors.push(String(error?.message || error).slice(0, 500)); }
      }
      await Promise.resolve();
    }
  };
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.hidden || el.getAttribute?.("aria-hidden") === "true"
        || el.classList?.contains("hidden")) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0.01 && rect.width > 1 && rect.height > 1;
  };
  const describe = (el) => {
    if (!el) return null;
    return {
      tag: String(el.tagName || "element").toLowerCase(),
      id: el.id || undefined,
      cls: typeof el.className === "string" ? el.className.slice(0, 80) || undefined : undefined,
      text: String(el.innerText || el.value || el.getAttribute?.("aria-label") || "")
        .replace(/\\s+/g, " ").trim().slice(0, 100) || undefined,
    };
  };
  // A visible control with geometry can still be unusable when another stacking
  // context owns its center point. Chromium already computes that fact exactly;
  // retain a bounded digest instead of asking screenshot vision to infer it.
  const pointerOcclusionDigest = () => {
    const out = [];
    const selector = [
      "button", "input:not([type=hidden])", "select", "textarea",
      "a[href]", "[role=button]", "[role=link]", "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    for (const el of document.querySelectorAll(selector)) {
      if (out.length >= 12 || !visible(el) || el.disabled
          || el.getAttribute?.("aria-disabled") === "true"
          || getComputedStyle(el).pointerEvents === "none") continue;
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      const labelActivates = top?.tagName === "LABEL"
        && (top.control === el || top.contains(el));
      if (top === el || el.contains(top) || labelActivates) continue;
      out.push({
        control: describe(el),
        blocker: describe(top),
        x: Math.round(x),
        y: Math.round(y),
      });
    }
    return out;
  };
  // Overlay transitions can report opacity=0 at the exact virtual-time sample even
  // after their semantic hidden class was removed. For state toggles, class/ARIA/
  // layout state is the trustworthy signal; ordinary controls still use visible().
  const overlayVisible = (el) => {
    if (!el || !el.isConnected || el.hidden || el.getAttribute?.("aria-hidden") === "true"
        || el.classList?.contains("hidden")) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width <= 1 || rect.height <= 1) {
      return false;
    }
    if (el.classList?.contains("visible")) return true;
    // Common inverse overlay contract: base state is opacity:0/pointer-events:none
    // and a visible class enables both. Treat that base state as hidden while
    // still allowing transition frames whose semantic hidden class was removed.
    if (Number(style.opacity || 1) <= 0.01 && style.pointerEvents === "none") return false;
    return true;
  };
  const overlaySnapshot = () => {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll("[id], [role=dialog], .overlay, .modal, .screen")) {
      const classes = [...(el.classList || [])];
      const overlayClass = classes.some((name) => /^(overlay|modal|screen)(?:-|$)/i.test(name));
      const overlayId = /^(?:overlay|modal|screen)$|(?:pause|game.?over|start).*(?:screen|overlay|modal)|(?:screen|overlay|modal).*(?:pause|game.?over|start)/i.test(el.id || "");
      const dialogRole = el.getAttribute("role") === "dialog";
      if (!(overlayClass || overlayId || dialogRole) || !overlayVisible(el)) continue;
      const identity = [el.id, classes.join(" "), el.getAttribute("role") || ""].join(" ");
      const text = String(el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120);
      const key = el.id || identity + text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(describe(el));
      if (out.length >= 10) break;
    }
    return out;
  };
  const hudSnapshot = () => {
    const out = [];
    for (const el of document.querySelectorAll("[id]")) {
      if (!/(score|lines?|level|status|state)/i.test(el.id) || !visible(el)) continue;
      const item = describe(el);
      if (item && item.text) out.push(item);
      if (out.length >= 12) break;
    }
    return out;
  };
  const snapshot = () => ({ hud: hudSnapshot(), overlays: overlaySnapshot() });
  const numericHudValue = (snap, name) => {
    const hud = snap?.hud ?? [];
    const exact = hud.find((item) => new RegExp("^" + name + "(?:[-_](?:val|value))?$", "i").test(item.id || ""));
    const fallback = hud.find((item) =>
      new RegExp(name, "i").test(item.id || "")
      && /^[-+]?\\d[\\d,.]*$/.test(String(item.text || "").trim()));
    const text = String((exact || fallback)?.text || "").replace(/,/g, "").trim();
    return /^[-+]?\\d+(?:\\.\\d+)?$/.test(text) ? Number(text) : null;
  };
  const checkpointInteraction = () => {
    if (!INTERACT) return;
    try {
      flush();
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/__bantam_interaction", false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify({
        pageErrors: S.pageErrors,
        console: S.console,
        rejections: S.rejections,
        resourceErrors: S.resourceErrors,
        layout: S.layout,
        pointerOcclusions: S.pointerOcclusions,
        interaction: S.interaction,
      }));
    } catch { /* the in-DOM report remains the normal evidence path */ }
  };
  const advertised = (word) => new RegExp("\\\\b" + word + "\\\\b", "i")
    .test(String(document.body?.innerText || ""));
  const advertisedKeyboardStart = () => {
    const text = String(document.body?.innerText || "");
    return /\\b(?:press|hit)\\s+(?:enter|return)\\b[^\\n]{0,40}\\b(?:start|play|begin|restart)\\b/i.test(text)
      || /\\b(?:press|hit)\\s+any\\s+key\\b[^\\n]{0,40}\\b(?:start|play|begin|restart)\\b/i.test(text);
  };
  const advertisedKeyboardPause = () => {
    const text = String(document.body?.innerText || "");
    const controls = [...document.querySelectorAll("button, input[type=button], [role=button], [aria-label], [title]")]
      .filter(visible)
      .map((el) => [
        el.innerText,
        el.value,
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.id,
        typeof el.className === "string" ? el.className : "",
      ].filter(Boolean).join(" "))
      .join("\\n");
    return /\\b(?:press|hit|type|key)\\s+(?:the\\s+)?(?:p|key\\s*p)\\b[^\\n]{0,50}\\bpause\\b/i.test(text)
      || /\\bpause\\b[^\\n]{0,50}\\b(?:press|hit|type|key)\\s+(?:the\\s+)?(?:p|key\\s*p)\\b/i.test(text)
      || /\\b(?:pause|paused|resume)\\b/i.test(controls);
  };
  const primaryControl = () => {
    const candidates = [...document.querySelectorAll("button, input[type=button], input[type=submit], [role=button], a[href]")]
      .filter(visible);
    const score = (el) => {
      const text = String(el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
      const identity = [el.id, typeof el.className === "string" ? el.className : "", text].join(" ");
      let n = el.tagName === "BUTTON" ? 10 : 0;
      if (/^(start( game)?|play( now| again)?|begin|launch|new game)$/i.test(text)) n += 100;
      else if (/start|play|begin|launch|new.?game/i.test(identity)) n += 60;
      if (/primary|start|play/i.test(identity)) n += 25;
      return n;
    };
    return candidates.sort((a, b) => score(b) - score(a))[0] || null;
  };
  const dispatchKey = (key, code) => {
    const active = document.activeElement;
    const target = active && active !== document.documentElement ? active : (document.body || document);
    const init = { key, code, bubbles: true, cancelable: true };
    S.interaction.actions.push(code);
    S.interaction.lastAction = code;
    S.interaction.lastActionState = "started";
    checkpointInteraction();
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    S.interaction.lastCompletedAction = code;
    S.interaction.lastActionState = "completed";
    checkpointInteraction();
  };
  const pauseOverlays = (snap) => (snap?.overlays || []).filter((el) =>
    /paus/i.test([el.id, el.cls].filter(Boolean).join(" "))
      || /\\b(?:paused|resume)\\b/i.test(el.text || ""));
  // A classic-script game often keeps its state in global lexical bindings
  // (top-level let/const), which are intentionally absent from window. Direct
  // eval from this early classic script can still feature-detect those bindings
  // after the application scripts have loaded. The probe below only runs checks
  // whose complete capability set is present; module-scoped or differently
  // shaped games are left unjudged instead of receiving speculative failures.
  const lexicalHas = (name) => {
    try { eval(name); return true; } catch { return false; }
  };
  const lexicalRead = (name) => {
    try { return eval(name); } catch { return undefined; }
  };
  const lexicalWrite = (name, value) => {
    window.__bantamProbeSlot = value;
    try {
      eval(name + " = window.__bantamProbeSlot");
      return true;
    } catch {
      return false;
    } finally {
      try { delete window.__bantamProbeSlot; } catch { /* harmless */ }
    }
  };
  const lexicalBinding = (names, accept = () => true) => {
    for (const name of names) {
      if (!lexicalHas(name)) continue;
      const value = lexicalRead(name);
      if (accept(value)) return { name, value };
    }
    return null;
  };
  const fireKey = (key, code, kind) => {
    const target = document.body || document;
    target.dispatchEvent(new KeyboardEvent(kind, {
      key, code, bubbles: true, cancelable: true,
    }));
  };
  const cloneBlocks = (blocks) => blocks.map((block) => [Number(block[0]), Number(block[1])]);
  const occupiedCells = (board) => Array.isArray(board)
    ? board.reduce((total, lane) => total + (Array.isArray(lane)
      ? lane.reduce((count, cell) => count + (cell ? 1 : 0), 0)
      : 0), 0)
    : 0;
  const runInteraction = async () => {
    const I = S.interaction;
    if (!I) return;
    try {
      I.snapshots.before = snapshot();
      checkpointInteraction();
      const primary = primaryControl();
      I.primary = describe(primary);
      if (primary) {
        // A start click commonly activates an endless WebGL/game render loop.
        // Load-only preview already exercised rendering; this mode is a bounded
        // control/state probe, so step animation around each control rather than
        // asking virtual time to render thousands of SwiftShader frames.
        boundAnimationFrames();
        try { primary.focus({ preventScroll: true }); } catch { primary.focus?.(); }
        I.actions.push("click-primary");
        I.lastAction = "click-primary";
        I.lastActionState = "started";
        checkpointInteraction();
        primary.click();
        I.lastCompletedAction = "click-primary";
        I.lastActionState = "completed";
        checkpointInteraction();
        await settle();
        I.startMethod = "primary-control";
      } else if (advertisedKeyboardStart()) {
        boundAnimationFrames();
        I.startMethod = "keyboard-enter";
        dispatchKey("Enter", "Enter");
        await settle();
      } else {
        // A note, not an issue. Every other check here is gated on advertised(): the
        // page's own text claims the feature, so failing it is the page's defect.
        // This branch fires on any page that simply has no start control — a table,
        // a form, a dashboard — and its own wording is "may not". As an issue it
        // classified correct pages as interaction-problems and blocked their done
        // (2026-07-16: web-table-sort, whose task is header-click column sorting,
        // was told it "found working-behavior defects" and burned 6 turns).
        I.notes.push("No visible start/play control or advertised Enter/any-key start instruction was found, so the smoke exercised the page in its initial state only. That is expected for a page with no start control, and is not itself a defect.");
      }
      I.activeAfterPrimary = describe(document.activeElement);
      I.snapshots.afterPrimary = snapshot();

      const active = document.activeElement;
      const activeCanActivate = active && /^(BUTTON|A|INPUT)$/.test(active.tagName);
      if (activeCanActivate && advertised("space")) {
        I.issues.push(
          "The primary control remains focused after activation while Space is advertised as a control; a real Space press can re-activate that button instead of only controlling the app. Blur the control after start or prevent its keyboard activation."
        );
      }

      for (const [key, code] of [
        ["ArrowLeft", "ArrowLeft"], ["ArrowRight", "ArrowRight"],
        ["ArrowUp", "ArrowUp"], ["ArrowDown", "ArrowDown"], [" ", "Space"],
      ]) {
        dispatchKey(key, code);
        await settle();
      }
      I.snapshots.afterKeys = snapshot();
      const scoreBefore = numericHudValue(I.snapshots.afterPrimary || I.snapshots.before, "score");
      const scoreAfter = numericHudValue(I.snapshots.afterKeys, "score");
      if (advertised("space") && /\\bhard\\s+drop\\b/i.test(String(document.body?.innerText || ""))
          && scoreBefore !== null && scoreAfter !== null && scoreAfter === scoreBefore) {
        I.issues.push(
          "Space/Hard Drop is advertised and a score HUD is present, but its value did not change after the hard drop. Verify that the handler awards drop points and refreshes the derived HUD."
        );
      }

      dispatchKey("p", "KeyP");
      await settle();
      I.snapshots.afterPause1 = snapshot();
      dispatchKey("p", "KeyP");
      await settle();
      I.snapshots.afterPause2 = snapshot();

      const firstPause = pauseOverlays(I.snapshots.afterPause1);
      const secondPause = pauseOverlays(I.snapshots.afterPause2);
      if (firstPause.length && secondPause.length) {
        I.issues.push("P opened a visible pause overlay, but the second P did not close it; keyboard pause cannot toggle back to play.");
      } else if (advertisedKeyboardPause() && !firstPause.length) {
        I.issues.push("Pause is advertised, but the first dispatched P did not expose a visible pause overlay.");
      }
    } catch (e) {
      I.issues.push("Interaction smoke crashed: " + String(e && e.message || e).slice(0, 300));
    } finally {
      I.completed = true;
      flush();
      stopAnimationFrames();
      checkpointInteraction();
    }
  };
  window.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) push(S.resourceErrors, (t.tagName || "?") + " failed to load: " + (t.src || t.href));
    else push(S.pageErrors, (e.message || "error") + " @ " + (e.filename || "?") + ":" + (e.lineno || 0));
  }, true);
  window.addEventListener("unhandledrejection", (e) => {
    push(S.rejections, (e.reason && (e.reason.stack || e.reason.message)) || String(e.reason));
  });
  for (const level of ["error", "warn"]) {
    const orig = console[level].bind(console);
    console[level] = (...a) => {
      push(S.console, level + ": " + a.map((x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } }).join(" "));
      orig(...a);
    };
  }
  document.addEventListener("DOMContentLoaded", flush);
  if (INTERACT) {
    const begin = () => queueMicrotask(runInteraction);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", begin, { once: true });
    else begin();
  }
  flush();
})();</script>`;

function injectCollector(html) {
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}${COLLECTOR}`);
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) return html.replace(htmlTag[0], `${htmlTag[0]}${COLLECTOR}`);
  return COLLECTOR + html;
}

const serverMisses = [];
let interactionCheckpoint = null;
let realtimeCheckpoint = null;
const server = http.createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (pathname === "/__bantam_interaction" && req.method === "POST") {
      const chunks = [];
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 256 * 1024) chunks.push(chunk);
      });
      req.on("end", () => {
        if (bytes <= 256 * 1024) {
          try {
            const posted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (posted && posted.realtime) realtimeCheckpoint = posted;
            else interactionCheckpoint = posted;
          } catch { /* keep the previous valid checkpoint */ }
        }
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
      });
      return;
    }
    let rel = pathname.replace(/^\/+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const abs = path.resolve(workspace, rel);
    if (path.relative(workspace, abs).startsWith("..")) {
      serverMisses.push(`403 ${pathname} (outside workspace)`);
      res.writeHead(403).end("forbidden");
      return;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      if (serverMisses.length < 50) serverMisses.push(`404 ${pathname}`);
      res.writeHead(404).end("not found");
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    let body = fs.readFileSync(abs);
    if (ext === ".html" || ext === ".htm") body = Buffer.from(injectCollector(body.toString("utf8")));
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  } catch (e) {
    if (serverMisses.length < 50) serverMisses.push(`500 ${req.url}: ${e.message}`);
    res.writeHead(500).end("server error");
  }
});

function baseArgs({ virtualTime = true } = {}) {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--ignore-certificate-errors",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--run-all-compositor-stages-before-draw",
    "--window-size=1280,800",
    "--hide-scrollbars",
  ];
  // Egress is blocked by default: all non-local traffic is pointed at a dead proxy, so
  // model-written page JS cannot ship workspace data anywhere. Same opt-in as the shell.
  if (virtualTime) args.push(`--virtual-time-budget=${virtualTimeMs}`);
  if (!opts.network) args.push("--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1");
  return args;
}

function runBrowser(args, capMs = timeoutMs) {
  if (opts.viewport) {
    const url = args.at(-1);
    const screenshotArg = args.find(a => a.startsWith('--screenshot='));
    return runViewportBrowser({ chromium: opts.chromium || 'chromium',
      args: args.slice(0, -1).filter(a => a !== '--dump-dom' && !a.startsWith('--screenshot=')), url,
      ...opts.viewport, timeoutMs: capMs, interact: Boolean(opts.interact),
      screenshot: screenshotArg?.slice('--screenshot='.length), realtime: url.includes('__bantam_rt=1') });
  }
  return new Promise((resolve, reject) => {
    const browser = spawn(opts.chromium || "chromium", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    browser.stdout.on("data", (c) => { stdout += c; });
    browser.stderr.on("data", (c) => { stderr += c; });
    const killer = setTimeout(() => {
      timedOut = true;
      browser.kill("SIGKILL");
    }, capMs);
    browser.on("error", (e) => { clearTimeout(killer); reject(new Error(`chromium spawn failed: ${e.message}`)); });
    browser.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/${entry.split(path.sep).join("/")}`;
  try {
    // Two passes: --dump-dom and --screenshot are both terminal "commands" to headless
    // chromium and truncate each other when combined (measured), so the error report and
    // the pixels each get their own run against the same server.
    const domPass = await runBrowser([...baseArgs(), "--dump-dom", url]);
    let shotPass = { code: null, signal: null, timedOut: false, stderr: "" };
    // Interaction mode normally stays one bounded evidence pass. An explicitly
    // enabled screenshot-vision experiment may request a second, initial-state
    // screenshot pass. It is costed separately and is never presented as the
    // post-interaction state captured by the DOM evidence.
    if (opts.screenshot && (!opts.interact || opts.captureInteractiveScreenshot) && !domPass.timedOut) {
      shotPass = await runBrowser([...baseArgs(), `--screenshot=${opts.screenshot}`, url]);
    }
    // Realtime health pass: NO virtual time, so the page lives on the real
    // clock; the probe posts its framerate mid-flight and the kill afterwards
    // is expected (this chromium was never going to exit on its own).
    if (opts.realtimeProbe && !domPass.timedOut) {
      await runBrowser([...baseArgs({ virtualTime: false }), "--mute-audio", `${url}?__bantam_rt=1`], 9000);
    }
    server.close();
    process.stdout.write(JSON.stringify(buildReport({
      code: domPass.code ?? shotPass.code ?? (domPass.timedOut || shotPass.timedOut ? 124 : 1),
      timedOut: domPass.timedOut || shotPass.timedOut,
      interactionTimedOut: domPass.timedOut,
      screenshotCaptureTimedOut: shotPass.timedOut,
      interactionCheckpoint,
      framerate: realtimeCheckpoint?.framerate ?? null,
      dom: domPass.stdout,
      stderr: `${domPass.stderr}\n${shotPass.stderr}`,
      url,
    })));
    process.exit(0);
  } catch (e) {
    server.close();
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
});

function buildReport({
  code,
  timedOut = false,
  interactionTimedOut = false,
  screenshotCaptureTimedOut = false,
  interactionCheckpoint = null,
  framerate = null,
  dom,
  stderr,
  url,
}) {
  let collected = {
    pageErrors: [], console: [], rejections: [], resourceErrors: [],
    interaction: null, pointerOcclusions: [],
  };
  const m = dom.match(/<script id="__bantam_report" type="application\/json">([\s\S]*?)<\/script>/);
  if (m) { try { collected = JSON.parse(m[1]); } catch { /* report node was mid-write */ } }
  if (interactionCheckpoint?.interaction && (interactionTimedOut || !collected.interaction?.completed)) {
    collected = { ...collected, ...interactionCheckpoint };
  }
  if (interactionTimedOut && collected.interaction?.requested && !collected.interaction.completed) {
    const action = collected.interaction.lastAction;
    const issue = action
      ? `Interaction smoke timed out while dispatching ${action}; that control may have entered a non-terminating handler.`
      : "Interaction smoke timed out before the bounded control sequence completed.";
    collected.interaction.timedOut = true;
    collected.interaction.issues = [...new Set([...(collected.interaction.issues ?? []), issue])];
  }

  // Visible-text sketch (blank-page detector). The collector reports the page's
  // own layout-aware innerText; prefer it. Stripping tags from the dumped DOM is
  // a textContent equivalent that counts CSS-hidden subtrees as visible -- it
  // reported 149 characters for a page whose root was display:none and rendered
  // blank (2026-07-16). It survives only as the no-collector fallback, where the
  // choice is a coarse over-count or no blank-page signal at all.
  const sketch = dom
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const measuredVisibleText = typeof collected.visibleTextLength === "number";
  const visibleTextLength = measuredVisibleText ? collected.visibleTextLength : sketch.length;
  const visibleTextSample = measuredVisibleText ? String(collected.visibleText ?? "") : sketch.slice(0, 300);

  const screenshotBytes = opts.screenshot && fs.existsSync(opts.screenshot)
    ? fs.statSync(opts.screenshot).size : 0;

  return {
    ok: true,
    url,
    entry,
    browserExit: code,
    browserTimedOut: Boolean(timedOut),
    interactionTimedOut: Boolean(interactionTimedOut),
    screenshotCaptureTimedOut: Boolean(screenshotCaptureTimedOut),
    framerate,
    collectorSeen: Boolean(m),
    pageErrors: collected.pageErrors ?? [],
    consoleMessages: collected.console ?? [],
    rejections: collected.rejections ?? [],
    resourceErrors: collected.resourceErrors ?? [],
    interaction: collected.interaction ?? (opts.interact
      ? { requested: true, completed: false, actions: [], issues: ["Interaction smoke did not produce a report."], notes: [] }
      : null),
    pointerOcclusions: Array.isArray(collected.pointerOcclusions)
      ? collected.pointerOcclusions.slice(0, 12)
      : [],
    layout: collected.layout ?? null,
    serverMisses,
    visibleTextLength,
    visibleTextSample,
    screenshot: opts.screenshot ?? null,
    screenshotBytes,
    browserStderrTail: code === 0 ? "" : stderr.slice(-800),
  };
}
