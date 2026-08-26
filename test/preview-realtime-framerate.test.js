// The realtime framerate gauge: virtual time makes a saturated page look
// healthy by construction, so a dedicated no-virtual-time pass measures the
// app on the real clock. The choked fixture's first frames render fine —
// exactly the class that shipped as pass-done once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPreviewSync, formatPreviewReport, chromiumBinary } from "../src/logic/preview.js";

const rig = fs.mkdtempSync(path.join(os.tmpdir(), "fpsrig-"));
fs.writeFileSync(path.join(rig, "healthy.html"),
  `<!doctype html><html><head><title>ok</title></head><body><canvas id="c"></canvas>
<script>const c=document.getElementById("c").getContext("2d");let t=0;
(function loop(){t++;c.fillRect(t%100,0,4,4);requestAnimationFrame(loop)})();</script></body></html>`);
fs.writeFileSync(path.join(rig, "choked.html"),
  `<!doctype html><html><head><title>choke</title></head><body><canvas id="c"></canvas>
<script>const c=document.getElementById("c").getContext("2d");let n=0;
(function loop(){n++;const t0=performance.now();
if(n>2){while(performance.now()-t0<900){Math.sqrt(n);}}
c.fillRect(n%100,0,4,4);requestAnimationFrame(loop)})();</script></body></html>`);

const haveChromium = Boolean(chromiumBinary());

test("healthy page: sustained fps measured and reported healthy", { skip: !haveChromium }, () => {
  const r = runPreviewSync(rig, "healthy.html", { interact: true });
  assert.ok(r.framerate, "realtime pass must deliver a framerate");
  assert.ok(r.framerate.early > 15, `early ${r.framerate.early}`);
  assert.ok(r.framerate.late > 15, `late ${r.framerate.late}`);
  assert.match(formatPreviewReport(r), /REALTIME: \d+(\.\d+)? fps sustained/);
});

test("choked page: saturation is a loud finding, not a green light", { skip: !haveChromium }, () => {
  const r = runPreviewSync(rig, "choked.html", { interact: true });
  assert.ok(r.framerate, "even a choked page must deliver the partial probe");
  const fr = r.framerate;
  const saturated = (fr.late == null && Number.isFinite(fr.early)) || (Number.isFinite(fr.late) && fr.late < 15);
  assert.ok(saturated, `expected saturation verdict, got ${JSON.stringify(fr)}`);
  assert.match(formatPreviewReport(r), /MAIN THREAD SATURATED/);
});
