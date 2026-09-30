/**
 * Money is ALWAYS stored as an integer number of poisha (1 taka = 100 poisha).
 * Floating-point taka (0.1 + 0.2 !== 0.3) would drift when fees are added up
 * across thousands of bills; integers never do. Convert only at the edges.
 */
export const POISHA_PER_TAKA = 100;

export const takaToPoisha = (taka: number): number => Math.round(taka * POISHA_PER_TAKA);

export const poishaToTaka = (poisha: number): number => poisha / POISHA_PER_TAKA;

/** 50000 → "৳500", 50050 → "৳500.50" (for logs, AI replies and printed text) */
export const formatTaka = (poisha: number): string => {
  const taka = poishaToTaka(poisha);
  return `৳${taka.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(taka) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
