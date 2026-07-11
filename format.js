import { ethers } from 'ethers';
import { getQuote } from './swap.js';
import { getEthUsdPrice, fmtUsd } from './price.js';
import { ETH_CHAIN_ID } from './bridge.js';
import { provider, ethMainnetProvider, USDG_ROBINHOOD_ADDRESS, ERC20_BALANCE_ABI, QUOTE_STALE_MS } from './config.js';
import { gasMultiplierFor, botIdentity } from './state.js';

export function fmtEth(n) {
  return Number(n).toFixed(4);
}

export function explorerTxUrl(hash) {
  const base = (process.env.EXPLORER_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/tx/${hash}` : null;
}

export function explorerTxUrlForChain(hash, chainId) {
  if (chainId === ETH_CHAIN_ID) return `https://etherscan.io/tx/${hash}`;
  return explorerTxUrl(hash);
}

export function referralLink(code) {
  return `https://t.me/${botIdentity.username || 'your_bot'}?start=ref_${code}`;
}

/**
 * Shows BOTH chains explicitly — "Robinhood ETH" and "Ethereum ETH" — never
 * a bare "ETH" that leaves it ambiguous which chain it's on. A zero balance
 * is shown as "0.0000", not hidden; only an actual RPC failure shows
 * "unavailable".
 */
export async function dualEthBalanceLines(address) {
  const ethUsd = await getEthUsdPrice().catch(() => null);
  const [robinhood, mainnet] = await Promise.all([
    provider.getBalance(address).then((b) => Number(ethers.formatEther(b))).catch(() => null),
    ethMainnetProvider.getBalance(address).then((b) => Number(ethers.formatEther(b))).catch(() => null),
  ]);
  const line = (label, amt) => {
    if (amt === null) return `${label} ETH: unavailable`;
    const usd = ethUsd !== null ? ` (${fmtUsd(amt * ethUsd)})` : '';
    return `${label} ETH: ${fmtEth(amt)}${usd}`;
  };
  return `${line('Robinhood', robinhood)}\n${line('Ethereum', mainnet)}`;
}

export async function getBridgeBalances(address) {
  const [ethMainnet, ethRobinhood, usdgRobinhood] = await Promise.all([
    ethMainnetProvider.getBalance(address).then((b) => Number(ethers.formatEther(b))).catch(() => null),
    provider.getBalance(address).then((b) => Number(ethers.formatEther(b))).catch(() => null),
    (async () => {
      const token = new ethers.Contract(USDG_ROBINHOOD_ADDRESS, ERC20_BALANCE_ABI, provider);
      const [raw, decimals] = await Promise.all([token.balanceOf(address), token.decimals()]);
      return Number(ethers.formatUnits(raw, decimals));
    })().catch(() => null),
  ]);
  return { ethMainnet, ethRobinhood, usdgRobinhood };
}

export function fmtBridgeBalanceLine(label, amount, ethUsd) {
  if (amount === null) return `${label}: unavailable`;
  const usdLine = ethUsd !== null ? ` (${fmtUsd(amount * ethUsd)})` : '';
  return `${label}: ${amount.toFixed(4)}${usdLine}`;
}

export async function gasEstimateLine(uid, fallbackGasLimit) {
  try {
    const mult = gasMultiplierFor(uid);
    const feeData = await provider.getFeeData();
    const baseFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
    const maxFee = (baseFee * BigInt(Math.round(mult * 1000))) / 1000n;
    const gasEth = Number(ethers.formatEther(fallbackGasLimit * maxFee));
    const ethUsd = await getEthUsdPrice().catch(() => null);
    return `\nEst. gas: ~${gasEth.toFixed(5)} ETH${ethUsd !== null ? ` (${fmtUsd(gasEth * ethUsd)})` : ''}`;
  } catch {
    return '';
  }
}

export function friendlyErrorMessage(err) {
  const code = err?.code;
  const raw = `${err?.message || ''} ${err?.shortMessage || ''} ${err?.reason || ''}`.toLowerCase();

  if (code === 'INSUFFICIENT_FUNDS' || raw.includes('insufficient funds')) {
    return 'Insufficient balance to cover this trade plus gas. Add more ETH to your wallet and try again.';
  }
  if (raw.includes('gas required exceeds allowance') || raw.includes('out of gas') || raw.includes('intrinsic gas too low')) {
    return 'Not enough ETH to cover network gas fees. Add a bit more ETH and try again.';
  }
  if (code === 'ACTION_REJECTED' || raw.includes('user rejected')) {
    return 'Transaction was rejected.';
  }
  if (code === 'TIMEOUT' || raw.includes('timeout')) {
    return 'The network was too slow to confirm this in time. It may still land — check 🕘 Recent Bridges or your position, or try again in a moment.';
  }
  if (raw.includes('slippage') || raw.includes('price impact')) {
    return 'Price moved too much before this could confirm (slippage). Try again, or raise your slippage tolerance in Settings.';
  }
  if (raw.includes('nonce')) {
    return 'A transaction is already pending for this wallet. Wait a moment and try again.';
  }
  if (code === 'CALL_EXCEPTION' || raw.includes('execution reverted')) {
    return 'The transaction was rejected by the network. This can happen with low-liquidity tokens or expired quotes — try again.';
  }
  const short = (err?.shortMessage || err?.message || 'Unknown error').slice(0, 140);
  return short;
}

export async function getFreshQuote(quoteParams, quote, fetchedAt) {
  if (Date.now() - fetchedAt < QUOTE_STALE_MS) return quote;
  return getQuote(quoteParams);
}

/**
 * Parses a user-entered amount. USD is now the DEFAULT format (mimics
 * FOMO-style UX) — a bare number like `100` or `$100` is read as USD and
 * converted to ETH via the live price. To enter a raw ETH amount instead,
 * suffix it with "eth", e.g. `0.05 eth`.
 *
 * Internally we still always resolve to an ETH amount (`amountEth`) since
 * every trade/bridge/transfer executes in ETH — only the input/display
 * layer is USD-first now.
 */
export async function parseEthOrUsdInput(text) {
  const trimmed = text.trim();

  const ethMatch = trimmed.match(/^([\d.,]+)\s*eth$/i);
  if (ethMatch) {
    const amt = parseFloat(ethMatch[1].replace(/,/g, ''));
    if (isNaN(amt) || amt <= 0) {
      throw new Error('Send a valid positive ETH amount, e.g. `0.05 eth`');
    }
    return { amountEth: amt, usdInput: null };
  }

  const usdStr = trimmed.startsWith('$') ? trimmed.slice(1) : trimmed;
  const usd = parseFloat(usdStr.replace(/,/g, ''));
  if (isNaN(usd) || usd <= 0) {
    throw new Error('Send a valid USD amount, e.g. `100` — or an ETH amount like `0.05 eth`');
  }

  let ethUsd;
  try {
    ethUsd = await getEthUsdPrice();
  } catch {
    throw new Error('Price feed is down right now — send an ETH amount instead, e.g. `0.05 eth`');
  }
  return { amountEth: usd / ethUsd, usdInput: usd };
}

export const parseBridgeAmountInput = parseEthOrUsdInput;

/**
 * Parses a market-cap shorthand input into a raw USD number.
 * Accepts: `50k` -> 50,000 | `2.5m` -> 2,500,000 | `1b` -> 1,000,000,000
 * Also accepts a plain number (`500000`) or `$`-prefixed, comma-separated input.
 * Case-insensitive suffix. Throws with a user-facing message on invalid input.
 */
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

/**
 * Converts a target market cap (USD) into an equivalent per-token USD price,
 * using a live market snapshot's price/marketCap ratio (i.e. circulating
 * supply = marketCap / priceUsd). This is what lets users set limit orders
 * in mcap terms while the poller keeps comparing against live token price
 * under the hood (price is what DexScreener actually reports in real time).
 * Returns null if the snapshot doesn't have enough data to compute a ratio,
 * or if the computed price isn't a finite positive number (guards against a
 * malformed/stale market snapshot producing a NaN/Infinity trigger price
 * that would silently never fire, or fire immediately, once stored).
 */
export function mcapToPrice(targetMcap, market) {
  if (!market || !market.marketCap || !market.priceUsd || market.marketCap <= 0 || market.priceUsd <= 0) return null;
  const impliedSupply = market.marketCap / market.priceUsd;
  if (!impliedSupply || impliedSupply <= 0 || !Number.isFinite(impliedSupply)) return null;
  const price = targetMcap / impliedSupply;
  if (!Number.isFinite(price) || price <= 0) return null;
  return price;
}

/**
 * Standard "amount" label used across buy/batch/bridge confirmations and
 * results — USD-first, with the ETH equivalent shown in parentheses. Falls
 * back to a plain ETH label if no USD figure is available (e.g. explicit
 * `0.05 eth` input, or price feed was down at parse time).
 */
export function fmtAmountLabel(amountEth, usdInput) {
  if (usdInput !== null && usdInput !== undefined) {
    return `${fmtUsd(usdInput)} (≈ ${amountEth} ETH)`;
  }
  return `${amountEth} ETH`;
}
