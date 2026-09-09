import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { DEFAULT_SEED } from './constants.js';
import { mulberry32, clamp } from './utils.js';

let buildSeed = DEFAULT_SEED, anisotropy = 1;
const cache = new Map(), tiles = new Map(), textures = new Set();
const timings = {};
let canvases = 0, estimatedBytes = 0;
const noiseRng = mulberry32(12345);
const simplex = new SimplexNoise({ random: noiseRng });
export const TEXTURE_META = {};
export const TEXTURE_NAMES = [];
const generators = new Map();
export function initTextures(renderer, seed = DEFAULT_SEED) {
  buildSeed = seed;
  anisotropy = renderer.capabilities.getMaxAnisotropy();
}
export function makeCanvas(w, h) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvases++;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
}
export function rngFor(name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return mulberry32(hash ^ buildSeed);
}
export function noise2(x, y) { return simplex.noise(x, y); }
export function fbm(x, y, octaves = 4, lac = 2, gain = 0.5) {
  let sum = 0, amp = 1, total = 0;
  for (let i = 0; i < octaves; i++) { sum += noise2(x, y) * amp; total += amp; x *= lac; y *= lac; amp *= gain; }
  return sum / total;
}
export function noiseTile(seed, octaves = 4, size = 256) {
  const key = `${seed}:${octaves}:${size}`;
  if (tiles.has(key)) return tiles.get(key);
  if (tiles.size >= 6) throw Error('Noise tile budget exceeded');
  const data = new Float32Array(size * size), offset = mulberry32(seed).range(0, 1000);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, nx = u * 4, ny = v * 4;
    const a = fbm(nx + offset, ny + offset, octaves), b = fbm(nx - 4 + offset, ny + offset, octaves);
    const c = fbm(nx + offset, ny - 4 + offset, octaves), d = fbm(nx - 4 + offset, ny - 4 + offset, octaves);
    data[y * size + x] = 0.5 + 0.5 * ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v);
  }
  tiles.set(key, data); return data;
}
export function sampleTile(tile, u, v, { rot = 0, ox = 0, oy = 0, scale = 1 } = {}) {
  const n = Math.sqrt(tile.length), c = Math.cos(rot), s = Math.sin(rot);
  const xx = ((u * c - v * s) * scale + ox) * n, yy = ((u * s + v * c) * scale + oy) * n;
  const x = Math.floor(xx), y = Math.floor(yy), tx = xx - x, ty = yy - y;
  const x0 = ((x % n) + n) % n, y0 = ((y % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  return (tile[y0 * n + x0] * (1 - tx) + tile[y0 * n + x1] * tx) * (1 - ty)
    + (tile[y1 * n + x0] * (1 - tx) + tile[y1 * n + x1] * tx) * ty;
}
export function fillNoise(ctx, w, h, { scale = 1, octaves = 4, colorA = '#55504a', colorB = '#b8b2a5', alpha = 1 } = {}) {
  const tile = noiseTile(12345, octaves), a = new THREE.Color(colorA), b = new THREE.Color(colorB);
  a.convertLinearToSRGB(); b.convertLinearToSRGB();
  const img = ctx.getImageData(0, 0, w, h), data = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const f = sampleTile(tile, x / w, y / h, { scale }), i = (y * w + x) * 4;
    data[i] = data[i] * (1 - alpha) + 255 * (a.r + (b.r - a.r) * f) * alpha;
    data[i + 1] = data[i + 1] * (1 - alpha) + 255 * (a.g + (b.g - a.g) * f) * alpha;
    data[i + 2] = data[i + 2] * (1 - alpha) + 255 * (a.b + (b.b - a.b) * f) * alpha;
    data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
export function grimeOverlay(ctx, w, h, { strength = 0.35, bottomBias = 0.7, rng } = {}) {
  rng ||= rngFor('grime');
  ctx.save();
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, `rgba(47,35,19,${strength * 0.1})`);
  gradient.addColorStop(0.65, `rgba(65,48,26,${strength * 0.2})`);
  gradient.addColorStop(1, `rgba(37,29,21,${strength * bottomBias})`);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(59,42,23,${rng.range(0.01, strength * 0.1)})`;
    ctx.beginPath(); ctx.ellipse(rng() * w, rng() * h, rng.range(3, w * 0.13), rng.range(2, h * 0.05), rng() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
export function drips(ctx, w, h, { count = 6, color = 'rgba(78,43,19,.3)', maxLen = h * 0.7, rng } = {}) {
  rng ||= rngFor('drips'); ctx.save(); ctx.strokeStyle = color;
  for (let i = 0; i < count; i++) {
    const x = rng() * w, y = rng() * h * 0.4, length = rng() * maxLen;
    ctx.lineWidth = rng.range(1, 5); ctx.beginPath(); ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + 3, y + length * 0.3, x - 2, y + length * 0.7, x + rng.range(-4, 4), y + length); ctx.stroke();
  }
  ctx.restore();
}
export function scratches(ctx, w, h, { count = 60, color = 'rgba(224,213,184,.2)', maxLen = w * 0.2, rng } = {}) {
  rng ||= rngFor('scratches'); ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1;
  for (let i = 0; i < count; i++) { const x = rng() * w, y = rng() * h; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rng.range(-maxLen, maxLen), y + rng.range(-5, 5)); ctx.stroke(); }
  ctx.restore();
}
export function heightToNormal(heightCanvas, strength = 2) {
  const w = heightCanvas.width, h = heightCanvas.height, source = heightCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const { canvas, ctx } = makeCanvas(w, h), image = ctx.createImageData(w, h), out = image.data;
  const at = (x, y) => source[(((y + h) % h) * w + (x + w) % w) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * strength;
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * strength;
    const n = 1 / Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
    out[i] = 127.5 * (1 - dx * n); out[i + 1] = 127.5 * (1 + dy * n); out[i + 2] = 127.5 * (1 + n); out[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0); return canvas;
}
export function packRoughMetal(roughCanvas, metalCanvas = null) {
  const w = roughCanvas.width, h = roughCanvas.height, r = roughCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const m = metalCanvas?.getContext('2d').getImageData(0, 0, w, h).data;
  const { canvas, ctx } = makeCanvas(w, h), image = ctx.createImageData(w, h);
  for (let i = 0; i < r.length; i += 4) { image.data[i] = 255; image.data[i + 1] = r[i]; image.data[i + 2] = m ? m[i] : 0; image.data[i + 3] = 255; }
  ctx.putImageData(image, 0, 0); return canvas;
}
export function toTexture(canvas, { srgb = true, repeat = [1, 1], wrap = THREE.RepeatWrapping, aniso = true, mipmaps = true } = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = wrap; texture.repeat.set(...repeat);
  texture.anisotropy = aniso ? anisotropy : 1; texture.generateMipmaps = mipmaps;
  texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  textures.add(texture); estimatedBytes += canvas.width * canvas.height * 4 * (mipmaps ? 4 / 3 : 1);
  return texture;
}
export function textOnCanvas(ctx, text, { font = 'bold 64px Arial', size, color = '#eee6ce', x, y, align = 'center', letterSpacing = 0, maxWidth, stroke, strokeWidth = 1, rotate = 0 } = {}) {
  ctx.save(); ctx.translate(x ?? ctx.canvas.width / 2, y ?? ctx.canvas.height / 2); ctx.rotate(rotate);
  ctx.font = size ? font.replace(/\d+px/, `${size}px`) : font;
  ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${letterSpacing}px`;
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = strokeWidth; maxWidth ? ctx.strokeText(text, 0, 0, maxWidth) : ctx.strokeText(text, 0, 0); }
  maxWidth ? ctx.fillText(text, 0, 0, maxWidth) : ctx.fillText(text, 0, 0);
  ctx.restore();
}
export function lineBullet(letter, colorHex, size = 256) {
  const { canvas, ctx } = makeCanvas(size, size);
  ctx.fillStyle = typeof colorHex === 'number' ? `#${colorHex.toString(16).padStart(6, '0')}` : colorHex;
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size * 0.47, 0, Math.PI * 2); ctx.fill();
  textOnCanvas(ctx, letter, { font: `bold ${size * 0.66}px Arial`, color: '#fff', y: size * 0.53 }); return canvas;
}
function register(name, size, meters, maps, generator) {
  TEXTURE_NAMES.push(name); TEXTURE_META[name] = { size, meters, maps }; generators.set(name, generator);
}
export function getTexture(name, variant = 0) {
  const key = `${name}:${variant}`;
  if (cache.has(key)) return cache.get(key);
  const generator = generators.get(name);
  if (!generator) throw Error(`Unknown procedural texture: ${name}`);
  const begin = performance.now(), result = generator(variant, rngFor(key));
  cache.set(key, result); timings[key] = performance.now() - begin; return result;
}
function surfaceMaps(name, paint, { normal = true, metal = false, strength = 1.6 } = {}) {
  const meta = TEXTURE_META[name], [w, h] = meta.size;
  const color = makeCanvas(w, h), height = makeCanvas(w, h), rough = makeCanvas(w, h);
  height.ctx.fillStyle = '#aaa'; height.ctx.fillRect(0, 0, w, h);
  rough.ctx.fillStyle = '#bbb'; rough.ctx.fillRect(0, 0, w, h);
  paint(color.ctx, height.ctx, rough.ctx, w, h);
  const repeat = meta.meters ? [1 / meta.meters[0], 1 / meta.meters[1]] : [1, 1];
  const result = { map: toTexture(color.canvas, { repeat }) };
  const resizeData = source => {
    if (name === 'tileWhite' || (w <= 512 && h <= 512)) return source;
    const target = makeCanvas(Math.min(512, w), Math.min(512, h));
    target.ctx.drawImage(source, 0, 0, target.canvas.width, target.canvas.height); return target.canvas;
  };
  if (normal) result.normalMap = toTexture(heightToNormal(resizeData(height.canvas), strength), { srgb: false, repeat });
  const packed = packRoughMetal(resizeData(rough.canvas), metal ? resizeData(height.canvas) : null);
  result.roughnessMap = toTexture(packed, { srgb: false, repeat });
  if (metal) result.metalnessMap = result.roughnessMap;
  return result;
}
function tileRecipe(name, variant, rng) {
  return surfaceMaps(name, (ctx, height, rough, w, h) => {
    const base = name === 'tileBase', tw = base ? w / 10 : w / 10, th = base ? h / 10 : h / 20;
    ctx.fillStyle = base ? '#3a3a36' : '#7d7568'; ctx.fillRect(0, 0, w, h);
    height.fillStyle = '#161616'; height.fillRect(0, 0, w, h);
    rough.fillStyle = '#e6e6e6'; rough.fillRect(0, 0, w, h);
    for (let row = 0; row < h / th; row++) for (let col = -1; col <= w / tw; col++) {
      const x = col * tw + (base ? 0 : row % 2 * tw / 2), y = row * th;
      const missing = rng() < 0.01;
      ctx.fillStyle = missing ? '#4f463c' : base ? `hsl(150 35% ${rng.range(14, 20)}%)` : `hsl(${rng.range(45, 60)} ${rng.range(4, 9)}% ${rng.range(84, 92)}%)`;
      ctx.fillRect(x + 1, y + 1, tw - 2, th - 2);
      if (missing) continue;
      ctx.strokeStyle = 'rgba(255,250,226,.38)'; ctx.lineWidth = 1;
      ctx.strokeRect(x + 2.5, y + 2.5, tw - 5, th - 5);
      height.fillStyle = '#ddd'; height.fillRect(x + 2, y + 2, tw - 4, th - 4);
      height.fillStyle = '#fff'; height.fillRect(x + 3, y + 3, tw - 6, th - 6);
      rough.fillStyle = base ? '#303030' : '#383838'; rough.fillRect(x + 2, y + 2, tw - 4, th - 4);
      const sheen = ctx.createRadialGradient(x + tw * 0.3, y + th * 0.25, 0, x + tw * 0.4, y + th * 0.4, tw * 0.7);
      sheen.addColorStop(0, 'rgba(255,255,244,.12)'); sheen.addColorStop(1, 'rgba(80,66,38,.07)');
      ctx.fillStyle = sheen; ctx.fillRect(x + 2, y + 2, tw - 4, th - 4);
      if (rng() < 0.3) {
        ctx.strokeStyle = 'rgba(83,76,63,.22)'; ctx.beginPath(); ctx.moveTo(x + tw * 0.2, y + 2);
        ctx.lineTo(x + tw * 0.45, y + th * 0.55); ctx.lineTo(x + tw * 0.6, y + th - 2); ctx.stroke();
      }
      if (rng() < (base ? 0.06 : 0.03)) {
        ctx.fillStyle = '#6a5d50'; ctx.beginPath(); ctx.moveTo(x + 1, y + 1); ctx.lineTo(x + rng.range(5, 13), y + 1); ctx.lineTo(x + 1, y + rng.range(4, 10)); ctx.fill();
        height.fillStyle = '#333'; height.fillRect(x + 1, y + 1, 4, 4);
        rough.fillStyle = '#ccc'; rough.fillRect(x + 1, y + 1, 5, 5);
      }
    }
    grimeOverlay(ctx, w, h, { strength: 0.35, bottomBias: 0.7, rng }); drips(ctx, w, h, { rng });
    if (variant) { ctx.fillStyle = 'rgba(76,65,42,.12)'; ctx.fillRect(0, h * 0.5, w, h * 0.15); }
  });
}
register('tileWhite', [1024, 1024], [2, 2], ['map', 'normalMap', 'roughnessMap'], (v, rng) => tileRecipe('tileWhite', v, rng));
register('tileBase', [512, 512], [1.5, 1.5], ['map', 'normalMap', 'roughnessMap'], (v, rng) => tileRecipe('tileBase', v, rng));
function mosaicRecipe(name, rng) {
  return surfaceMaps(name, (ctx, height, rough, w, h) => {
    const mask = makeCanvas(w, h);
    textOnCanvas(mask.ctx, name === 'mosaicName' ? 'ASHWORTH ST' : '← TRAINS   EXIT →', { font: 'bold 170px Georgia', letterSpacing: 10, color: '#fff', x: w * 0.53, y: h * 0.52, maxWidth: w * 0.81 });
    const pixels = mask.ctx.getImageData(0, 0, w, h).data;
    ctx.fillStyle = '#5a5147'; ctx.fillRect(0, 0, w, h);
    height.fillStyle = '#333'; height.fillRect(0, 0, w, h);
    rough.fillStyle = '#888'; rough.fillRect(0, 0, w, h);
    const tile = 20;
    for (let y = 0; y < h; y += tile) for (let x = 0; x < w; x += tile) {
      const cx = Math.min(w - 1, x + 10), cy = Math.min(h - 1, y + 10), coverage = pixels[(cy * w + cx) * 4 + 3] / 255;
      const border = y < 20 || y > h - 35;
      let color = `hsl(${rng.range(146, 158)} ${rng.range(30, 43)}% ${rng.range(17, 26)}%)`;
      if (border) color = Math.floor(x / tile) % 6 < 3 ? '#e8dcb8' : '#b8862c';
      else if (coverage > 0.5) color = '#efe6cf';
      else if (coverage > 0.2) color = '#a89c78';
      else if (pixels[(cy * w + Math.max(0, cx - 20)) * 4 + 3] > 128 || pixels[(cy * w + Math.min(w - 1, cx + 20)) * 4 + 3] > 128) color = '#17181a';
      ctx.fillStyle = color; ctx.fillRect(x + 1, y + 1, 18, 18);
      ctx.fillStyle = 'rgba(255,244,207,.14)'; ctx.fillRect(x + 2, y + 2, 16, 1);
      height.fillStyle = `rgb(${rng.int(35) + 200},${rng.int(35) + 200},${rng.int(35) + 200})`; height.fillRect(x + 2, y + 2, 16, 16);
    }
    if (name === 'mosaicName') ctx.drawImage(lineBullet('6', '#166541', 160), 22, 48, 160, 160);
    grimeOverlay(ctx, w, h, { strength: 0.16, rng });
  }, { strength: 0.8 });
}
for (const name of ['mosaicName', 'mosaicStair']) register(name, [2048, 256], [8, 0.55], ['map', 'normalMap', 'roughnessMap'], (v, rng) => mosaicRecipe(name, rng));
const SURFACES = {
  concretePainted: ['#bcb7a8', '#dbd5c6', 4], concreteLeak: ['#aaa394', '#d5cebd', 4],
  concreteRaw: ['#55514b', '#77736b', 4], floorSlab: ['#77736b', '#969184', 3],
  trackbed: ['#292827', '#45413a', 4], tactile: ['#a38f26', '#debf39', 0.6],
  steelRust: ['#4b3a2e', '#925224', 1], steelGalv: ['#858b8b', '#b0b4af', 1],
  ironGreen: ['#183022', '#2b4932', 1], wood: ['#614321', '#927044', 1], woodWorn: ['#70502c', '#a08151', 1],
  tieWood: ['#181613', '#393027', 1], tieConcrete: ['#5c5b53', '#928c7b', 1], nosing: ['#6a6457', '#a69d87', 2],
};
for (const [name, recipe] of Object.entries(SURFACES)) {
  const hero = ['concretePainted', 'concreteLeak', 'concreteRaw', 'floorSlab', 'trackbed'].includes(name);
  const wood = /wood/i.test(name), tie = name.startsWith('tie');
  const size = hero ? [1024, 1024] : tie ? [256, 64] : wood ? [512, 128] : name === 'nosing' ? [512, 128] : name === 'ironGreen' ? [512, 1024] : [512, 512];
  const meters = wood ? [1, 0.25] : name === 'nosing' ? [2, 0.3] : [recipe[2], recipe[2]];
  register(name, size, meters, ['map', 'normalMap', 'roughnessMap'], (variant, rng) => surfaceMaps(name, (ctx, height, rough, w, h) => {
    fillNoise(ctx, w, h, { colorA: recipe[0], colorB: recipe[1], scale: variant ? 2 : 1 });
    rough.fillStyle = name === 'steelGalv' ? '#737373' : name === 'ironGreen' ? '#888' : '#ddd'; rough.fillRect(0, 0, w, h);
    const speckles = hero ? 3000 : 600;
    for (let i = 0; i < speckles; i++) {
      const x = rng() * w, y = rng() * h, r = rng.range(0.4, hero ? 2.3 : 1.3);
      ctx.fillStyle = rng() < 0.5 ? 'rgba(23,20,17,.22)' : 'rgba(242,231,200,.18)';
      ctx.fillRect(x, y, r, r); height.fillStyle = rng() < 0.5 ? '#999' : '#bbb'; height.fillRect(x, y, r, r);
    }
    if (name.startsWith('concrete')) {
      for (let i = 0; i < 6; i++) {
        const x = rng() * w, y = rng() * h, r = rng.range(20, 90);
        ctx.fillStyle = '#9c968c'; ctx.beginPath();
        for (let j = 0; j < 12; j++) { const a = j / 12 * Math.PI * 2, rr = r * rng.range(0.45, 1); ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.6); }
        ctx.closePath(); ctx.fill(); ctx.strokeStyle = 'rgba(236,226,209,.4)'; ctx.stroke();
      }
      drips(ctx, w, h, { count: 5, color: 'rgba(122,58,20,.35)', rng });
      if (name === 'concreteRaw') {
        ctx.strokeStyle = 'rgba(30,27,24,.4)'; ctx.lineWidth = 2;
        for (let y = 0; y < h; y += h * 0.15) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        ctx.fillStyle = 'rgba(216,212,200,.15)'; ctx.fillRect(0, h * 0.3, w, h * 0.25);
      }
      if (name === 'concreteLeak') {
        const g = ctx.createRadialGradient(w * 0.5, h * 0.55, 20, w * 0.5, h * 0.55, w * 0.36);
        g.addColorStop(0, 'rgba(57,49,32,.55)'); g.addColorStop(0.8, 'rgba(109,99,85,.3)'); g.addColorStop(0.9, 'rgba(230,226,216,.35)'); g.addColorStop(1, 'rgba(109,99,85,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      }
    }
    if (name === 'floorSlab' || name === 'trackbed') {
      for (let i = 0; i < 8; i++) {
        const x = rng() * w, y = rng() * h, r = rng.range(15, 90);
        const outline = [];
        for (let j = 0; j < 16; j++) { const a = j * Math.PI / 8, radius = r * rng.range(0.65, 1); outline.push([Math.cos(a) * radius, Math.sin(a) * radius * 0.65]); }
        for (const target of [ctx, rough]) {
          target.fillStyle = target === ctx ? 'rgba(38,29,18,.14)' : '#888';
          for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
            target.beginPath(); outline.forEach(([dx, dy], j) => j ? target.lineTo(x + ox + dx, y + oy + dy) : target.moveTo(x + ox + dx, y + oy + dy)); target.closePath(); target.fill();
          }
        }
      }
      ctx.fillStyle = '#3f3b36'; ctx.fillRect(w - 4, 0, 4, h); height.fillStyle = '#111'; height.fillRect(w - 4, 0, 4, h);
      for (let i = 0; i < 3; i++) {
        let x = rng() * w, y = rng() * h; ctx.strokeStyle = '#4c463a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y);
        for (let j = 0; j < 8; j++) { x += rng.range(-20, 25); y += rng.range(5, 25); ctx.lineTo(x, y); } ctx.stroke();
      }
      for (let i = 0; i < 40; i++) { ctx.fillStyle = '#4b4841'; ctx.beginPath(); ctx.ellipse(rng() * w, rng() * h, rng.range(2, 5), rng.range(1, 4), 0, 0, Math.PI * 2); ctx.fill(); }
      if (name === 'trackbed') { ctx.fillStyle = 'rgba(12,13,13,.5)'; ctx.fillRect(w * 0.3, 0, w * 0.4, h); }
    }
    if (name === 'tactile') {
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
        const cx = (x + 0.5) * w / 10, cy = (y + 0.5) * h / 10;
        const g = ctx.createRadialGradient(cx - 4, cy - 4, 1, cx, cy, 18);
        g.addColorStop(0, '#ead66b'); g.addColorStop(0.65, '#c2a737'); g.addColorStop(1, '#75641d');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 18, 0, Math.PI * 2); ctx.fill();
        const hg = height.createRadialGradient(cx, cy, 0, cx, cy, 18); hg.addColorStop(0, '#fff'); hg.addColorStop(1, '#777');
        height.fillStyle = hg; height.beginPath(); height.arc(cx, cy, 18, 0, Math.PI * 2); height.fill();
      }
      scratches(ctx, w, h, { count: 30, color: 'rgba(32,30,24,.5)', maxLen: 65, rng });
      ctx.fillStyle = '#514b2b'; ctx.fillRect(0, 0, w * 0.05, h);
    }
    if (wood) {
      ctx.strokeStyle = 'rgba(45,28,13,.4)';
      for (let i = 0; i < 40; i++) { const y = rng() * h; ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(w * 0.3, y - 8, w * 0.6, y + 8, w, y); ctx.stroke(); }
      for (let i = 0; i < 2; i++) { ctx.beginPath(); ctx.ellipse(rng() * w, rng() * h, 20, 5, 0, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (name === 'ironGreen' || name === 'steelRust') {
      for (let i = 0; i < 100; i++) {
        const x = rng() * w, y = rng() ** 0.6 * h, r = rng.range(2, 14);
        ctx.fillStyle = '#8a6a4a'; ctx.fillRect(x, y, r, r * 0.5); ctx.fillStyle = '#5a2e14'; ctx.fillRect(x + 1, y + 1, r - 2, r * 0.4);
        height.fillStyle = '#666'; height.fillRect(x, y, r, r * 0.5); rough.fillStyle = '#ddd'; rough.fillRect(x, y, r, r * 0.5);
      }
    }
    if (name === 'steelGalv') {
      for (let i = 0; i < 60; i++) { ctx.fillStyle = `rgba(228,237,231,${rng.range(0.03, 0.13)})`; ctx.beginPath(); const x = rng() * w, y = rng() * h; ctx.moveTo(x, y); ctx.lineTo(x + rng.range(8, 55), y + 5); ctx.lineTo(x + 15, y + rng.range(10, 50)); ctx.closePath(); ctx.fill(); }
    }
    if (name === 'nosing') { for (let i = 0; i < 70; i++) { const x = rng() * w; ctx.fillStyle = '#514b41'; ctx.fillRect(x, 0, rng.range(2, 12), rng.range(3, 25)); } }
    grimeOverlay(ctx, w, h, { strength: hero ? 0.22 : 0.15, rng });
  }, { normal: !wood && !tie, metal: name === 'steelRust', strength: name === 'tactile' ? 2.5 : 0.8 }));
}
function graphic(name, paint, emissive = false) {
  const [w, h] = TEXTURE_META[name].size, { canvas, ctx } = makeCanvas(w, h);
  paint(ctx, w, h);
  const meters = TEXTURE_META[name].meters;
  const map = toTexture(canvas, { repeat: meters ? [1 / meters[0], 1 / meters[1]] : [1, 1] });
  return emissive ? { map, emissiveMap: map } : { map };
}
const SIGN_TEXT = {
  signExit: ['EXIT', '← STREET', '#f0ebd5', '#178747'],
  signExitBlue: ['EMERGENCY', 'EXIT', '#234eb8', '#ffffff'],
  signDanger: ['DANGER', '600 VOLTS • KEEP OFF TRACKS', '#e9d7a4', '#a42219'],
  signNoTrespass: ['NO TRESPASSING', 'AUTHORIZED PERSONNEL ONLY', '#e5dfcb', '#242623'],
  signMezz: ['Exit ↑', 'Ashworth St & 3 Av', '#111719', '#f2efdd'],
  signNoEntry: ['NO ENTRY', 'TRANSIT PERSONNEL ONLY', '#9c231d', '#f7edd1'],
  signWetFloor: ['CAUTION', 'WET FLOOR', '#e5bd27', '#22221a'],
  signBoothClosed: ['BOOTH CLOSED', 'PLEASE USE FARE MACHINES', '#eee6d1', '#212b28'],
  signStationClosed: ['STATION CLOSED', 'USE ALTERNATE EXIT', '#e8e0c8', '#b12820'],
};
for (const [name, words] of Object.entries(SIGN_TEXT)) register(name, name.startsWith('signExit') ? [256, 128] : [512, 256], null, ['map'], () => graphic(name, (ctx, w, h) => {
  ctx.fillStyle = words[2]; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = words[3]; ctx.lineWidth = 4; ctx.strokeRect(8, 8, w - 16, h - 16);
  textOnCanvas(ctx, words[0], { font: `bold ${h * 0.28}px Arial`, color: words[3], y: h * 0.4, maxWidth: w * 0.89 });
  textOnCanvas(ctx, words[1], { font: `bold ${h * 0.115}px Arial`, color: words[3], y: h * 0.74, maxWidth: w * 0.87 });
}, name.startsWith('signExit')));
register('signHanging', [1024, 340], null, ['map'], variant => graphic('signHanging', (ctx, w, h) => {
  const downtown = variant === 'B' || variant === 1;
  ctx.fillStyle = '#111214'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#eee9d9'; ctx.lineWidth = 7; ctx.strokeRect(12, 12, w - 24, h - 24);
  ctx.drawImage(lineBullet(downtown ? 'M' : '6', downtown ? '#d27626' : '#128247', 190), 35, 73);
  textOnCanvas(ctx, downtown ? '← Downtown' : 'Uptown →', { font: 'bold 92px Arial', x: 615, y: 126, maxWidth: 710 });
  textOnCanvas(ctx, downtown ? '& Brooklyn' : '& The Bronx', { font: 'bold 62px Arial', x: 615, y: 233, maxWidth: 710 });
}));
register('posters', [512, 768], null, ['map'], (variant, rng) => graphic('posters', (ctx, w, h) => {
  const palettes = [['#e1b534', '#202d35'], ['#20545d', '#efe1be'], ['#b53729', '#f2d5a3'], ['#ded8c5', '#284236']];
  const palette = palettes[Number(variant) % 4];
  ctx.fillStyle = palette[0]; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = palette[1]; ctx.fillRect(25, 24, w - 50, 12);
  textOnCanvas(ctx, 'ASHWORTH / NEW YORK', { font: 'bold 19px Arial', color: palette[1], y: 59 });
  const headlines = ['STAY\nCURIOUS.', 'NIGHT\nSERVICE', 'MAKE\nSOME\nNOISE.', 'LOOK UP.\nLOOK OUT.'];
  const lines = headlines[Number(variant) % 4].split('\n');
  lines.forEach((line, i) => textOnCanvas(ctx, line, { font: '900 92px Arial', color: palette[1], y: 156 + i * 92, maxWidth: 460 }));
  ctx.strokeStyle = palette[1]; ctx.lineWidth = 10;
  if (Number(variant) % 4 === 0) {
    for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc(256, 460, 40 + i * 20, Math.PI * 0.12, Math.PI * 1.82); ctx.stroke(); }
  } else if (Number(variant) % 4 === 1) {
    for (let i = 0; i < 9; i++) { ctx.fillStyle = palette[1]; ctx.fillRect(40 + i * 51, 420 + rng.range(-70, 70), 27, 170); }
    ctx.fillStyle = palette[0]; ctx.beginPath(); ctx.arc(340, 390, 52, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(60, 560); ctx.lineTo(250, 350); ctx.lineTo(450, 560); ctx.closePath(); ctx.stroke();
    textOnCanvas(ctx, Number(variant) % 4 === 2 ? 'LIVE' : '!', { font: 'bold 96px Arial', color: palette[1], y: 500 });
  }
  textOnCanvas(ctx, ['THE CITY IS YOUR MUSEUM', 'EVERY NIGHT. EVERY BOROUGH.', 'FRIDAY • 9 PM • THE FOUNDRY', 'STAND BEHIND THE YELLOW LINE'][Number(variant) % 4], { font: 'bold 22px Arial', color: palette[1], y: 654, maxWidth: 465 });
  textOnCanvas(ctx, 'MUNICIPAL TRANSIT AUTHORITY  /  EST. 1904', { font: '16px Arial', color: palette[1], y: 716 });
  scratches(ctx, w, h, { count: 90, color: 'rgba(248,233,200,.13)', maxLen: 40, rng });
  grimeOverlay(ctx, w, h, { strength: 0.17, rng });
  if (Number(variant) >= 5) {
    ctx.fillStyle = '#c1b7a1'; ctx.beginPath(); ctx.moveTo(0, h * 0.7); ctx.lineTo(110, h * 0.8); ctx.lineTo(65, h * 0.86); ctx.lineTo(130, h); ctx.lineTo(0, h); ctx.fill();
    ctx.strokeStyle = '#eee7cd'; ctx.lineWidth = 4; ctx.stroke();
  }
}, true));
register('flyers', [256, 340], null, ['map'], (variant, rng) => graphic('flyers', (ctx, w, h) => {
  ctx.fillStyle = '#d9d1b9'; ctx.fillRect(0, 0, w, h);
  textOnCanvas(ctx, ['MISSING', 'SERVICE CHANGE', 'ROOM FOR RENT'][Number(variant) % 3], { font: 'bold 31px Arial', color: '#292b26', y: 35, maxWidth: 238 });
  ctx.fillStyle = '#625e50'; ctx.fillRect(35, 75, 186, 116);
  textOnCanvas(ctx, 'PLEASE CALL', { font: 'bold 23px Arial', color: '#292b26', y: 220 });
  textOnCanvas(ctx, '212 • 555 • 0194', { font: 'bold 21px monospace', color: '#292b26', y: 252 });
  ctx.strokeStyle = '#535044';
  for (let x = 0; x < w; x += 25) { ctx.beginPath(); ctx.moveTo(x, 285); ctx.lineTo(x, h); ctx.stroke(); }
  ctx.fillStyle = 'rgba(214,195,134,.6)'; ctx.fillRect(8, 5, 60, 20); ctx.fillRect(w - 68, 8, 60, 20);
  grimeOverlay(ctx, w, h, { strength: 0.13, rng });
}));
register('chainlink', [256, 256], [0.1, 0.1], ['map', 'alphaMap'], () => {
  const color = makeCanvas(256, 256), alpha = makeCanvas(256, 256);
  color.ctx.fillStyle = '#8a8d90'; color.ctx.fillRect(0, 0, 256, 256);
  alpha.ctx.fillStyle = '#000'; alpha.ctx.fillRect(0, 0, 256, 256);
  for (const ctx of [color.ctx, alpha.ctx]) {
    ctx.strokeStyle = ctx === alpha.ctx ? '#fff' : '#c9cbc3'; ctx.lineWidth = 3;
    for (let x = -256; x <= 512; x += 128) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 256, 256); ctx.moveTo(x, 0); ctx.lineTo(x - 256, 256); ctx.stroke(); }
  }
  return { map: toTexture(color.canvas, { repeat: [10, 10] }), alphaMap: toTexture(alpha.canvas, { srgb: false, repeat: [10, 10] }) };
});
register('rail', [256, 64], [1, 0.1], ['roughnessMap', 'metalnessMap'], () => {
  const rough = makeCanvas(256, 64), metal = makeCanvas(256, 64);
  rough.ctx.fillStyle = '#4d4d4d'; rough.ctx.fillRect(0, 0, 256, 64);
  metal.ctx.fillStyle = '#e6e6e6'; metal.ctx.fillRect(0, 0, 256, 64);
  const packed = toTexture(packRoughMetal(rough.canvas, metal.canvas), { srgb: false, repeat: [1, 10] });
  return { roughnessMap: packed, metalnessMap: packed };
});
register('glassGrime', [512, 512], [1, 1], ['alphaMap', 'roughnessMap'], (v, rng) => {
  const alpha = makeCanvas(512, 512), rough = makeCanvas(512, 512);
  alpha.ctx.fillStyle = '#b8b8b8'; alpha.ctx.fillRect(0, 0, 512, 512);
  rough.ctx.fillStyle = '#161616'; rough.ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 18; i++) {
    const x = rng() * 512, y = rng() * 512;
    for (let j = 0; j < 5; j++) for (const ctx of [alpha.ctx, rough.ctx]) {
      ctx.strokeStyle = ctx === alpha.ctx ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.1)';
      ctx.beginPath(); ctx.ellipse(x, y, 8 + j * 2, 14 + j * 2, 0.5, 0, Math.PI * 1.7); ctx.stroke();
    }
  }
  for (const ctx of [alpha.ctx, rough.ctx]) {
    const dust = ctx.createLinearGradient(0, 340, 0, 512);
    dust.addColorStop(0, 'rgba(255,255,255,0)'); dust.addColorStop(1, 'rgba(255,255,255,.55)');
    ctx.fillStyle = dust; ctx.fillRect(0, 340, 512, 172);
    ctx.strokeStyle = ctx === alpha.ctx ? 'rgba(100,100,100,.2)' : 'rgba(180,180,180,.2)'; ctx.lineWidth = 14;
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(260, 280, 140 + i * 12, 85 + i * 7, -0.2, 0.2, 2.7); ctx.stroke(); }
  }
  return { alphaMap: toTexture(alpha.canvas, { srgb: false }), roughnessMap: toTexture(packRoughMetal(rough.canvas), { srgb: false }) };
});
for (const name of ['glowRadial', 'shaftGradient', 'lensStar', 'blobShadow']) {
  const size = name === 'shaftGradient' ? [64, 256] : name === 'lensStar' ? [256, 256] : [128, 128];
  register(name, size, null, ['alphaMap'], () => {
    const [w, h] = size, { canvas, ctx } = makeCanvas(w, h);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    const g = name === 'shaftGradient' ? ctx.createLinearGradient(0, 0, 0, h) : ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, '#fff'); g.addColorStop(name === 'shaftGradient' ? 0.1 : 0.18, '#999'); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    if (name === 'lensStar') {
      ctx.save(); ctx.translate(w / 2, h / 2);
      for (let i = 0; i < 3; i++) { ctx.rotate(Math.PI / 3); const streak = ctx.createLinearGradient(-w / 2, 0, w / 2, 0); streak.addColorStop(0, '#000'); streak.addColorStop(0.5, '#fff'); streak.addColorStop(1, '#000'); ctx.fillStyle = streak; ctx.fillRect(-w / 2, -1, w, 2); }
      ctx.restore();
    }
    return { alphaMap: toTexture(canvas, { srgb: false, wrap: THREE.ClampToEdgeWrapping }) };
  });
}
register('columnPlates', [256, 256], null, ['map'], () => graphic('columnPlates', (ctx, w, h) => {
  ctx.fillStyle = '#14281f'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) {
    const x = i % 4 * 64, y = Math.floor(i / 4) * 32;
    ctx.strokeStyle = '#acaa8e'; ctx.strokeRect(x + 2, y + 2, 60, 28);
    textOnCanvas(ctx, `${i < 13 ? 'A' : 'B'}-${String(i % 13 + 1).padStart(2, '0')}`, { font: 'bold 16px monospace', x: x + 32, y: y + 16 });
  }
}));
for (const name of ['stencilStandClear', 'stencilNoSmoking']) register(name, name === 'stencilStandClear' ? [1024, 128] : [256, 256], name === 'stencilStandClear' ? [3, 0.375] : null, ['map'], (v, rng) => graphic(name, (ctx, w, h) => {
  textOnCanvas(ctx, name === 'stencilStandClear' ? 'STAND CLEAR OF THE PLATFORM EDGE' : 'NO SMOKING', { font: `900 ${h * 0.55}px Arial`, color: '#d4b31a', maxWidth: w * 0.95 });
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 1700; i++) ctx.clearRect(rng() * w, rng() * h, rng.range(1, 5), rng.range(1, 3));
  ctx.globalCompositeOperation = 'source-over';
}));
for (const name of ['vendingFront', 'vendingShelf', 'vendingDisplay', 'fareScreen', 'payphoneKeypad', 'clockFace', 'boothGrille']) {
  const size = name === 'vendingDisplay' ? [256, 64] : name.startsWith('vending') ? [512, 1024] : [256, 256];
  register(name, size, null, ['map'], (variant, rng) => graphic(name, (ctx, w, h) => {
    ctx.fillStyle = name === 'vendingFront' ? '#a8242d' : name === 'fareScreen' ? '#12394e' : '#18201d'; ctx.fillRect(0, 0, w, h);
    if (name === 'vendingFront') {
      textOnCanvas(ctx, 'COLD', { font: '900 110px Arial', y: 130 });
      textOnCanvas(ctx, 'DRINKS', { font: '900 92px Arial', y: 240 });
      ctx.strokeStyle = '#e6d9b9'; ctx.lineWidth = 14;
      ctx.beginPath(); ctx.moveTo(20, 870); ctx.bezierCurveTo(120, 530, 370, 960, 500, 500); ctx.stroke();
      textOnCanvas(ctx, 'ICE COLD • EVERY DAY', { font: 'bold 25px Arial', y: 970 });
      scratches(ctx, w, h, { count: 100, rng });
    } else if (name === 'vendingShelf') {
      for (let row = 0; row < 4; row++) for (let col = 0; col < 6; col++) {
        const x = 14 + col * 82, y = 35 + row * 246;
        const colors = ['#a62b29', '#cb992b', '#326447', '#304f77', '#b1b3a8', '#6c4163'];
        ctx.fillStyle = colors[col]; ctx.fillRect(x, y, 55, 166);
        ctx.fillStyle = '#c7c9c0'; ctx.fillRect(x + 2, y, 51, 8); ctx.fillRect(x + 2, y + 158, 51, 8);
        ctx.fillStyle = 'rgba(255,255,255,.17)'; ctx.fillRect(x + 8, y + 10, 8, 145);
        textOnCanvas(ctx, ['COLA', 'POP', 'TEA', 'ICE', 'H2O', 'FIZZ'][col], { font: 'bold 14px Arial', x: x + 28, y: y + 80 });
        ctx.fillStyle = '#939487'; ctx.fillRect(col * 82, y + 180, 82, 10);
        ctx.fillStyle = '#e4d8b9'; ctx.fillRect(x + 6, y + 195, 44, 23);
        textOnCanvas(ctx, '$1.50', { font: 'bold 13px monospace', color: '#252923', x: x + 28, y: y + 207 });
      }
    } else if (name === 'vendingDisplay') {
      textOnCanvas(ctx, 'EXACT CHANGE', { font: 'bold 27px monospace', color: '#75e599', maxWidth: 245 });
    } else if (name === 'fareScreen') {
      textOnCanvas(ctx, 'METRO FARE', { font: 'bold 26px Arial', color: '#e3efe1', y: 40 });
      textOnCanvas(ctx, 'TOUCH TO BEGIN', { font: 'bold 20px Arial', color: '#9dd7d1', y: 98 });
      for (let i = 0; i < 3; i++) { ctx.fillStyle = '#2d7284'; ctx.fillRect(25, 132 + i * 35, 206, 27); }
      textOnCanvas(ctx, 'SINGLE RIDE', { font: 'bold 17px Arial', y: 145 });
      textOnCanvas(ctx, 'REFILL CARD', { font: 'bold 17px Arial', y: 180 });
      textOnCanvas(ctx, 'OTHER LANGUAGES', { font: 'bold 14px Arial', y: 215 });
    } else if (name === 'payphoneKeypad') {
      ctx.fillStyle = '#92958d'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 12; i++) { const x = 18 + i % 3 * 77, y = 10 + Math.floor(i / 3) * 60; ctx.fillStyle = '#343a37'; ctx.fillRect(x, y, 66, 50); textOnCanvas(ctx, '123456789*0#'[i], { font: 'bold 25px Arial', x: x + 33, y: y + 25 }); }
    } else if (name === 'clockFace') {
      ctx.fillStyle = '#e0ddc6'; ctx.beginPath(); ctx.arc(128, 128, 122, 0, Math.PI * 2); ctx.fill();
      for (let i = 1; i <= 12; i++) { const a = i * Math.PI / 6; textOnCanvas(ctx, String(i), { font: 'bold 22px Arial', color: '#222a26', x: 128 + Math.sin(a) * 97, y: 128 - Math.cos(a) * 97 }); }
      ctx.strokeStyle = '#222a26'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(128, 65); ctx.lineTo(128, 128); ctx.lineTo(179, 145); ctx.stroke();
    } else {
      ctx.strokeStyle = '#aaa99a'; ctx.lineWidth = 3;
      for (let x = 0; x < w; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 16) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    }
  }, ['vendingShelf', 'vendingDisplay', 'fareScreen'].includes(name)));
}
for (const name of ['gunMetalRough', 'polymerNormal', 'checkering', 'gunWood']) {
  const maps = name === 'gunMetalRough' ? ['roughnessMap'] : name === 'gunWood' ? ['map', 'normalMap', 'roughnessMap'] : ['normalMap'];
  register(name, [512, 512], [0.5, 0.5], maps, (variant, rng) => {
    if (name === 'gunWood') return surfaceMaps(name, (ctx, height, rough, w, h) => {
      ctx.fillStyle = '#63402b'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 280; i++) {
        const x = rng.range(0, w), bend = rng.range(2, 12);
        ctx.strokeStyle = i % 3 ? 'rgba(30,15,8,.22)' : 'rgba(211,143,73,.18)'; ctx.lineWidth = rng.range(0.5, 2);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + bend, h * 0.3, x - bend, h * 0.7, x, h); ctx.stroke();
      }
      height.drawImage(ctx.canvas, 0, 0); rough.fillStyle = '#999'; rough.fillRect(0, 0, w, h);
      scratches(ctx, w, h, { count: 35, rng });
    });
    const { canvas, ctx } = makeCanvas(512, 512);
    ctx.fillStyle = '#999'; ctx.fillRect(0, 0, 512, 512);
    if (name === 'gunMetalRough') {
      for (let i = 0; i < 512; i++) { ctx.fillStyle = `rgb(${Math.floor(rng.range(85, 180))} ${Math.floor(rng.range(85, 180))} 128)`; ctx.fillRect(0, i, 512, 1); }
      scratches(ctx, 512, 512, { count: 60, rng });
      ctx.strokeStyle = '#444'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, 504, 504);
      return { roughnessMap: toTexture(packRoughMetal(canvas, null), { srgb: false, repeat: [2, 2] }) };
    }
    if (name === 'polymerNormal') {
      for (let i = 0; i < 14000; i++) { const v = Math.floor(rng.range(65, 200)); ctx.fillStyle = `rgb(${v} ${v} ${v})`; ctx.fillRect(rng.int(512), rng.int(512), 2, 2); }
    } else {
      for (let y = 0; y < 512; y += 8) for (let x = 0; x < 512; x += 8) {
        ctx.fillStyle = '#444'; ctx.fillRect(x, y, 8, 8);
        for (let k = 0; k < 4; k++) { ctx.fillStyle = `rgb(${100 + k * 40} ${100 + k * 40} ${100 + k * 40})`; ctx.fillRect(x + k, y + k, 8 - k * 2, 8 - k * 2); }
      }
    }
    return { normalMap: toTexture(heightToNormal(canvas, 1.2), { srgb: false, repeat: [2, 2] }) };
  });
}
register('skin', [512, 512], [1, 1], ['map', 'normalMap', 'roughnessMap'], (variant, rng) => surfaceMaps('skin', (ctx, height, rough, w, h) => {
  ctx.fillStyle = ['#b49e85', '#827b65', '#a7a287'][Number(variant) % 3]; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 1000; i++) {
    const x = rng.range(0, w), y = rng.range(0, h), r = rng.range(1, 9);
    ctx.fillStyle = i % 3 ? 'rgba(90,74,90,.055)' : 'rgba(185,184,148,.07)'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < 10; i++) {
    const x = rng.range(0, w), y = rng.range(0, h);
    ctx.strokeStyle = 'rgba(66,76,78,.2)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x + 12, y + 22, x - 18, y + 45, x + 9, y + 80); ctx.stroke();
  }
  for (let i = 0; i < 4; i++) { ctx.fillStyle = '#674943'; ctx.fillRect(rng.int(w), rng.int(h), rng.range(5, 18), 2); }
  height.drawImage(ctx.canvas, 0, 0); rough.fillStyle = '#b0b0b0'; rough.fillRect(0, 0, w, h);
}, { strength: 0.35 }));
for (const name of ['muzzleFlash', 'spriteAtlas', 'decalHoles', 'decalBlood', 'decalPool', 'decalGlassCrack']) {
  const size = name === 'decalBlood' ? 1024 : ['decalHoles', 'decalGlassCrack'].includes(name) ? 256 : 512;
  register(name, [size, size], null, ['map', 'alphaMap'], (variant, rng) => {
    const { canvas, ctx } = makeCanvas(size, size);
    const grid = name === 'spriteAtlas' || name === 'decalBlood' ? 4 : name === 'muzzleFlash' || name === 'decalHoles' ? 2 : 1;
    const cell = size / grid;
    const radial = (x, y, radius, color, opacity = 1) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius); g.addColorStop(0, `rgba(${color},${opacity})`); g.addColorStop(0.35, `rgba(${color},${opacity * 0.65})`); g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    };
    for (let tile = 0; tile < grid * grid; tile++) {
      ctx.save(); ctx.translate(tile % grid * cell, Math.floor(tile / grid) * cell);
      ctx.beginPath(); ctx.rect(2, 2, cell - 4, cell - 4); ctx.clip();
      const center = cell / 2;
      if (name === 'muzzleFlash') {
        radial(center, center, cell * 0.47, '255,170,60', 0.9);
        ctx.fillStyle = '#ffe0a0'; ctx.beginPath();
        const count = 6 + tile % 3;
        for (let i = 0; i < count * 2; i++) { const a = i * Math.PI / count + tile, r = cell * (i % 2 ? 0.06 : rng.range(0.3, 0.46)); const x = center + Math.cos(a) * r, y = center + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.closePath(); ctx.fill(); radial(center, center, cell * 0.16, '255,255,255');
      } else if (name === 'spriteAtlas') {
        if (tile < 4) for (let i = 0; i < 24; i++) radial(center + rng.range(-0.18, 0.18) * cell, center + rng.range(-0.18, 0.18) * cell, cell * rng.range(0.12, 0.29), '180,183,177', 0.15);
        else if (tile === 4) { ctx.fillStyle = '#fff0b0'; ctx.beginPath(); ctx.ellipse(center, center, cell * 0.035, cell * 0.43, 0, 0, Math.PI * 2); ctx.fill(); }
        else if (tile === 5) { ctx.fillStyle = '#4a0a0a'; ctx.beginPath(); ctx.ellipse(center, center, cell * 0.14, cell * 0.3, 0.3, 0, Math.PI * 2); ctx.fill(); }
        else if ([6, 10, 11, 12].includes(tile)) { ctx.fillStyle = tile === 10 ? '#b09168' : '#bdc2ba'; ctx.beginPath(); ctx.moveTo(cell * 0.3, cell * 0.25); ctx.lineTo(cell * 0.7, cell * 0.45); ctx.lineTo(cell * 0.6, cell * 0.75); ctx.lineTo(cell * 0.25, cell * 0.62); ctx.fill(); }
        else if (tile === 9) { ctx.strokeStyle = '#e6d6bb'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(center, center, cell * 0.33, 0, Math.PI * 2); ctx.stroke(); }
        else radial(center, center, cell * 0.43, '255,244,219');
      } else if (name === 'decalBlood' || name === 'decalPool') {
        ctx.fillStyle = '#4a0a0a'; ctx.beginPath();
        for (let i = 0; i < 48; i++) { const a = i * Math.PI / 24, r = cell * rng.range(name === 'decalPool' ? 0.32 : 0.16, 0.42); const x = center + Math.cos(a) * r, y = center + Math.sin(a) * r * 0.8; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.closePath(); ctx.fill(); radial(center, center, cell * 0.22, '122,16,16', 0.55);
        if (name === 'decalBlood') for (let i = 0; i < 22; i++) { ctx.beginPath(); ctx.arc(rng.range(0.08, 0.92) * cell, rng.range(0.08, 0.92) * cell, rng.range(1, 4), 0, Math.PI * 2); ctx.fill(); }
      } else if (name === 'decalGlassCrack') {
        ctx.strokeStyle = 'rgba(211,237,235,.85)'; ctx.lineWidth = 1;
        for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; ctx.beginPath(); ctx.moveTo(center, center); ctx.lineTo(center + Math.cos(a + 0.15) * cell * 0.18, center + Math.sin(a + 0.15) * cell * 0.18); ctx.lineTo(center + Math.cos(a) * cell * rng.range(0.3, 0.47), center + Math.sin(a) * cell * 0.4); ctx.stroke(); }
      } else {
        ctx.fillStyle = ['#bbb09c', '#534d44', '#bbc1bd', '#5e412a'][tile]; ctx.beginPath();
        for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, r = cell * rng.range(0.19, 0.34); const x = center + Math.cos(a) * r, y = center + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.closePath(); ctx.fill(); radial(center, center, cell * 0.2, '9,10,8');
      }
      ctx.restore();
    }
    const alpha = makeCanvas(size, size), pixels = ctx.getImageData(0, 0, size, size), mask = alpha.ctx.createImageData(size, size);
    for (let i = 0; i < pixels.data.length; i += 4) { mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = pixels.data[i + 3]; mask.data[i + 3] = 255; pixels.data[i + 3] = 255; }
    ctx.putImageData(pixels, 0, 0); alpha.ctx.putImageData(mask, 0, 0);
    return { map: toTexture(canvas, { wrap: THREE.ClampToEdgeWrapping }), alphaMap: toTexture(alpha.canvas, { srgb: false, wrap: THREE.ClampToEdgeWrapping }) };
  });
}
const ENEMY_PALETTES = {
  commuter: ['#8a9478', '#d9dad2', '#2b2d33'], worker: ['#7a8a6a', '#ff7a1a', '#383c38'],
  nurse: ['#6f8a70', '#4aa0a0', '#304e50'], hoodie: ['#6e7a66', '#3a3a44', '#2f3a52'], brute: ['#5e6650', '#49443c', '#33352e'],
};
function paintEnemyPanel(ctx, size, kind, palette, rng) {
  ctx.fillStyle = palette[kind === 'face' || kind === 'skin' ? 0 : kind === 'bottom' ? 2 : 1]; ctx.fillRect(0, 0, size, size);
  const image = ctx.getImageData(0, 0, size, size), data = image.data, tile = noiseTile(12345), params = { rot: 0.3, ox: rng(), oy: rng(), scale: 2 };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, n = sampleTile(tile, x / size, y / size, params), cloth = kind === 'top' || kind === 'bottom';
    const factor = 0.78 + n * 0.35 + (cloth ? ((x + y) % 3 - 1) * 0.035 : 0);
    for (let c = 0; c < 3; c++) data[i + c] *= factor;
    if (!cloth && n < 0.43) { data[i] = data[i] * 0.8 + 18; data[i + 1] *= 0.85; data[i + 2] = data[i + 2] * 0.8 + 18; }
  }
  ctx.putImageData(image, 0, 0);
  if (kind === 'skin' || kind === 'face') {
    for (let i = 0; i < 10; i++) {
      const x = rng.range(0, size), y = rng.range(0, size);
      ctx.strokeStyle = 'rgba(43,48,45,.35)'; ctx.lineWidth = size / 512;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x + 12, y + 20, x - 9, y + 42, x + 8, y + 66); ctx.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const x = rng.range(0.08, 0.92) * size, y = rng.range(0.1, 0.9) * size;
      ctx.fillStyle = '#a39e75'; ctx.beginPath(); ctx.ellipse(x, y, size * 0.025, size * 0.012, i, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#39201f'; ctx.beginPath(); ctx.ellipse(x, y, size * 0.019, size * 0.008, i, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    for (let i = 0; i < 16; i++) {
      const x = rng.range(0, size), y = rng.range(0, size * 0.8);
      ctx.fillStyle = i % 3 ? 'rgba(38,30,23,.18)' : palette[0]; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 14, y + 5); ctx.lineTo(x + 4, y + 30); ctx.lineTo(x - 3, y + 19); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(12,18,20,.45)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(size * 0.5, 0); ctx.lineTo(size * 0.5, size); ctx.stroke();
    if (kind === 'bottom') { ctx.fillStyle = '#191c1a'; ctx.fillRect(0, 0, size, size * 0.18); for (let x = 0; x < size; x += 12) { ctx.fillStyle = '#40413a'; ctx.fillRect(x, size * 0.04, 6, size * 0.05); } }
    else {
      const swatches = ['#181d1b', '#b0ada0', '#713834', '#ff7a1a', '#d6d9cd', '#a4966c', '#4a0a0a', '#758582'];
      swatches.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * size / 8, 0, size / 8, size * 0.14); });
    }
  }
  if (kind === 'face') {
    const ellipse = (x, y, rx, ry, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x * size, y * size, rx * size, ry * size, 0, 0, Math.PI * 2); ctx.fill(); };
    for (const x of [0.425, 0.575]) {
      ellipse(x, 0.45, 0.058, 0.051, '#333b30'); ellipse(x, 0.455, 0.036, 0.02, '#101913'); ellipse(x, 0.45, 0.009, 0.009, '#aab67a');
      ctx.strokeStyle = '#52634c'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo((x - 0.05) * size, 0.405 * size); ctx.lineTo((x + 0.05) * size, 0.402 * size); ctx.stroke();
    }
    ellipse(0.5, 0.29, 0.125, 0.045, 'rgba(48,61,43,.5)');
    ctx.fillStyle = '#a3a585'; ctx.beginPath(); ctx.moveTo(size * 0.5, size * 0.46); ctx.lineTo(size * 0.535, size * 0.59); ctx.lineTo(size * 0.48, size * 0.58); ctx.fill();
    ellipse(0.483, 0.585, 0.013, 0.009, '#263024'); ellipse(0.525, 0.585, 0.013, 0.009, '#263024');
    ellipse(0.5, 0.70, 0.08, 0.073, '#4a2b29'); ellipse(0.5, 0.70, 0.065, 0.057, '#111711');
    for (let i = 0; i < 6; i++) { ctx.fillStyle = i % 3 ? '#aaa783' : '#64694e'; ctx.fillRect((0.45 + i * 0.017) * size, 0.651 * size, size * 0.012, size * (i % 2 ? 0.023 : 0.031)); }
    ctx.strokeStyle = 'rgba(43,40,29,.65)'; ctx.lineWidth = 3; for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo((0.5 + side * 0.08) * size, size * 0.54); ctx.lineTo((0.5 + side * 0.11) * size, size * 0.67); ctx.stroke(); }
  }
}
for (const name of ['cloth', 'face']) register(name, [512, 512], name === 'cloth' ? [1, 1] : null, ['map', 'roughnessMap'], (variant, rng) => {
  const palette = Object.values(ENEMY_PALETTES)[Number(variant) % 5] || ENEMY_PALETTES.commuter, panel = makeCanvas(512, 512), rough = makeCanvas(512, 512);
  paintEnemyPanel(panel.ctx, 512, name === 'face' ? 'face' : 'top', palette, rng); rough.ctx.fillStyle = name === 'cloth' ? '#d9d9d9' : '#a6a6a6'; rough.ctx.fillRect(0, 0, 512, 512);
  return { map: toTexture(panel.canvas), roughnessMap: toTexture(packRoughMetal(rough.canvas, null), { srgb: false }) };
});
register('enemyAtlas', [1024, 1024], null, ['map', 'roughnessMap'], (variant, rng) => {
  const palette = ENEMY_PALETTES[variant] || Object.values(ENEMY_PALETTES)[Number(variant) % 5] || ENEMY_PALETTES.commuter;
  const atlas = makeCanvas(1024, 1024), panel = makeCanvas(512, 512), rough = makeCanvas(512, 512);
  ['face', 'skin', 'top', 'bottom'].forEach((kind, i) => { paintEnemyPanel(panel.ctx, 512, kind, palette, rng); atlas.ctx.drawImage(panel.canvas, i % 2 * 512, Math.floor(i / 2) * 512); });
  rough.ctx.fillStyle = '#a6a6a6'; rough.ctx.fillRect(0, 0, 512, 256); rough.ctx.fillStyle = '#d9d9d9'; rough.ctx.fillRect(0, 256, 512, 256);
  rough.ctx.fillStyle = '#595959'; rough.ctx.beginPath(); rough.ctx.ellipse(128, 67, 28, 15, 0, 0, Math.PI * 2); rough.ctx.fill();
  return { map: toTexture(atlas.canvas, { wrap: THREE.ClampToEdgeWrapping }), roughnessMap: toTexture(packRoughMetal(rough.canvas, null), { srgb: false, wrap: THREE.ClampToEdgeWrapping }) };
});
register('trainSide', [1024, 512], [6, 3.65], ['map', 'normalMap', 'roughnessMap', 'metalnessMap'], (variant, rng) => surfaceMaps('trainSide', (ctx, height, rough, w, h) => {
  ctx.fillStyle = '#b9bcbe'; ctx.fillRect(0, 0, w, h); height.fillStyle = '#ddd'; height.fillRect(0, 0, w, h); rough.fillStyle = '#888'; rough.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y++) { ctx.fillStyle = `rgba(30,38,43,${rng.range(0.015, 0.12)})`; ctx.fillRect(0, y, w, 1); }
  for (let y = h * 0.52; y < h; y += h * 0.08 / 3.65) { height.fillStyle = '#777'; height.fillRect(0, y, w, 3); ctx.fillStyle = 'rgba(20,29,32,.14)'; ctx.fillRect(0, y, w, 1); }
  for (const [c, y] of [['#184c36', 0.26], ['#dddcc7', 0.28], ['#242b28', 0.30]]) { ctx.fillStyle = c; ctx.fillRect(0, h * y, w, h * 0.018); }
  ctx.fillStyle = '#303534'; ctx.fillRect(0, h * 0.89, w, h * 0.02);
  for (let x = 12; x < w; x += 26) { ctx.fillStyle = '#687273'; ctx.beginPath(); ctx.arc(x, 14, 2, 0, Math.PI * 2); ctx.fill(); }
  drips(ctx, w, h, { count: 20, color: 'rgba(40,31,21,.13)', maxLen: h * 0.35, rng });
  scratches(ctx, w, h, { count: 70, color: 'rgba(224,227,218,.3)', maxLen: 80, rng });
}, { metal: true, strength: 1.4 }));
for (const [name, size, meters] of [['trainInterior', [1024, 512], [4, 2]], ['trainFloor', [512, 512], [2, 2]], ['trainSeat', [256, 256], [0.5, 0.5]]]) {
  register(name, size, meters, ['map', 'normalMap', 'roughnessMap'], (variant, rng) => surfaceMaps(name, (ctx, height, rough, w, h) => {
    ctx.fillStyle = name === 'trainInterior' ? '#c7c6b1' : name === 'trainFloor' ? '#484a42' : '#e4d3ac'; ctx.fillRect(0, 0, w, h);
    rough.fillStyle = name === 'trainSeat' ? '#777' : '#ccc'; rough.fillRect(0, 0, w, h);
    if (name === 'trainFloor') {
      for (let i = 0; i < 15000; i++) { const x = rng.int(w), y = rng.int(h); ctx.fillStyle = i % 3 ? '#66685d' : '#282f2b'; ctx.fillRect(x, y, 2, 2); height.fillStyle = i % 3 ? '#aaa' : '#888'; height.fillRect(x, y, 2, 2); }
    } else if (name === 'trainInterior') {
      for (let x = 0; x < w; x += w / 8) { ctx.fillStyle = '#777e71'; ctx.fillRect(x, 0, 2, h); for (const y of [12, h - 12]) { ctx.fillStyle = '#51584e'; ctx.fillRect(x + 5, y, 3, 3); } }
      ctx.fillStyle = '#616759'; ctx.fillRect(0, h * 0.8, w, 4);
      grimeOverlay(ctx, w, h, { strength: 0.2, bottomBias: true, rng });
    } else {
      const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#928975'); g.addColorStop(0.25, '#f4edcf'); g.addColorStop(0.5, '#c5bca3'); g.addColorStop(0.75, '#f4edcf'); g.addColorStop(1, '#928975'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      height.ctx; height.drawImage(ctx.canvas, 0, 0); scratches(ctx, w, h, { count: 18, rng });
    }
  }, { strength: 0.7 }));
}
register('trainAds', [1024, 96], null, ['map'], (variant, rng) => {
  const { canvas, ctx } = makeCanvas(1024, 96), words = ['STAY WELL', 'NIGHT OWL', 'CITY ARTS', 'KEEP MOVING', 'ASHWORTH', 'READ MORE', 'FRESH DAILY', 'GO GREEN', 'TAKE THE 6', 'HOME AGAIN'];
  words.forEach((text, i) => { ctx.fillStyle = ['#b8b19c', '#344e46', '#956744', '#505b73'][i % 4]; ctx.fillRect(i * 102.4, 0, 101, 96); ctx.fillStyle = '#d7ceaa'; ctx.beginPath(); ctx.arc(i * 102.4 + 51, 32, 18, 0, Math.PI * 2); ctx.fill(); textOnCanvas(ctx, text, { font: 'bold 11px Arial', color: '#eee4ce', x: i * 102.4 + 51, y: 68, maxWidth: 94 }); });
  return { map: toTexture(canvas, { wrap: THREE.ClampToEdgeWrapping }) };
});
for (const [name, w, h] of [['trainRouteSign', 512, 128], ['trainSideSign', 256, 64]]) register(name, [w, h], null, ['map', 'emissiveMap'], () => {
  const { canvas, ctx } = makeCanvas(w, h), mask = makeCanvas(w, h);
  ctx.fillStyle = '#090c08'; ctx.fillRect(0, 0, w, h);
  textOnCanvas(mask.ctx, '6  ASHWORTH ST', { font: `bold ${h * 0.43}px monospace`, x: w / 2, y: h / 2, color: '#fff', maxWidth: w * 0.95 });
  const pixels = mask.ctx.getImageData(0, 0, w, h).data, pitch = w === 512 ? 6 : 3;
  for (let y = pitch; y < h; y += pitch) for (let x = pitch; x < w; x += pitch) { ctx.fillStyle = pixels[(y * w + x) * 4 + 3] > 80 ? '#ffac45' : '#302719'; ctx.beginPath(); ctx.arc(x, y, pitch * 0.33, 0, Math.PI * 2); ctx.fill(); }
  const map = toTexture(canvas, { wrap: THREE.ClampToEdgeWrapping }); return { map, emissiveMap: map };
});
export const getTextureSet = getTexture;
export function getTextureStats() { return { canvases, gpuTextures: textures.size, estimatedBytes, timings: { ...timings } }; }
export function disposeAllTextures() {
  for (const texture of textures) texture.dispose();
  textures.clear(); cache.clear(); tiles.clear(); canvases = 0; estimatedBytes = 0;
  for (const key of Object.keys(timings)) delete timings[key];
}
