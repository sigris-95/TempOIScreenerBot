export function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

export function pctChange(a: number, b: number) {
  if (Math.abs(a) < 1e-12) return 0;
  return (b - a) / Math.abs(a);
}

export function stddev(arr: number[]) {
  if (!arr.length) return 0;
  const m = arr.reduce((s, n) => s + n, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, n) => s + (n - m) * (n - m), 0) / arr.length);
}
