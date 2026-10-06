/**
 * Coins and prices (SRD "Coins": 1 PP = 10 GP, 1 GP = 2 EP = 10 SP = 100 CP): prices as copper,
 * paying from a purse with change, and coins for an amount.
 */

export const COIN_VALUES = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 } as const;
export type Coin = keyof typeof COIN_VALUES;
export type Purse = Record<Coin, number>;

const ASCENDING: readonly Coin[] = ["cp", "sp", "ep", "gp", "pp"];

/** A price in copper (`1,500 GP` → 150000, `5 SP` → 50), or `null` (`Varies`, empty). */
export function priceInCp(price: string): number | null {
  const m = /^([\d,]+)\s*(CP|SP|EP|GP|PP)$/i.exec(price.trim());
  if (!m) return null;
  return (
    Number((m[1] as string).replace(/,/g, "")) * COIN_VALUES[(m[2] as string).toLowerCase() as Coin]
  );
}

/** A purse's worth in copper. */
export function purseValue(purse: Purse): number {
  return ASCENDING.reduce((sum, c) => sum + purse[c] * COIN_VALUES[c], 0);
}

/** Coins for an amount of copper, the largest coins first (no electrum or platinum). */
export function coinsFor(cp: number): Purse {
  const gp = Math.floor(cp / 100);
  const sp = Math.floor((cp % 100) / 10);
  return { pp: 0, gp, ep: 0, sp, cp: cp % 10 };
}

/**
 * The purse after paying `cost` copper, or `null` when it holds too little: the smallest coins
 * go first, each only while it doesn't overpay; then one larger coin is broken and the change
 * comes back in gold, silver and copper.
 */
export function pay(purse: Purse, cost: number): Purse | null {
  if (cost <= 0) return { ...purse };
  if (purseValue(purse) < cost) return null;
  const left = { ...purse };
  let owed = cost;
  for (const c of ASCENDING) {
    const n = Math.min(left[c], Math.floor(owed / COIN_VALUES[c]));
    left[c] -= n;
    owed -= n * COIN_VALUES[c];
  }
  if (owed > 0) {
    const coin = ASCENDING.find((c) => left[c] > 0 && COIN_VALUES[c] > owed) as Coin;
    left[coin] -= 1;
    const change = coinsFor(COIN_VALUES[coin] - owed);
    for (const c of ASCENDING) left[c] += change[c];
  }
  return left;
}

/** `1 GP 5 SP`: an amount of copper in coins. */
export function formatCp(cp: number): string {
  const coins = coinsFor(cp);
  const parts = (["gp", "sp", "cp"] as const)
    .filter((c) => coins[c])
    .map((c) => `${coins[c]} ${c.toUpperCase()}`);
  return parts.length ? parts.join(" ") : "0 CP";
}
