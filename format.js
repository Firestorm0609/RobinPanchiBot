import { ethers } from 'ethers';
import { getQuote } from './swap.js';
import { fmtUsd } from './price.js';
import { getChain, getEvmProvider, explorerTxUrl, isSolanaChain, isEvmChain, ALL_CHAIN_KEYS, getStableDecimals, stableSymbolFor } from './chains.js';
import { getSolBalance, getSolanaUsdcBalance } from './solana.js';
import { getUsdcBalance } from './erc20.js';
import { gasMultiplierFor, botIdentity } from './state.js';
import { QUOTE_STALE_MS } from './config.js';

// DEBUG: set PRICE_DEBUG=1 in .env (same flag used in price.js) to log
// balance-lookup failures here too.
const DEBUG = process.env.PRICE_DEBUG === '1';
function dbg(...args) {
  if (DEBUG) console.log('[format debug]', ...args);
}

export function fmtEth(n) {
  return Number(n).toFixed(4);
}

export { explorerTxUrl };

export function referralLink(code) {
  return `https://t.me/${botIdentity.username || 'your_bot'}?start=ref_${code}`;
}

/**
 * Native gas balance + settlement-stablecoin balance on ONE chain for a
 * wallet — the unit shown to the user before/while trading on that chain
 * specifically. `wallet` must have both .address (EVM) and .solAddress
 * (Solana). The stablecoin label is per-chain (USDC everywhere except
 * Robinhood Chain, which shows USDG) via stableSymbolFor().
 */
export async function chainBalanceLines(wallet, chainKey) {
  const chain = getChain(chainKey);
  const symbol = stableSymbolFor(chainKey);

  if (isSolanaChain(chainKey)) {
    const [sol, usdc] = await Promise.all([
      getSolBalance(wallet.solAddress).catch((err) => { dbg('getSolBalance failed', { solAddress: wallet.solAddress, message: err.message, stack: err.stack }); return null; }),
      getSolanaUsdcBalance(wallet.solAddress).catch((err) => { dbg('getSolanaUsdcBalance failed', { solAddress: wallet.solAddress, message: err.message, stack: err.stack }); return null; }),
    ]);
    dbg('Solana balance result', { solAddress: wallet.solAddress, sol, usdc, rpcUrl: process.env.SOLANA_RPC_URL ? '(set)' : '(NOT SET — using public fallback)' });
    const solLine = sol === null ? 'SOL: unavailable' : `SOL: ${sol.toFixed(4)}`;
    const usdcLine = usdc === null ? `${symbol}: unavailable` : `${symbol}: ${fmtUsd(usdc)}`;
    return `${solLine}\n${usdcLine}`;
  }

  const provider = getEvmProvider(chainKey);
  const [native, decimals, usdcRaw] = await Promise.all([
    provider.getBalance(wallet.address).then((b) => Number(ethers.formatEther(b))).catch(() => null),
    getStableDecimals(chainKey).catch(() => 6),
    getUsdcBalance(provider, chain.usdcAddress, wallet.address).catch(() => null),
  ]);
  const nativeLine = native === null ? `${chain.nativeSymbol}: unavailable` : `${chain.nativeSymbol}: ${fmtEth(native)}`;
  const usdcLine = usdcRaw === null ? `${symbol}: unavailable` : `${symbol}: ${fmtUsd(Number(ethers.formatUnits(usdcRaw, decimals)))}`;
  return `${nativeLine}\n${usdcLine}`;
}

/** Stablecoin balance only, on one chain — the number that actually matters for sizing a trade. */
export async function getChainUsdcBalance(wallet, chainKey) {
  if (isSolanaChain(chainKey)) {
    return getSolanaUsdcBalance(wallet.solAddress);
  }
  const chain = getChain(chainKey);
  const provider = getEvmProvider(chainKey);
  const decimals = await getStableDecimals(chainKey);
  const raw = await getUsdcBalance(provider, chain.usdcAddress, wallet.address);
  return Number(ethers.formatUnits(raw, decimals));
}

/** Summary line across every supported chain — used on the Balance / Wallets views. Each chain shows its own stablecoin symbol. */
export async function allChainsBalanceSummary(wallet) {
  const lines = await Promise.all(
    ALL_CHAIN_KEYS.map(async (chainKey) => {
      const chain = getChain(chainKey);
      const symbol = stableSymbolFor(chainKey);
      try {
        const usdc = await getChainUsdcBalance(wallet, chainKey);
        return `${chain.name}: ${fmtUsd(usdc)} ${symbol}`;
      } catch {
        return `${chain.name}: unavailable`;
      }
    })
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Unified balance (Phase 3 of CROSSCHAIN_BUILD_PLAN.md) — "FOMO-style" single
// USD number across every chain. This is a DISPLAY-ONLY snapshot sum: each
// chain's stablecoin balance is fetched live (same calls as
// allChainsBalanceSummary) and added together. It is NOT an atomic or
// spendable balance — chains can't be pooled without actually bridging
// (that's Phase 4's job), so this number can be higher than what's usable
// on any single chain if funds are spread out. Every chain's settlement
// stablecoin (USDC, or USDG on Robinhood) is ~1:1 USD-pegged, so summing
// raw balances across chains is a reasonable USD total without needing a
// price feed.
// ---------------------------------------------------------------------------

/**
 * Returns { totalUsd, chains, anyUnavailable }.
 * `chains` is every supported chain's stablecoin balance, in ALL_CHAIN_KEYS
 * order, always present (0 or the fetched value) — a chain that errored out
 * has `usd: null` and doesn't contribute to totalUsd, but still gets a row
 * so the per-chain breakdown doesn't silently drop it.
 */
export async function getUnifiedUsdBalance(wallet) {
  const results = await Promise.all(
    ALL_CHAIN_KEYS.map(async (chainKey) => {
      const chain = getChain(chainKey);
      const symbol = stableSymbolFor(chainKey);
      try {
        const usd = await getChainUsdcBalance(wallet, chainKey);
        return { chainKey, name: chain.name, symbol, usd };
      } catch (err) {
        dbg('getUnifiedUsdBalance: chain failed', { chainKey, message: err.message });
        return { chainKey, name: chain.name, symbol, usd: null };
      }
    })
  );

  const totalUsd = results.reduce((sum, r) => sum + (r.usd ?? 0), 0);
  const anyUnavailable = results.some((r) => r.usd === null);

  return { totalUsd, chains: results, anyUnavailable };
}

/** Formats getUnifiedUsdBalance()'s result into the "Total: $X\nChain: $Y ..." block used on Balance/Wallets views. */
export function formatUnifiedBalanceLines(unified) {
  const chainLines = unified.chains
    .map((c) => `  ${c.name}: ${c.usd === null ? 'unavailable' : `${fmtUsd(c.usd)} ${c.symbol}`}`)
    .join('\n');
  const disclaimer = unified.anyUnavailable ? '\n_Total excludes chains with unavailable balances._' : '';
  return `*Total: ${fmtUsd(unified.totalUsd)}*${disclaimer}\n\n${chainLines}`;
}

export async function gasEstimateLine(chainKey, uid, fallbackGasLimit) {
  if (isSolanaChain(chainKey)) {
    return '\nEst. network fee: ~$0.01 (Solana)';
  }
  try {
    const provider = getEvmProvider(chainKey);
    const chain = getChain(chainKey);
    const mult = gasMultiplierFor(uid);
    const feeData = await provider.getFeeData();
    const baseFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
    const maxFee = (baseFee * BigInt(Math.round(mult * 1000))) / 1000n;
    const gasNative = Number(ethers.formatEther(fallbackGasLimit * maxFee));
    return `\nEst. gas: ~${gasNative.toFixed(5)} ${chain.nativeSymbol}`;
  } catch {
    return '';
  }
}

export function friendlyErrorMessage(err) {
  const code = err?.code;
  const raw = `${err?.message || ''} ${err?.shortMessage || ''} ${err?.reason || ''}`.toLowerCase();

  if (code === 'INSUFFICIENT_FUNDS' || raw.includes('insufficient funds')) {
    return 'Insufficient balance to cover this trade plus gas. Add more of this chain\'s stablecoin (and a little of the native gas token) to your wallet and try again.';
  }
  if (raw.includes('gas required exceeds allowance') || raw.includes('out of gas') || raw.includes('intrinsic gas too low')) {
    return 'Not enough native gas token to cover network fees. Add a bit more and try again.';
  }
  if (code === 'ACTION_REJECTED' || raw.includes('user rejected')) {
    return 'Transaction was rejected.';
  }
  if (code === 'TIMEOUT' || raw.includes('timeout')) {
    return 'The network was too slow to confirm this in time. It may still land — check your position, or try again in a moment.';
  }
  if (raw.includes('slippage') || raw.includes('price impact')) {
    return 'Price moved too much before this could confirm (slippage). Try again, or raise your slippage tolerance in Settings.';
  }
  if (raw.includes('nonce')) {
    return 'A transaction is already pending for this wallet on this chain. Wait a moment and try again.';
  }
  if (code === 'CALL_EXCEPTION' || raw.includes('execution reverted')) {
    return 'The transaction was rejected by the network. This can happen with low-liquidity tokens or expired quotes — try again.';
  }
  const short = (err?.shortMessage || err?.message || 'Unknown error').slice(0, 140);
  return short;
}

export async function getFreshQuote(chainKey, quoteParams, quote, fetchedAt) {
  if (Date.now() - fetchedAt < QUOTE_STALE_MS) return quote;
  return getQuote({ chainKey, ...quoteParams });
}

/**
 * Parses a stablecoin trade amount. Every supported chain's settlement
 * stablecoin (USDC, or USDG on Robinhood Chain) is pegged ~1:1 to USD, so a
 * bare number like `100` or `$100` IS the amount directly — no price feed
 * needed, on any chain.
 */
export function parseUsdcAmountInput(text) {
  const trimmed = text.trim().replace(/^\$/, '').replace(/\s*usdc?g?$/i, '');
  const amt = parseFloat(trimmed.replace(/,/g, ''));
  if (isNaN(amt) || amt <= 0) {
    throw new Error('Send a valid positive USD amount, e.g. `100`');
  }
  return amt;
}

export function parseMcapInput(text) {
  const trimmed = text.trim().replace(/^\$/, '').replace(/,/g, '');
  const match = trimmed.match(/^([\d.]+)\s*([kKmMbB])?$/);
  if (!match) {
    throw new Error('Send a valid market cap, e.g. `50k`, `2.5m`, `1b`, or a plain number like `500000`');
  }
  let num = parseFloat(match[1]);
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') num *= 1_000;
  else if (suffix === 'm') num *= 1_000_000;
  else if (suffix === 'b') num *= 1_000_000_000;

  if (isNaN(num) || num <= 0) {
    throw new Error('Send a valid positive market cap, e.g. `50k`, `2.5m`, `1b`');
  }
  return num;
}

export function mcapToPrice(targetMcap, market) {
  if (!market || !market.marketCap || !market.priceUsd || market.marketCap <= 0 || market.priceUsd <= 0) return null;
  const impliedSupply = market.marketCap / market.priceUsd;
  if (!impliedSupply || impliedSupply <= 0 || !Number.isFinite(impliedSupply)) return null;
  const price = targetMcap / impliedSupply;
  if (!Number.isFinite(price) || price <= 0) return null;
  return price;
}

export function chainDisplayName(chainKey) {
  return getChain(chainKey).name;
}
