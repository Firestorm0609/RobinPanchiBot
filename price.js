import axios from 'axios';
import { ALL_CHAIN_KEYS } from './chains.js';

let ethPriceCache = { value: null, ts: 0 };

export async function getEthUsdPrice() {
  if (Date.now() - ethPriceCache.ts < 30_000 && ethPriceCache.value) return ethPriceCache.value;
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: 'ethereum', vs_currencies: 'usd' },
  });
  const price = res.data.ethereum.usd;
  ethPriceCache = { value: price, ts: Date.now() };
  return price;
}

export function getCachedEthUsdPrice() {
  if (Date.now() - ethPriceCache.ts < 30_000) return ethPriceCache.value;
  return null;
}

// DexScreener's chainId slugs for the `chainId` field in its API responses —
// used to confirm a pair result actually belongs to the chain we asked about
// (DexScreener's /tokens/ endpoint searches across ALL chains it indexes).
const DEXSCREENER_CHAIN_SLUG = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  bsc: 'bsc',
  solana: 'solana',
  robinhood: process.env.DEXSCREENER_ROBINHOOD_SLUG || 'robinhoodchain',
};

/**
 * Token market data (price, market cap, liquidity) via DexScreener, scoped
 * to a specific chain. Picks the highest-liquidity pair for the token
 * address ON THAT CHAIN specifically (DexScreener's raw response can include
 * pairs from other chains that happen to share the query, e.g. if the same
 * address string exists on two EVM chains).
 */
export async function getTokenMarketData(tokenAddress, chainKey) {
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
  const allPairs = res.data?.pairs || [];
  const slug = DEXSCREENER_CHAIN_SLUG[chainKey];
  const pairs = slug ? allPairs.filter((p) => p.chainId === slug) : allPairs;
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

/**
 * Cross-chain auto-detect: given just a token address/mint (no chain
 * specified — e.g. the user pasted a CA without saying which chain), finds
 * every chain this bot supports where that address has live market data,
 * ranked by liquidity. This is what lets a pasted CA "just work" without the
 * user picking a chain first.
 *
 * Returns an array of { chainKey, market } sorted by liquidity descending.
 * Empty array if the address has no market data on any supported chain.
 */
export async function findTokenAcrossChains(tokenAddress) {
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`).catch(() => null);
  const allPairs = res?.data?.pairs || [];
  if (allPairs.length === 0) return [];

  const bestPerChain = new Map(); // chainKey -> best pair
  for (const pair of allPairs) {
    const chainKey = ALL_CHAIN_KEYS.find((k) => DEXSCREENER_CHAIN_SLUG[k] === pair.chainId);
    if (!chainKey) continue; // a chain DexScreener indexes but we don't support
    const current = bestPerChain.get(chainKey);
    if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) {
      bestPerChain.set(chainKey, pair);
    }
  }

  const results = [...bestPerChain.entries()].map(([chainKey, best]) => ({
    chainKey,
    market: {
      symbol: best.baseToken?.symbol ?? '???',
      priceUsd: parseFloat(best.priceUsd ?? '0'),
      marketCap: best.marketCap ?? best.fdv ?? null,
      liquidityUsd: best.liquidity?.usd ?? null,
      priceChange24h: best.priceChange?.h24 ?? null,
    },
  }));

  results.sort((a, b) => (b.market.liquidityUsd ?? 0) - (a.market.liquidityUsd ?? 0));
  return results;
}

export function fmtUsd(n) {
  if (n === null || n === undefined) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtTokenAmount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (abs >= 1) return n.toFixed(4);
  return n.toFixed(6);
}
