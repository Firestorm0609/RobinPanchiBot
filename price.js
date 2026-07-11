import axios from 'axios';

let ethPriceCache = { value: null, ts: 0 };

/** ETH/USD price, cached 30s to avoid rate limits. */
export async function getEthUsdPrice() {
  if (Date.now() - ethPriceCache.ts < 30_000 && ethPriceCache.value) return ethPriceCache.value;
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: 'ethereum', vs_currencies: 'usd' },
  });
  const price = res.data.ethereum.usd;
  ethPriceCache = { value: price, ts: Date.now() };
  return price;
}

/**
 * Synchronous, non-blocking read of the cached ETH/USD price — for places
 * (like sync menu builders) that want to show a USD label but can't await.
 * Returns null if there's no fresh (<30s) cached price yet.
 */
export function getCachedEthUsdPrice() {
  if (Date.now() - ethPriceCache.ts < 30_000) return ethPriceCache.value;
  return null;
}

/**
 * Token market data (price, market cap, liquidity) via DexScreener.
 * Picks the highest-liquidity pair for the token address.
 */
export async function getTokenMarketData(tokenAddress) {
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
  const pairs = res.data?.pairs || [];
  if (pairs.length === 0) return null;

  const best = pairs.reduce((a, b) => (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a);
  return {
    symbol: best.baseToken?.symbol ?? '???',
    priceUsd: parseFloat(best.priceUsd ?? '0'),
    marketCap: best.marketCap ?? best.fdv ?? null,
    liquidityUsd: best.liquidity?.usd ?? null,
    priceChange24h: best.priceChange?.h24 ?? null,
  };
}

export function fmtUsd(n) {
  if (n === null || n === undefined) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * Formats a raw token amount (e.g. from a memecoin balance/position) using
 * K/M/B shorthand once it gets large — mirrors fmtUsd's style. A bare
 * `.toFixed(4)` on something like 10,604,832 tokens is unreadable; this
 * shows "10.60M" instead.
 *
 * Small amounts (<1000) still show with enough precision to be meaningful
 * for low-decimal or low-supply tokens.
 */
export function fmtTokenAmount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (abs >= 1) return n.toFixed(4);
  return n.toFixed(6);
}
