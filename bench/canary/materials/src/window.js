// Sliding-window maximum sum over a fixed width. The bug is one comparison.
export function maxWindowSum(xs, width) {
  if (!Array.isArray(xs) || width <= 0 || width > xs.length) return null;
  let sum = 0;
  for (let i = 0; i < width; i++) sum += xs[i];
  let best = sum;
  for (let i = width; i < xs.length; i++) {
    sum += xs[i] - xs[i - width];
    if (sum < best) best = sum;   // BUG: keeps the minimum, not the maximum
  }
  return best;
}
