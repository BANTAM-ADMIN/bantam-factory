"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const root = process.env.CANDIDATE_ROOT;
if (!root) throw new Error("CANDIDATE_ROOT is required");

const chromium = (() => {
  if (process.env.BANTAM_CHROMIUM) return process.env.BANTAM_CHROMIUM;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
    try { execFileSync("which", [name], { stdio: "ignore" }); return name; } catch {}
  }
  throw new Error("no chromium available");
})();

const PROBE = `<script>
(() => {
  const report = () => {
    const controls = [...document.querySelectorAll("[data-theme-choice]")].map((el) => {
      const rect = el.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const style = getComputedStyle(el);
      return {
        text: (el.innerText || "").trim(),
        width: rect.width,
        height: rect.height,
        visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.01,
        hitTarget: top === el || el.contains(top),
        topTag: top?.tagName || null,
        topClass: typeof top?.className === "string" ? top.className : "",
      };
    });
    let node = document.querySelector("#__grade");
    if (!node) {
      node = document.createElement("script");
      node.id = "__grade";
      node.type = "application/json";
      document.documentElement.appendChild(node);
    }
    node.textContent = JSON.stringify({ controls, text: document.body.innerText });
  };
  addEventListener("load", report);
  document.addEventListener("DOMContentLoaded", report);
  setInterval(report, 100);
})();
</script>`;

function render() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const rel = decodeURIComponent(new URL(request.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
      const file = path.resolve(root, rel);
      if (path.relative(root, file).startsWith("..") || !fs.existsSync(file)) return response.writeHead(404).end();
      const ext = path.extname(file);
      let body = fs.readFileSync(file);
      if (ext === ".html") body = Buffer.from(body.toString("utf8").replace("</body>", `${PROBE}</body>`));
      response.writeHead(200, { "Content-Type": ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : "text/javascript" }).end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/index.html`;
      const browser = spawn(chromium, [
        "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
        "--run-all-compositor-stages-before-draw", "--virtual-time-budget=4000",
        "--window-size=1280,800", "--dump-dom", url,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let dom = "";
      let stderr = "";
      browser.stdout.on("data", (chunk) => { dom += chunk; });
      browser.stderr.on("data", (chunk) => { stderr += chunk; });
      browser.on("error", reject);
      browser.on("close", () => {
        server.close();
        const match = dom.match(/<script id="__grade" type="application\/json">([\s\S]*?)<\/script>/);
        if (!match) return reject(new Error(`render probe missing: ${stderr.slice(-300)}`));
        resolve(JSON.parse(match[1]));
      });
    });
  });
}

test("required campaign controls are visibly unobscured and pointer reachable", async () => {
  const result = await render();
  for (const text of ["Signal Garden", "Join the Night Walk", "Night", "Dawn"]) {
    assert.match(result.text, new RegExp(text));
  }
  assert.deepEqual(result.controls.map((control) => control.text), ["Night", "Dawn"]);
  for (const control of result.controls) {
    assert.ok(control.width > 40 && control.height > 24, `${control.text} has rendered geometry`);
    assert.equal(control.visible, true, `${control.text} is CSS-visible`);
    assert.equal(
      control.hitTarget,
      true,
      `${control.text} is obscured at its center by ${control.topTag}.${control.topClass}`,
    );
  }
});
