import axios from 'axios';
import { ethers } from 'ethers';
import { ALL_CHAIN_KEYS } from './chains.js';
import { getChain, getEvmProvider, isSolanaChain, isEvmChain } from './chains.js';

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
async function getDexScreenerMarketData(tokenAddress, chainKey) {
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

// ---------------------------------------------------------------------------
// Uniswap Trading API fallback (EVM chains only) — used when DexScreener has
// no indexed pair yet for a token (common for brand-new pools). Free tier,
// no billing required: https://developers.uniswap.org
//
// We deliberately quote token -> that chain's settlement stablecoin directly
// (instead of routing through a wrapped-native leg) so we never need to know
// a chain's WETH/WBNB address — the API's own router handles pathfinding,
// and this keeps Robinhood Chain (whose wrapped-native address isn't
// published anywhere we can verify) working the same as every other chain.
//
// This is READ-ONLY price discovery. Trade execution still goes through 0x
// (see swap.js) — nothing here signs or sends a transaction.
// ---------------------------------------------------------------------------

const UNISWAP_QUOTE_URL = 'https://trade-api.gateway.uniswap.org/v1/quote';
// Any validly-checksummed address works as `swapper` for a quote-only
// request — no funds move and no signature is requested. Using a
// well-known public address (Uniswap's own docs example) rather than the
// zero address, since some routers special-case/reject 0x000...000.
const QUOTE_ONLY_SWAPPER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const ERC20_META_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
];

async function getUniswapV3MarketData(tokenAddress, chainKey) {
  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) return null;
  if (!isEvmChain(chainKey)) return null;

  const chain = getChain(chainKey);
  const provider = getEvmProvider(chainKey);
  const token = new ethers.Contract(tokenAddress, ERC20_META_ABI, provider);

  const [decimals, symbol, totalSupplyRaw] = await Promise.all([
    token.decimals().catch(() => 18),
    token.symbol().catch(() => '???'),
    token.totalSupply().catch(() => null),
  ]);

  // Quote selling 1 whole token for the chain's stablecoin — gives us a spot
  // price without needing a wrapped-native leg or guessing pool fee tiers
  // (the API's router figures out the best path itself).
  const oneTokenRaw = ethers.parseUnits('1', decimals).toString();

  let res;
  try {
    res = await axios.post(
      UNISWAP_QUOTE_URL,
      {
        type: 'EXACT_INPUT',
        amount: oneTokenRaw,
        tokenInChainId: String(chain.chainId),
        tokenOutChainId: String(chain.chainId),
        tokenIn: ethers.getAddress(tokenAddress),
        tokenOut: ethers.getAddress(chain.usdcAddress),
        swapper: QUOTE_ONLY_SWAPPER,
        routingPreference: 'BEST_PRICE',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-universal-router-version': '2.0',
        },
        timeout: 8000,
      }
    );
  } catch (err) {
    // No route/pool found, or API error — just means this fallback can't
    // help for this token; caller treats it the same as "no market data".
    return null;
  }

  // Response field naming isn't fully documented publicly at time of
  // writing — check a few plausible shapes defensively rather than assume
  // one exact schema.
  const data = res.data;
  const outAmountRaw =
    data?.quote?.output?.amount ??
    data?.output?.amount ??
    data?.quote?.amountOut ??
    data?.amountOut ??
    null;

  if (!outAmountRaw) return null;

  const usdcDecimals = chain.usdcDecimals ?? 6;
  const priceUsd = Number(ethers.formatUnits(outAmountRaw, usdcDecimals));
  if (!priceUsd || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  let marketCap = null;
  if (totalSupplyRaw) {
    const supply = Number(ethers.formatUnits(totalSupplyRaw, decimals));
    if (Number.isFinite(supply) && supply > 0) marketCap = supply * priceUsd;
  }

  return {
    symbol,
    priceUsd,
    marketCap,
    liquidityUsd: null, // not exposed by a quote-only call
    priceChange24h: null, // not exposed by a quote-only call
  };
}

/**
 * Token market data (price, market cap, liquidity) scoped to a specific
 * chain. Tries DexScreener first; on EVM chains, falls back to a live
 * Uniswap Trading API quote if DexScreener has no indexed pair yet (common
 * for brand-new pools) and UNISWAP_API_KEY is set. Solana has no fallback —
 * DexScreener is the only source there.
 */
export async function getTokenMarketData(tokenAddress, chainKey) {
  const dexData = await getDexScreenerMarketData(tokenAddress, chainKey).catch(() => null);
  if (dexData) return dexData;

  if (isSolanaChain(chainKey)) return null;

  return getUniswapV3MarketData(tokenAddress, chainKey).catch(() => null);
}

/**
 * Cross-chain auto-detect: given just a token address/mint (no chain
 * specified — e.g. the user pasted a CA without saying which chain), finds
 * every chain this bot supports where that address has live market data,
 * ranked by liquidity. This is what lets a pasted CA "just work" without the
 * user picking a chain first.
 *
 * NOTE: this stays DexScreener-only (no Uniswap fallback) — the Uniswap
 * fallback needs a specific chain to quote against, so it can't cheaply
 * probe "every chain at once" the way DexScreener's cross-chain search can.
 * The per-chain fallback in getTokenMarketData still applies once a chain
 * is actually selected (see resolveChainForCA in handlers/text.js).
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
