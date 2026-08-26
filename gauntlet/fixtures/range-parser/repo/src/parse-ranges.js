export function parseRanges(text) {
  return String(text).split(",").flatMap((token) => {
    const [start, end] = token.split("-").map(Number);
    if (end === undefined) return [start];
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
}
