import { ethers } from 'ethers';
import { getQuote } from './swap.js';
import { fmtUsd } from './price.js';
import { getChain, getEvmProvider, explorerTxUrl, isSolanaChain, isEvmChain, ALL_CHAIN_KEYS } from './chains.js';
import { getSolBalance, getSolanaUsdcBalance } from './solana.js';
import { getUsdcBalance } from './erc20.js';
import { gasMultiplierFor, botIdentity } from './state.js';
import { QUOTE_STALE_MS } from './config.js';

export function fmtEth(n) {
  return Number(n).toFixed(4);
}

export { explorerTxUrl };

export function referralLink(code) {
  return `https://t.me/${botIdentity.username || 'your_bot'}?start=ref_${code}`;
}

/**
 * Native gas balance + USDC balance on ONE chain for a wallet — the unit
 * shown to the user before/while trading on that chain specifically.
 * `wallet` must have both .address (EVM) and .solAddress (Solana).
 */
export async function chainBalanceLines(wallet, chainKey) {
  const chain = getChain(chainKey);

  if (isSolanaChain(chainKey)) {
    const [sol, usdc] = await Promise.all([
      getSolBalance(wallet.solAddress).catch(() => null),
      getSolanaUsdcBalance(wallet.solAddress).catch(() => null),
    ]);
    const solLine = sol === null ? 'SOL: unavailable' : `SOL: ${sol.toFixed(4)}`;
    const usdcLine = usdc === null ? 'USDC: unavailable' : `USDC: ${fmtUsd(usdc)}`;
    return `${solLine}\n${usdcLine}`;
  }

  const provider = getEvmProvider(chainKey);
  const [native, usdcRaw] = await Promise.all([
    provider.getBalance(wallet.address).then((b) => Number(ethers.formatEther(b))).catch(() => null),
    getUsdcBalance(provider, chain.usdcAddress, wallet.address).catch(() => null),
  ]);
  const nativeLine = native === null ? `${chain.nativeSymbol}: unavailable` : `${chain.nativeSymbol}: ${fmtEth(native)}`;
  const usdcLine = usdcRaw === null ? 'USDC: unavailable' : `USDC: ${fmtUsd(Number(ethers.formatUnits(usdcRaw, chain.usdcDecimals)))}`;
  return `${nativeLine}\n${usdcLine}`;
}

/** USDC balance only, on one chain — the number that actually matters for sizing a trade. */
export async function getChainUsdcBalance(wallet, chainKey) {
  if (isSolanaChain(chainKey)) {
    return getSolanaUsdcBalance(wallet.solAddress);
  }
  const chain = getChain(chainKey);
  const provider = getEvmProvider(chainKey);
  const raw = await getUsdcBalance(provider, chain.usdcAddress, wallet.address);
  return Number(ethers.formatUnits(raw, chain.usdcDecimals));
}

/** Summary line across every supported chain — used on the Balance / Wallets views. */
export async function allChainsBalanceSummary(wallet) {
  const lines = await Promise.all(
    ALL_CHAIN_KEYS.map(async (chainKey) => {
      const chain = getChain(chainKey);
      try {
        const usdc = await getChainUsdcBalance(wallet, chainKey);
        return `${chain.name}: ${fmtUsd(usdc)} USDC`;
      } catch {
        return `${chain.name}: unavailable`;
      }
    })
  );
  return lines.join('\n');
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
    return 'Insufficient balance to cover this trade plus gas. Add more USDC (and a little of the native gas token) to your wallet on this chain and try again.';
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
 * Parses a USDC trade amount. USDC is pegged ~1:1 to USD, so a bare number
 * like `100` or `$100` IS the USDC amount directly — no price feed needed,
 * on any chain.
 */
export function parseUsdcAmountInput(text) {
  const trimmed = text.trim().replace(/^\$/, '').replace(/\s*usdc?$/i, '');
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
