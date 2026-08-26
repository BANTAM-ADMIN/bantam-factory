// Bantam TUI — a zero-dependency ANSI "cockpit" for watching the loop run.
//
// A pure VIEW over the same events runAgent emits (action, thinking, plan, skills,
// pre-gate, verification). No new deps: raw ANSI + our own frame render.
//
// It renders IN PLACE (not the alternate screen), redrawing a fixed block via
// cursor-up so the final cockpit stays on screen after the run — you can read it
// and scroll to whatever was above it. Phase 1 is read-only; phase 2 adds an input
// line + interrupt/redirect on this same render layer.

const ESC = "\x1b[";
const HIDE = `${ESC}?25l`, SHOW = `${ESC}?25h`, CLR_EOL = `${ESC}K`;

// truecolor palette (bantam plumage). Semantic green/red only for verification.
const c = {
  reset: `${ESC}0m`, bold: `${ESC}1m`,
  gold: `${ESC}38;2;231;169;60m`, goldDim: `${ESC}38;2;185;127;30m`,
  paper: `${ESC}38;2;223;219;208m`, dim: `${ESC}38;2;140;140;150m`,
  think: `${ESC}38;2;130;170;190m`, pass: `${ESC}38;2;63;185;132m`,
  fail: `${ESC}38;2;229;86;75m`, line: `${ESC}38;2;80;82;92m`,
};
const paint = (col, s) => `${col}${s}${c.reset}`;

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visLen = (s) => s.replace(ANSI_RE, "").length;

// Neutralize characters that break fixed-width rendering: a raw TAB advances the
// cursor without erasing (so old frame content bleeds through), and other C0/DEL
// controls corrupt the frame. Applied to untrusted content before it's painted.
const san = (s) => String(s ?? "").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

// pad/truncate a styled string to exactly `w` visible columns
function fit(s, w) {
  const vis = visLen(s);
  if (vis === w) return s;
  if (vis < w) return s + " ".repeat(w - vis);
  let out = "", seen = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b") { const m = s.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/); if (m) { out += m[0]; i += m[0].length; continue; } }
    if (seen >= w - 1) break;
    out += s[i]; seen++; i++;
  }
  return out + c.reset + paint(c.dim, "…");
}

// left + gap + right, exactly `w` visible columns
function spread(left, right, w) {
  const gap = w - visLen(left) - visLen(right);
  if (gap < 1) return fit(left, w);
  return left + " ".repeat(gap) + right;
}

export class BantamTUI {
  constructor({ title = "run", model = "local model" } = {}) {
    this.title = san(title).slice(0, 120);
    this.model = san(model).replace(/\.gguf$/i, "").slice(0, 28);
    this.startAt = Date.now();
    this.stream = [];
    this.plan = null; this.replanned = false;
    this.skillsUsed = []; this.skillLearned = null;
    this.status = "running"; this.verifyDetail = "";
    this.m = { turns: 0, invalid: 0, protocol: 0, think: 0, pregate: 0 };
    this._timer = null; this._prevLines = 0;
    this.active = Boolean(process.stdout.isTTY);
  }

  start() {
    if (!this.active) return;
    process.stdout.write(HIDE);
    this._onResize = () => { this._prevLines = 0; this.render(); }; // full repaint on resize
    process.stdout.on("resize", this._onResize);
    this._exit = () => this.stop();
    process.on("exit", this._exit);
    process.on("SIGINT", () => { this.stop(); process.exit(130); });
    this._timer = setInterval(() => this.render(), 250);
    this.render();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this._timer);
    process.stdout.removeListener?.("resize", this._onResize);
    process.stdout.write(SHOW + "\n");
  }

  push(l) { this.stream.push(l); }

  handleEvent(e) {
    switch (e.type) {
      case "plan_made": this.plan = e.plan; break;
      case "plan_revised": this.plan = e.plan; this.replanned = true; this.push(paint(c.gold, "  🔄 revised the plan")); break;
      case "thinking": this.m.think++; this.push(paint(c.think, `  ~ ${san(e.text.split("\n").find((l) => l.trim()) || "").slice(0, 240)}`)); break;
      case "skills_used": for (const s of e.skills) if (!this.skillsUsed.includes(s)) { this.skillsUsed.push(s); this.push(paint(c.dim, `  · recalling skill: ${s}`)); } break;
      case "skill_learned": this.skillLearned = e.skill; this.push(paint(c.gold, `  + learned skill: ${e.skill}`)); break;
      case "pregate_fail": this.m.pregate++; this.push(paint(c.fail, `  ! pre-gate: ${e.path} — syntax error, fed back`)); break;
      case "protocol_violation": this.m.protocol++; break;
      case "invalid": this.m.invalid++; this.push(paint(c.fail, `  x invalid: ${san(e.error)}`)); break;
      case "action":
        this.m.turns++;
        this.push(paint(c.dim, `  turn ${this.m.turns}`));
        this.push(e.action.a === "done" ? paint(c.paper, "  * done") : `  ${paint(c.gold, "> " + actionLabel(e.action))}`);
        break;
      case "observation": for (const l of san(e.observation).split("\n").slice(0, 4)) this.push(paint(c.dim, `    ${l}`)); break;
      case "verification": {
        this.status = e.verification.status; this.verifyDetail = e.verification.detail || "";
        const col = this.status === "pass" ? c.pass : c.fail;
        this.push(paint(col, `  ${this.status === "pass" ? "=" : "x"} verification: ${this.status.toUpperCase()}`));
        break;
      }
    }
    this.render();
  }

  finish(result) {
    if (result?.verification) this.status = result.verification.status;
    this.render();          // paint the final frame in place...
    this.stop();            // ...and leave it there (cursor restored, newline)
  }

  dims() {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const W = Math.min(Math.max(cols - 1, 40), 118); // cap + 1-col margin so nothing wraps
    const RW = Math.min(30, Math.max(18, Math.floor(W * 0.3)));
    const LW = W - RW - 3;                            // │ L │ R │  == 1+LW+1+RW+1 = W
    const bodyH = Math.max(4, Math.min(rows - 5, 40));
    return { W, LW, RW, bodyH };
  }

  render() {
    if (!this.active) return;
    const lines = this.frameLines();
    let out = "\r";
    if (this._prevLines > 0) out += `${ESC}${this._prevLines - 1}A`; // back to first line of our block
    out += lines.map((l) => l + CLR_EOL).join("\n");
    // if the new frame is shorter than the last, clear the leftover lines below
    for (let i = lines.length; i < this._prevLines; i++) out += "\n" + CLR_EOL;
    process.stdout.write(out);
    this._prevLines = Math.max(lines.length, this._prevLines);
  }

  frameLines() {
    const { W, LW, RW, bodyH } = this.dims();
    const elapsed = ((Date.now() - this.startAt) / 1000).toFixed(1) + "s";
    const dotCol = this.status === "running" ? c.gold : this.status === "pass" ? c.pass : c.fail;

    const rows = [];
    rows.push(spread(` ${paint(dotCol, "●")} ${paint(c.gold + c.bold, "bantam")}  ${paint(c.paper, this.title)}`,
      paint(c.dim, `${this.model}  ${elapsed} `), W));
    rows.push(paint(c.line, "┌" + "─".repeat(LW) + "┬" + "─".repeat(RW) + "┐"));

    const left = this.stream.slice(-bodyH).map((l) => fit(l, LW));
    while (left.length < bodyH) left.push(" ".repeat(LW));
    const right = this.rightPanel(RW, bodyH);
    for (let i = 0; i < bodyH; i++) {
      rows.push(paint(c.line, "│") + left[i] + paint(c.line, "│") + right[i] + paint(c.line, "│"));
    }
    rows.push(paint(c.line, "└" + "─".repeat(LW) + "┴" + "─".repeat(RW) + "┘"));

    const st = this.status === "running" ? paint(c.gold, "working…")
      : paint(this.status === "pass" ? c.pass : c.fail, `⚑ ${this.status.toUpperCase()}`);
    rows.push(fit(` ${st}  ${paint(c.dim, `${this.m.turns} turns · ${this.m.invalid} invalid · ${this.m.protocol} protocol`)}`, W));
    return rows;
  }

  rightPanel(w, h) {
    const out = [];
    const box = (title) => {
      const dashes = Math.max(0, w - visLen(`─ ${title} `));
      return paint(c.goldDim, "─ ") + paint(c.gold, title) + " " + paint(c.line, "─".repeat(dashes));
    };
    const row = (s) => fit(" " + s, w);
    out.push(box(this.replanned ? "plan*" : "plan"));
    if (this.plan) { out.push(row(paint(c.paper, "◆ " + san(this.plan.goal)))); this.plan.steps.forEach((s, i) => out.push(row(paint(c.dim, `${i + 1}. `) + paint(c.paper, san(s))))); }
    else out.push(row(paint(c.dim, "—")));
    out.push(box("skills"));
    this.skillsUsed.forEach((s) => out.push(row(paint(c.dim, "· " + san(s)))));
    if (this.skillLearned) out.push(row(paint(c.gold, "+ " + san(this.skillLearned))));
    if (!this.skillsUsed.length && !this.skillLearned) out.push(row(paint(c.dim, "—")));
    out.push(box("metrics"));
    const metric = (k, v, col = c.paper) => row(paint(c.dim, k.padEnd(9)) + paint(col, String(v)));
    out.push(metric("turns", this.m.turns));
    out.push(metric("invalid", this.m.invalid, this.m.invalid ? c.fail : c.pass));
    out.push(metric("protocol", this.m.protocol, this.m.protocol ? c.gold : c.pass));
    out.push(metric("grammar", this.m.protocol ? "salvage" : "clean ✓", this.m.protocol ? c.gold : c.pass));
    if (this.m.think) out.push(metric("thinking", `${this.m.think}x`, c.think));
    while (out.length < h) out.push(" ".repeat(w));
    return out.slice(0, h);
  }
}

function actionLabel(a) {
  const rest = Object.entries(a).filter(([k]) => k !== "a")
    .map(([k, v]) => `${k}:${typeof v === "string" ? JSON.stringify(v.length > 30 ? v.slice(0, 30) + "…" : v) : Array.isArray(v) ? `[${v.length}]` : v}`)
    .join(" ");
  return `${a.a}${rest ? " " + rest : ""}`;
}
