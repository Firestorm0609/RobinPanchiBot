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

// Same base58 sanity check used elsewhere (config.js's SOLANA_ADDRESS_REGEX)
// — duplicated here (not imported) to keep price.js dependency-free of
// config.js and avoid a circular import risk. Kept in sync manually; if you
// change one, change both.
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
// pump.fun (primary source for Solana) — covers both pre-graduation bonding
// curve tokens and post-graduation PumpSwap AMM pools via the same endpoint.
// This is an UNOFFICIAL, undocumented endpoint (no published docs, no SLA,
// no auth currently required) — confirmed working manually, but there's no
// guarantee it stays free/unauthenticated/stable. If it starts returning
// 401/403/empty, this function just fails closed and the caller falls back
// to DexScreener automatically — no other code needs to change.
//
// IMPORTANT: the endpoint does NOT reliably reject malformed/non-Solana
// input (observed returning an unrelated match for a plain EVM 0x address)
// — so every caller MUST validate the address looks like a real Solana
// mint (base58, no 0/O/I/l) before calling this, which is why this function
// checks SOLANA_ADDRESS_REGEX itself rather than trusting callers.
// ---------------------------------------------------------------------------

const PUMPFUN_COIN_URL = 'https://frontend-api-v3.pump.fun/coins';

async function getPumpFunMarketData(mintAddress) {
  if (!SOLANA_ADDRESS_REGEX.test(mintAddress)) return null;

  let res;
  try {
    res = await axios.get(`${PUMPFUN_COIN_URL}/${mintAddress}`, { timeout: 8000 });
  } catch {
    return null;
  }

  const d = res.data;
  if (!d || d.is_banned) return null;

  // Defense in depth: confirm the response actually echoes back the mint we
  // asked for, in case the endpoint ever does fuzzy/partial matching again.
  if (d.mint && d.mint !== mintAddress) return null;

  const decimals = d.base_decimals ?? 6;
  const totalSupply = Number(d.total_supply_str ?? d.total_supply ?? 0) / 10 ** decimals;
  const marketCap = typeof d.usd_market_cap === 'number' ? d.usd_market_cap : null;
  if (marketCap === null || !totalSupply) return null;

  const priceUsd = marketCap / totalSupply;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  return {
    symbol: d.symbol ?? '???',
    priceUsd,
    marketCap,
    // pump.fun's coin endpoint doesn't return a liquidity-in-USD figure
    // directly (it exposes raw bonding-curve/pool reserves instead, which
    // aren't directly comparable to DexScreener's liquidity figure) —
    // leave null rather than report a misleading number.
    liquidityUsd: null,
    priceChange24h: null,
  };
}

// ---------------------------------------------------------------------------
// Uniswap Trading API fallback (EVM chains only) — used when DexScreener has
// no indexed pair yet for a token (common for brand-new pools). Free tier,
// no billing required: https://developers.uniswap.org
//
// We deliberately quote token -> that chain's settlement stablecoin directly
// (instead of routing through a wrapped-native leg) so we never need to know
// a chain's WETH/WBNB address — the API's own router handles pathfinding.
//
// This is READ-ONLY price discovery. Trade execution still goes through 0x
// (see swap.js) — nothing here signs or sends a transaction. Note: this
// fallback only sees pools indexed by Uniswap's own router — it can't see
// pools deployed through a different factory (e.g. a third-party launchpad
// running its own Uniswap-V3-compatible factory).
// ---------------------------------------------------------------------------

const UNISWAP_QUOTE_URL = 'https://trade-api.gateway.uniswap.org/v1/quote';
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
  } catch {
    return null;
  }

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
    liquidityUsd: null,
    priceChange24h: null,
  };
}

/**
 * Token market data (price, market cap, liquidity) scoped to a specific
 * chain.
 *
 * Solana: pump.fun is tried FIRST (fast, covers bonding-curve + PumpSwap
 * tokens DexScreener often hasn't indexed yet), falling back to DexScreener
 * if pump.fun has no data (e.g. a Solana token not launched via pump.fun at
 * all, like a plain Raydium/Orca listing).
 *
 * EVM chains: DexScreener first, falling back to a live Uniswap Trading API
 * quote if DexScreener has no indexed pair and UNISWAP_API_KEY is set.
 */
export async function getTokenMarketData(tokenAddress, chainKey) {
  if (isSolanaChain(chainKey)) {
    const pumpData = await getPumpFunMarketData(tokenAddress).catch(() => null);
    if (pumpData) return pumpData;
    return getDexScreenerMarketData(tokenAddress, chainKey).catch(() => null);
  }

  const dexData = await getDexScreenerMarketData(tokenAddress, chainKey).catch(() => null);
  if (dexData) return dexData;

  return getUniswapV3MarketData(tokenAddress, chainKey).catch(() => null);
}

/**
 * Cross-chain auto-detect: given just a token address/mint (no chain
 * specified), finds every chain this bot supports where that address has
 * live market data, ranked by liquidity. This is what lets a pasted CA
 * "just work" without the user picking a chain first.
 *
 * pump.fun is only consulted when `tokenAddress` actually looks like a
 * Solana mint (base58, 32-44 chars) — an EVM 0x... address is never passed
 * to it. This matters because pump.fun's endpoint has been observed
 * returning an unrelated match for malformed/non-Solana input rather than a
 * clean 404, which previously caused plain EVM tokens to get mislabeled as
 * Solana. Uniswap's per-chain fallback is NOT used here — it needs one
 * specific chain to quote against, so it can't cheaply probe "every EVM
 * chain at once" the way DexScreener's cross-chain search can. That
 * fallback still applies once a chain is actually selected (see
 * resolveChainForCA in handlers/text.js, which calls getTokenMarketData
 * directly for the active chain when this function comes up empty).
 *
 * Returns an array of { chainKey, market } sorted by liquidity descending.
 * Empty array if the address has no market data on any supported chain.
 */
export async function findTokenAcrossChains(tokenAddress) {
  const looksLikeSolanaMint = SOLANA_ADDRESS_REGEX.test(tokenAddress);

  const [dexRes, pumpMarket] = await Promise.all([
    axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`).catch(() => null),
    looksLikeSolanaMint ? getPumpFunMarketData(tokenAddress).catch(() => null) : Promise.resolve(null),
  ]);

  const allPairs = dexRes?.data?.pairs || [];
  const bestPerChain = new Map(); // chainKey -> best pair
  for (const pair of allPairs) {
    const chainKey = ALL_CHAIN_KEYS.find((k) => DEXSCREENER_CHAIN_SLUG[k] === pair.chainId);
    if (!chainKey) continue;
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

  // If pump.fun found data for Solana and DexScreener's Solana entry is
  // missing or has no liquidity figure, prefer/patch in the pump.fun result
  // so the auto-detect list doesn't miss a token DexScreener hasn't indexed.
  if (pumpMarket) {
    const existingIdx = results.findIndex((r) => r.chainKey === 'solana');
    if (existingIdx === -1) {
      results.push({ chainKey: 'solana', market: pumpMarket });
    } else if (results[existingIdx].market.liquidityUsd == null) {
      results[existingIdx] = { chainKey: 'solana', market: pumpMarket };
    }
  }

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
