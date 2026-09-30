// Small, dependency-free image previews for the interactive terminal.  Native
// terminals get the original image; every true-colour terminal can fall back
// to a compact ANSI rendering of ordinary PNG output from ComfyUI.
import fs from "node:fs";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ESC = "\x1b";

export function terminalImageProtocol(env = process.env) {
  const forced = String(env.BANTAM_IMAGE_PREVIEW_PROTOCOL ?? "").toLowerCase();
  if (["kitty", "iterm", "sixel", "ansi"].includes(forced)) return forced;
  const term = String(env.TERM ?? "");
  const program = String(env.TERM_PROGRAM ?? "");
  // Ghostty implements Kitty graphics. WezTerm implements iTerm's inline
  // image protocol. Some launchers preserve TERM=xterm-256color, so inspect
  // both environment variables rather than relying on TERM alone.
  if (env.KITTY_WINDOW_ID || /kitty|ghostty/i.test(term) || /ghostty/i.test(program)) return "kitty";
  if (program === "iTerm.app" || /wezterm/i.test(term) || /wezterm/i.test(program) || env.WEZTERM_EXECUTABLE) return "iterm";
  return "ansi";
}

export function previewTerminalImage(file, { env = process.env, columns = process.stdout.columns ?? 80 } = {}) {
  const protocol = terminalImageProtocol(env);
  if (protocol === "kitty") return { protocol, output: kittyImage(file, columns) };
  if (protocol === "iterm") return { protocol, output: itermImage(file) };
  const image = decodePng(file);
  if (!image) return { protocol, output: null, reason: "ANSI preview supports PNG files" };
  if (protocol === "sixel") return { protocol, output: sixelImage(image, { columns }) };
  return { protocol, output: renderAnsiImage(image, { columns }) };
}

// Kitty's graphics protocol transfers the bytes in manageable chunks.  The
// terminal detects support before we emit it, so unsupported terminals never
// see an escape sequence accidentally.
function kittyImage(file, columns) {
  const encoded = fs.readFileSync(file).toString("base64");
  const dimensions = pngDimensions(file);
  // Kitty places images in terminal cells.  An ordinary cell is roughly twice
  // as tall as it is wide, so a square source needs twice as many columns as
  // rows. Supplying only `c` left Kitty to choose a height and visibly stretched
  // the source into a portrait image on Ubuntu's default font metrics.
  const { columns: cells, rows } = kittyCellDimensions(dimensions, columns);
  const chunks = encoded.match(/.{1,4096}/g) ?? [""];
  return chunks.map((chunk, index) => {
    const more = index < chunks.length - 1 ? 1 : 0;
    const control = index === 0 ? `a=T,f=100,t=d,q=2,c=${cells},r=${rows},m=${more}` : `m=${more}`;
    return `${ESC}_G${control};${chunk}${ESC}\\`;
  }).join("") + "\n";
}

export function kittyCellDimensions(dimensions, columns = 80) {
  const columnLimit = Math.max(12, Math.min(72, Number(columns) - 4 || 72));
  const rowLimit = 24;
  if (!dimensions?.width || !dimensions?.height) return { columns: columnLimit, rows: rowLimit };
  const cells = Math.max(1, Math.min(columnLimit, Math.floor(rowLimit * 2 * dimensions.width / dimensions.height)));
  return { columns: cells, rows: Math.max(1, Math.ceil(cells * dimensions.height / dimensions.width / 2)) };
}

function pngDimensions(file) {
  try {
    const header = fs.readFileSync(file, { encoding: null }).subarray(0, 24);
    if (header.length < 24 || !header.subarray(0, 8).equals(PNG_SIGNATURE) || header.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } catch { return null; }
}

function itermImage(file) {
  const data = fs.readFileSync(file).toString("base64");
  const size = fs.statSync(file).size;
  return `${ESC}]1337;File=inline=1;size=${size};width=auto;height=20:${data}\x07\n`;
}

// Sixel is a native raster protocol used by image-capable xterm, mlterm, foot,
// and several Linux terminal emulators.  It is intentionally opt-in because
// TERM=xterm-256color does not prove that a particular xterm was compiled with
// Sixel support.  A 6x6x6 RGB palette keeps the escape stream bounded while
// retaining considerably more detail than the ANSI fallback.
export function sixelImage(image, { columns = 80 } = {}) {
  const maxWidth = Math.max(40, Math.min(240, (Number(columns) - 4 || 76) * 3));
  const scale = Math.min(1, maxWidth / image.width, 135 / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const indices = new Uint8Array(width * height);
  const palette = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(image.pixels, image.width, image.height, x, y, width, height);
      const index = Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
      indices[y * width + x] = index;
      palette.add(index);
    }
  }
  let output = `${ESC}Pq"1;1;${width};${height}`;
  for (const index of palette) {
    const r = Math.floor(index / 36); const g = Math.floor(index / 6) % 6; const b = index % 6;
    output += `#${index};2;${r * 20};${g * 20};${b * 20}`;
  }
  for (let y = 0; y < height; y += 6) {
    const active = new Set();
    for (let row = y; row < Math.min(y + 6, height); row++) for (let x = 0; x < width; x++) active.add(indices[row * width + x]);
    let first = true;
    for (const index of active) {
      if (!first) output += '$';
      first = false;
      output += `#${index}`;
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let bit = 0; bit < 6 && y + bit < height; bit++) if (indices[(y + bit) * width + x] === index) bits |= 1 << bit;
        output += String.fromCharCode(63 + bits);
      }
    }
    if (y + 6 < height) output += '-';
  }
  return output + `${ESC}\\\n`;
}

/** Render RGB pixels with upper-half blocks: foreground is the top pixel and
 * background is the bottom pixel, so each character carries two image rows. */
export function renderAnsiImage({ width, height, pixels }, { columns = 80, maxRows = 22 } = {}) {
  // A terminal character is usually around twice as tall as it is wide. Each
  // half-block contains two vertical pixels, so rows = width * H / (2 * W).
  // When maxRows limits the result we must reduce width too; clamping rows
  // alone was what made square generations appear stretched wide.
  const columnLimit = Math.max(12, Math.min(72, Number(columns) - 4 || 72));
  const widthForRows = Math.floor(maxRows * 2 * width / height);
  const outWidth = Math.max(1, Math.min(columnLimit, widthForRows || columnLimit));
  const outRows = Math.max(1, Math.ceil(height * outWidth / width / 2));
  const lines = [];
  for (let y = 0; y < outRows; y++) {
    let line = "  ";
    for (let x = 0; x < outWidth; x++) {
      const top = pixelAt(pixels, width, height, x, y * 2, outWidth, outRows * 2);
      const bottom = pixelAt(pixels, width, height, x, y * 2 + 1, outWidth, outRows * 2);
      line += `${ESC}[38;2;${top[0]};${top[1]};${top[2]}m${ESC}[48;2;${bottom[0]};${bottom[1]};${bottom[2]}m▀`;
    }
    lines.push(line + `${ESC}[0m`);
  }
  return lines.join("\n");
}

function pixelAt(pixels, width, height, x, y, outWidth, outHeight) {
  const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / outWidth));
  const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / outHeight));
  const i = (sourceY * width + sourceX) * 4;
  const alpha = pixels[i + 3] / 255;
  // Composite transparent pixels against black rather than leaking an
  // arbitrary RGB value from a transparent PNG into the terminal.
  return [Math.round(pixels[i] * alpha), Math.round(pixels[i + 1] * alpha), Math.round(pixels[i + 2] * alpha)];
}

function decodePng(file) {
  let data;
  try { data = fs.readFileSync(file); } catch { return null; }
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8; let ihdr; const idat = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8; const end = start + length;
    if (end + 4 > data.length) return null;
    if (type === "IHDR") ihdr = data.subarray(start, end);
    if (type === "IDAT") idat.push(data.subarray(start, end));
    offset = end + 4;
    if (type === "IEND") break;
  }
  if (!ihdr || ihdr.length !== 13 || !idat.length) return null;
  const width = ihdr.readUInt32BE(0); const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8]; const colorType = ihdr[9]; const interlace = ihdr[12];
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!width || !height || width * height > 20_000_000 || bitDepth !== 8 || !channels || interlace !== 0) return null;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (width * channels + 1) * height }); } catch { return null; }
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) return null;
  const prior = Buffer.alloc(stride); const current = Buffer.alloc(stride); const pixels = Buffer.alloc(width * height * 4);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    for (let x = 0; x < stride; x++) {
      const source = raw[cursor++]; const left = x >= channels ? current[x - channels] : 0;
      const up = prior[x]; const upLeft = x >= channels ? prior[x - channels] : 0;
      current[x] = unfilter(filter, source, left, up, upLeft);
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels; const to = (y * width + x) * 4;
      pixels[to] = current[from]; pixels[to + 1] = current[from + 1]; pixels[to + 2] = current[from + 2]; pixels[to + 3] = channels === 4 ? current[from + 3] : 255;
    }
    current.copy(prior);
  }
  return { width, height, pixels };
}

function unfilter(filter, source, left, up, upLeft) {
  if (filter === 0) return source;
  if (filter === 1) return (source + left) & 255;
  if (filter === 2) return (source + up) & 255;
  if (filter === 3) return (source + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) {
    const p = left + up - upLeft;
    const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft);
    return (source + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
  }
  throw new Error(`unsupported PNG filter ${filter}`);
}
