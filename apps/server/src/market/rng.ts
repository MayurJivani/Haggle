/** mulberry32: tiny, fast, good enough for a game market. Same seed, same sequence, on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller, clamped to +-3 sigma so one draw can never run away. */
export function gauss(next: () => number): number {
  const u = 1 - next();
  const v = next();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-3, Math.min(3, z));
}

export const between = (next: () => number, min: number, max: number) => min + (max - min) * next();
