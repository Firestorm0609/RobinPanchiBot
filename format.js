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

export async function parseEthOrUsdInput(text) {
  const trimmed = text.trim();
  const isUsd = trimmed.startsWith('$');

  if (isUsd) {
    const usd = parseFloat(trimmed.slice(1).replace(/,/g, ''));
    if (isNaN(usd) || usd <= 0) {
      throw new Error('Send a valid positive USD amount, e.g. `$100`');
    }
    let ethUsd;
    try {
      ethUsd = await getEthUsdPrice();
    } catch {
      throw new Error('Price feed is down right now — send an ETH amount instead, e.g. `0.05`');
    }
    return { amountEth: usd / ethUsd, usdInput: usd };
  }

  const amt = parseFloat(trimmed);
  if (isNaN(amt) || amt <= 0) {
    throw new Error('Send a valid positive ETH amount (e.g. `0.05`) or USD amount (e.g. `$100`)');
  }
  return { amountEth: amt, usdInput: null };
}

export const parseBridgeAmountInput = parseEthOrUsdInput;
