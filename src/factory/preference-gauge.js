// Palette preference gauge. When the material is one user's rating history of
// color palettes and the question asks which of two new palettes they would
// rate higher, the model is at chance: it cannot do color math on hex codes.
// This gauge computes perceptual features for every palette (CIELAB
// lightness, chroma, hue spread, warmth, contrast), fits the user's own
// history five different ways, and releases an answer only when all five
// agree. It uses nothing but that row's history.
//
// Offline on the Decision Index cfcolor rows (the model answering whenever the
// five disagree): dev 81.5% vs the model's 70.4% (the rule was chosen here),
// test 67.8% vs 55.9%.

const HEX = /^#?[0-9a-f]{6}$/i;

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function rgbToLab(rgb) {
  const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047;
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));

/** Twenty perceptual features of a five-color palette. */
export function paletteFeatures(colors) {
  const rgb = colors.map(hexToRgb);
  const lab = rgb.map(rgbToLab);
  const L = lab.map((c) => c[0]);
  const A = lab.map((c) => c[1]);
  const B = lab.map((c) => c[2]);
  const C = lab.map((c) => Math.hypot(c[1], c[2]));
  const H = lab.map((c) => Math.atan2(c[2], c[1]));
  const sat = rgb.map((c) => { const mx = Math.max(...c); return mx === 0 ? 0 : (mx - Math.min(...c)) / mx; });
  const val = rgb.map((c) => Math.max(...c));
  const total = C.reduce((a, b) => a + b, 0) + 1e-9;
  const hueSin = C.reduce((s, c, i) => s + (c / total) * Math.sin(H[i]), 0);
  const hueCos = C.reduce((s, c, i) => s + (c / total) * Math.cos(H[i]), 0);
  const pairs = [];
  for (let i = 0; i < lab.length; i += 1) for (let j = i + 1; j < lab.length; j += 1) pairs.push(dist(lab[i], lab[j]));
  const adjacent = lab.slice(1).map((c, i) => dist(lab[i], c));
  const chromaticHues = H.filter((_, i) => C[i] > 12);
  const hueSpread = chromaticHues.length > 1 ? 1 - Math.hypot(mean(chromaticHues.map(Math.sin)), mean(chromaticHues.map(Math.cos))) : 0;
  return [
    mean(L), std(L), Math.max(...L) - Math.min(...L), Math.min(...L), Math.max(...L),
    mean(C), std(C), Math.max(...C),
    mean(sat), mean(val),
    hueSin, hueCos, hueSpread,
    mean(A.map((a, i) => (a + B[i] > 0 && C[i] > 10 ? 1 : 0))), mean(C.map((c) => (c > 12 ? 1 : 0))),
    mean(pairs), Math.min(...pairs), mean(adjacent),
    mean(A), mean(B),
  ];
}

// Solve (M) w = b by Gaussian elimination with partial pivoting.
function solve(M, b) {
  const n = b.length;
  const a = M.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = c + 1; r < n; r += 1) {
      const k = a[r][c] / a[c][c];
      for (let j = c; j <= n; j += 1) a[r][j] -= k * a[c][j];
    }
  }
  const w = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = a[r][n];
    for (let j = r + 1; j < n; j += 1) s -= a[r][j] * w[j];
    w[r] = s / a[r][r];
  }
  return w;
}

/**
 * Score A against B five ways from the user's history (positive favours A):
 * nearest rated palettes, kernel-weighted ratings, a ridge fit, the features
 * most correlated with the ratings, and closeness to the user's top- versus
 * bottom-rated palettes. Features are standardised over the row.
 */
export function palettePreferenceScores(history, a, b) {
  const F = [...history.map((h) => paletteFeatures(h.colors)), paletteFeatures(a), paletteFeatures(b)];
  const cols = F[0].length;
  const mu = Array.from({ length: cols }, (_, j) => mean(F.map((f) => f[j])));
  const sd = Array.from({ length: cols }, (_, j) => std(F.map((f) => f[j])) + 1e-6);
  const Z = F.map((f) => f.map((v, j) => (v - mu[j]) / sd[j]));
  const Zh = Z.slice(0, history.length);
  const [za, zb] = Z.slice(history.length);
  const y = history.map((h) => Number(h.rating));
  const yMean = mean(y);
  const yc = y.map((v) => v - yMean);

  const knn = (z, k = 5) => {
    const idx = Zh.map((row, i) => [dist(row, z), i]).sort((p, q) => p[0] - q[0]).slice(0, k);
    const w = idx.map(([d]) => 1 / (d + 1e-3));
    return idx.reduce((s, [, i], n) => s + w[n] * y[i], 0) / w.reduce((s, v) => s + v, 0);
  };
  const kernel = (z, bw = 1.5) => {
    const w = Zh.map((row) => Math.exp(-(((dist(row, z) / Math.sqrt(cols)) / bw) ** 2)));
    return w.reduce((s, v, i) => s + v * yc[i], 0) / (w.reduce((s, v) => s + v, 0) + 1e-9);
  };
  const ridge = (lambda = 30) => {
    const XtX = Array.from({ length: cols }, (_, i) => Array.from({ length: cols }, (_, j) => Zh.reduce((s, row) => s + row[i] * row[j], 0) + (i === j ? lambda : 0)));
    const Xty = Array.from({ length: cols }, (_, i) => Zh.reduce((s, row, n) => s + row[i] * yc[n], 0));
    const w = solve(XtX, Xty);
    return w.reduce((s, v, j) => s + v * (za[j] - zb[j]), 0);
  };
  const correlated = (top = 3) => {
    if (std(y) === 0) return 0;
    const r = Array.from({ length: cols }, (_, j) => {
      const x = Zh.map((row) => row[j]);
      if (std(x) <= 1e-6) return 0;
      const mx = mean(x);
      const cov = mean(x.map((v, i) => (v - mx) * (y[i] - yMean)));
      return cov / (std(x) * std(y)) || 0;
    });
    return [...r.keys()].sort((p, q) => Math.abs(r[q]) - Math.abs(r[p])).slice(0, top).reduce((s, j) => s + (za[j] - zb[j]) * r[j], 0);
  };
  const topBottom = () => {
    const hi = Math.max(...y);
    const lo = Math.min(...y);
    if (hi === lo) return 0;
    const tops = Zh.filter((_, i) => y[i] === hi);
    const bottoms = Zh.filter((_, i) => y[i] === lo);
    const lean = (z) => mean(bottoms.map((row) => dist(row, z))) - mean(tops.map((row) => dist(row, z)));
    return lean(za) - lean(zb);
  };
  return [knn(za) - knn(zb), kernel(za) - kernel(zb), ridge(), correlated(), topBottom()];
}

/**
 * Does this question pick between two palettes given a rated palette history
 * in the material? Returns `{ history, keys }` or null.
 */
export function findPalettePreference(state, question) {
  const history = state && typeof state === "object" ? state.history : null;
  const palette = (value) => Array.isArray(value) && value.length >= 2 && value.every((c) => typeof c === "string" && HEX.test(c));
  if (!Array.isArray(history) || history.length < 3) return null;
  if (!history.every((h) => h && palette(h.colors) && Number.isFinite(Number(h.rating)))) return null;
  const entries = Object.entries(question?.criteria ?? {});
  if (question?.type !== "choice" || entries.length !== 2 || !entries.every(([, value]) => palette(value))) return null;
  return { history, keys: entries.map(([key]) => key), palettes: entries.map(([, value]) => value) };
}

/**
 * The gauge's decision for one question: the preferred option key when all
 * five fits agree, else null (the model decides).
 */
export function palettePreferenceChoice(state, question) {
  const found = findPalettePreference(state, question);
  if (!found) return { applies: false, key: null };
  const scores = palettePreferenceScores(found.history, found.palettes[0], found.palettes[1]);
  const vote = scores.reduce((s, v) => s + Math.sign(v), 0);
  const key = Math.abs(vote) === scores.length ? found.keys[vote > 0 ? 0 : 1] : null;
  return { applies: true, key, scores };
}
