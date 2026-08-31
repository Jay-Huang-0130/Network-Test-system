function finite(values) {
  return values.filter((value) => value !== null && value !== undefined && value !== '').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

function percentile(values, p) {
  const sorted = finite(values);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower + 1] === undefined ? sorted[lower] : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

function summarize(values) {
  const sorted = finite(values);
  if (!sorted.length) return { count: 0, min: null, avg: null, p95: null, p99: null, max: null };
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { count: sorted.length, min: sorted[0], avg, p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.at(-1) };
}

module.exports = { percentile, summarize };
