// The BANTAM rooster's terminal animations — idle, peck, flap, crow, walk.
//
// The frames are pre-rendered truecolor half-block sprites (assets/bantam-frames.json, authored
// alongside the pixel banner). This is a native JS port of the bundled play.py: each frame is drawn
// in place by moving the cursor back up over the previous one, so the rooster loops smoothly without
// scrolling. Needs a UTF-8, truecolor terminal — callers gate on TTY + color.

import fs from "node:fs";

const FRAMES = {
  full: new URL("../assets/bantam-frames.json", import.meta.url),    // 22×11 sprites
  micro: new URL("../assets/bantam-micro-frames.json", import.meta.url), // 14×4, fits inline
};
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** The animation table for a set ("full" | "micro"), or null if the asset is missing/unreadable. */
export function loadAnimations(set = "full") {
  try { return JSON.parse(fs.readFileSync(FRAMES[set] || FRAMES.full, "utf8")); }
  catch { return null; }
}

/** Names of the available animations (empty if the asset is missing). */
export function animationNames(set = "full") {
  const data = loadAnimations(set);
  return data ? Object.keys(data) : [];
}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Play one or more animations in place. `seq` is an animation name, or an array of
 * `[name, reps]` pairs (a bare name means one rep).
 *
 * @returns {Promise<boolean>} false if animations couldn't be loaded / none matched.
 */
export async function playAnimation(seq, { loops = 1, fps = 0, out = process.stdout, signal, set = "full", indent = 0, clearAfter = false } = {}) {
  const data = loadAnimations(set);
  if (!data) return false;
  const pairs = (Array.isArray(seq) ? seq : [[seq, 1]])
    .map((s) => (Array.isArray(s) ? s : [s, 1]))
    .filter(([name]) => data[name]);
  if (!pairs.length) return false;

  const rows = Math.max(...pairs.map(([name]) => data[name].rows));
  const pad = " ".repeat(Math.max(0, indent));
  let first = true;
  const draw = (frame) => {
    const lines = frame.split("\n");
    let s = first ? "" : `\x1b[${rows}A\r`;              // jump back to the top of the last frame
    for (let i = 0; i < rows; i++) s += `${pad}${lines[i] ?? ""}\x1b[K\n`;  // \x1b[K clears any ghosting
    out.write(s);
    first = false;
  };

  out.write(HIDE_CURSOR);
  try {
    for (let count = 0; loops === 0 || count < loops; count++) {
      for (const [name, reps] of pairs) {
        const anim = data[name];
        const delay = 1000 / (fps || anim.fps);
        for (let r = 0; r < reps; r++) {
          for (const frame of anim.frames) {
            if (signal?.aborted) return true;
            draw(frame);
            await sleep(delay, signal);
          }
        }
      }
    }
  } finally {
    // clearAfter rewinds over the sprite so a fleeting celebration leaves no clutter in the scrollback.
    out.write(clearAfter && !first ? `\x1b[${rows}A\x1b[0J${SHOW_CURSOR}` : `${SHOW_CURSOR}\n`);
  }
  return true;
}

/** A curated one-shot showcase: strut in, crow, peck, flap, settle. */
export function showcaseSequence() {
  return [["walk", 2], ["idle", 1], ["crow", 1], ["peck", 1], ["flap", 2], ["idle", 2]];
}
