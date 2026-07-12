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

// Generic native-gas-token USD price (ETH for most chains, BNB for BSC) —
// used to convert a token->WETH/WBNB quote into a USD price when a chain's
// pools are paired with the wrapped native token rather than the
// stablecoin directly (common for brand-new/launchpad tokens — see
// getUniswapV3MarketData below).
const NATIVE_COINGECKO_ID = { ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana' };
const nativePriceCache = new Map(); // symbol -> { value, ts }

async function getNativeUsdPrice(nativeSymbol) {
  const cached = nativePriceCache.get(nativeSymbol);
  if (cached && Date.now() - cached.ts < 30_000) return cached.value;

  const coingeckoId = NATIVE_COINGECKO_ID[nativeSymbol];
  if (!coingeckoId) return null;

  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: coingeckoId, vs_currencies: 'usd' },
  });
  const price = res.data?.[coingeckoId]?.usd ?? null;
  if (price) nativePriceCache.set(nativeSymbol, { value: price, ts: Date.now() });
  return price;
}

// Wrapped-native token address per EVM chain — needed only for the
// token->WETH fallback leg below (never used for trade execution, which
// stays on 0x/swap.js). ethereum/base/arbitrum/bsc addresses are the
// long-standing canonical deployments; robinhood's was confirmed live
// against an indexed Uniswap V3 pair (chain launched July 2026).
const WRAPPED_NATIVE_ADDRESS = {
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  robinhood: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
};

// DexScreener's chainId slugs for the `chainId` field in its API responses —
// used to confirm a pair result actually belongs to the chain we asked about
// (DexScreener's /tokens/ endpoint searches across ALL chains it indexes).
const DEXSCREENER_CHAIN_SLUG = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  bsc: 'bsc',
  solana: 'solana',
  robinhood: process.env.DEXSCREENER_ROBINHOOD_SLUG || 'robinhood',
};

// ---------------------------------------------------------------------------
// DEBUG: set PRICE_DEBUG=1 in .env to log each price-resolution step (which
// source was tried, what it returned/why it was skipped). Off by default —
// this is diagnostic only, not meant to run in normal production logging.
// ---------------------------------------------------------------------------
const DEBUG = process.env.PRICE_DEBUG === '1';
function dbg(...args) {
  if (DEBUG) console.log('[price debug]', ...args);
}

async function getDexScreenerMarketData(tokenAddress, chainKey) {
  const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
  const allPairs = res.data?.pairs || [];
  const slug = DEXSCREENER_CHAIN_SLUG[chainKey];
  const pairs = slug ? allPairs.filter((p) => p.chainId === slug) : allPairs;

  dbg('DexScreener', {
    tokenAddress,
    chainKey,
    expectedSlug: slug,
    totalPairsReturned: allPairs.length,
    distinctChainIdsSeen: [...new Set(allPairs.map((p) => p.chainId))],
    pairsMatchingSlug: pairs.length,
  });

  if (pairs.length === 0) {
    if (allPairs.length > 0) {
      dbg('DexScreener: pairs exist for this token but NONE matched expectedSlug — likely DEXSCREENER_ROBINHOOD_SLUG (or equivalent) is wrong. Compare against distinctChainIdsSeen above.');
    } else {
      dbg('DexScreener: no pairs at all for this token address (not indexed, or wrong address).');
    }
    return null;
  }

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

const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUMPFUN_COIN_URL = 'https://frontend-api-v3.pump.fun/coins';

async function getPumpFunMarketData(mintAddress) {
  if (!SOLANA_ADDRESS_REGEX.test(mintAddress)) return null;

  let res;
  try {
    res = await axios.get(`${PUMPFUN_COIN_URL}/${mintAddress}`, { timeout: 8000 });
  } catch (err) {
    dbg('pump.fun: request failed', err.message);
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

  // pump.fun's coin endpoint doesn't return a liquidity-in-USD figure
  // directly — it exposes raw bonding-curve/pool reserves instead
  // (virtual_sol_reserves / real_sol_reserves, in lamports). We approximate
  // USD liquidity as 2x the SOL-side reserve (SOL side + equivalent token
  // side) converted at the live SOL/USD price. This is an ESTIMATE, not an
  // indexed figure like DexScreener's — prefer real_sol_reserves (actual
  // pool reserves) over virtual_sol_reserves (bonding-curve virtual
  // reserves used for pricing) when both are present, since it's closer to
  // what's actually withdrawable liquidity.
  let liquidityUsd = null;
  const lamportReserves = d.real_sol_reserves ?? d.virtual_sol_reserves ?? null;
  if (lamportReserves != null) {
    const solReserve = Number(lamportReserves) / 1e9; // lamports -> SOL
    if (Number.isFinite(solReserve) && solReserve > 0) {
      const solUsd = await getNativeUsdPrice('SOL').catch(() => null);
      if (solUsd) {
        const candidate = solReserve * 2 * solUsd;
        if (Number.isFinite(candidate) && candidate > 0) liquidityUsd = candidate;
      }
    }
  }

  return {
    symbol: d.symbol ?? '???',
    priceUsd,
    marketCap,
    liquidityUsd,
    priceChange24h: null,
  };
}

// ---------------------------------------------------------------------------
// Uniswap Trading API fallback (EVM chains only) — used when DexScreener has
// no indexed pair yet for a token (common for brand-new pools, e.g. tokens
// launched via a launchpad like NOXA Fun on Robinhood Chain that deploy
// straight onto canonical Uniswap V3 but pair with WETH, not the chain's
// stablecoin). Free tier, no billing required: developers.uniswap.org
//
// Two attempts, in order:
//   1. token -> chain's stablecoin directly (works when a deep direct pool
//      exists, common on established chains like Ethereum/Base/Arbitrum).
//   2. token -> wrapped native (WETH/WBNB), then convert to USD using a
//      live native-token price. This is the path that actually covers
//      NOXA Fun-style launches, which pair exclusively with WETH.
//
// This is READ-ONLY price discovery. Trade execution still goes through 0x
// (see swap.js) — nothing here signs or sends a transaction. Note: this
// fallback only sees pools indexed by Uniswap's own router — it still can't
// see pools deployed through a genuinely separate (non-Uniswap) factory.
// ---------------------------------------------------------------------------

const UNISWAP_QUOTE_URL = 'https://trade-api.gateway.uniswap.org/v1/quote';
const QUOTE_ONLY_SWAPPER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const ERC20_META_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
];

async function fetchUniswapQuote({ chain, tokenIn, tokenOut, amountRaw, apiKey }) {
  try {
    const res = await axios.post(
      UNISWAP_QUOTE_URL,
      {
        type: 'EXACT_INPUT',
        amount: amountRaw,
        tokenInChainId: String(chain.chainId),
        tokenOutChainId: String(chain.chainId),
        tokenIn: ethers.getAddress(tokenIn),
        tokenOut: ethers.getAddress(tokenOut),
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
    const data = res.data;
    const amountOut =
      data?.quote?.output?.amount ??
      data?.output?.amount ??
      data?.quote?.amountOut ??
      data?.amountOut ??
      null;

    dbg('Uniswap quote OK', { tokenIn, tokenOut, amountOut });
    return amountOut;
  } catch (err) {
    dbg('Uniswap quote FAILED', {
      tokenIn,
      tokenOut,
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    return null;
  }
}

async function getUniswapV3MarketData(tokenAddress, chainKey) {
  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) {
    dbg('Uniswap fallback SKIPPED: UNISWAP_API_KEY not set in .env');
    return null;
  }
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
  let priceUsd = null;

  // Attempt 1: direct token -> stablecoin quote.
  const usdcOutRaw = await fetchUniswapQuote({
    chain, tokenIn: tokenAddress, tokenOut: chain.usdcAddress, amountRaw: oneTokenRaw, apiKey,
  });
  if (usdcOutRaw) {
    const usdcDecimals = chain.usdcDecimals ?? 6;
    const candidate = Number(ethers.formatUnits(usdcOutRaw, usdcDecimals));
    if (Number.isFinite(candidate) && candidate > 0) priceUsd = candidate;
  } else {
    dbg('Uniswap attempt 1 (token -> stablecoin) returned nothing, trying WETH leg next');
  }

  // Attempt 2: token -> wrapped native, converted via live native USD price.
  if (priceUsd === null) {
    const wrappedNative = WRAPPED_NATIVE_ADDRESS[chainKey];
    if (!wrappedNative) {
      dbg('Uniswap attempt 2 SKIPPED: no WRAPPED_NATIVE_ADDRESS entry for chain', chainKey);
    } else {
      const wethOutRaw = await fetchUniswapQuote({
        chain, tokenIn: tokenAddress, tokenOut: wrappedNative, amountRaw: oneTokenRaw, apiKey,
      });
      if (wethOutRaw) {
        const nativeUsd = await getNativeUsdPrice(chain.nativeSymbol).catch(() => null);
        dbg('Uniswap attempt 2: got WETH-leg quote, native USD price =', nativeUsd);
        if (nativeUsd) {
          const wethAmount = Number(ethers.formatUnits(wethOutRaw, 18)); // WETH/WBNB are always 18 decimals
          const candidate = wethAmount * nativeUsd;
          if (Number.isFinite(candidate) && candidate > 0) priceUsd = candidate;
        }
      } else {
        dbg('Uniswap attempt 2 (token -> WETH) also returned nothing — no route exists via canonical Uniswap V3 for this token/chain, or the pool fee tier isn\'t one the API routes through.');
      }
    }
  }

  if (priceUsd === null) {
    dbg('Uniswap fallback: no price resolved after both attempts.');
    return null;
  }

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
 * chain.
 *
 * Solana: pump.fun is tried FIRST (fast, covers bonding-curve + PumpSwap
 * tokens DexScreener often hasn't indexed yet), falling back to DexScreener
 * if pump.fun has no data (e.g. a Solana token not launched via pump.fun at
 * all, like a plain Raydium/Orca listing).
 *
 * EVM chains: DexScreener first, falling back to a live Uniswap Trading API
 * quote (token->stablecoin, then token->wrapped-native) if DexScreener has
 * no indexed pair and UNISWAP_API_KEY is set.
 */
export async function getTokenMarketData(tokenAddress, chainKey) {
  dbg('getTokenMarketData start', { tokenAddress, chainKey });

  if (isSolanaChain(chainKey)) {
    const pumpData = await getPumpFunMarketData(tokenAddress).catch(() => null);
    if (pumpData) {
      dbg('resolved via pump.fun');
      return pumpData;
    }
    const dex = await getDexScreenerMarketData(tokenAddress, chainKey).catch(() => null);
    dbg(dex ? 'resolved via DexScreener (Solana)' : 'no data found (Solana): pump.fun and DexScreener both empty');
    return dex;
  }

  const dexData = await getDexScreenerMarketData(tokenAddress, chainKey).catch(() => null);
  if (dexData) {
    dbg('resolved via DexScreener');
    return dexData;
  }

  const uniData = await getUniswapV3MarketData(tokenAddress, chainKey).catch((err) => {
    dbg('Uniswap fallback threw an error:', err.message);
    return null;
  });
  dbg(uniData ? 'resolved via Uniswap fallback' : 'no data found: DexScreener and Uniswap fallback both empty');
  return uniData;
}

/**
 * Cross-chain auto-detect: given just a token address/mint (no chain
 * specified), finds every chain this bot supports where that address has
 * live market data, ranked by liquidity. This is what lets a pasted CA
 * "just work" without the user picking a chain first.
 *
 * pump.fun is only consulted when `tokenAddress` actually looks like a
 * Solana mint (base58, 32-44 chars) — an EVM 0x... address is never passed
 * to it. Uniswap's per-chain fallback is NOT used here — it needs one
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
