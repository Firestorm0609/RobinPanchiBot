import axios from 'axios';
import { ethers } from 'ethers';

// LI.FI aggregates bridge liquidity solvers (Relay, Across, Stargate, etc.)
// Docs: https://docs.li.fi/
const LIFI_BASE_URL = 'https://li.quest/v1';

const ETH_CHAIN_ID = 1;
const ROBINHOOD_CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'; // LI.FI convention for native ETH

export const BRIDGE_DIRECTION = {
  ETH_TO_ROBINHOOD: 'eth_to_robinhood',
  ROBINHOOD_TO_ETH: 'robinhood_to_eth',
};

function chainsForDirection(direction) {
  return direction === BRIDGE_DIRECTION.ETH_TO_ROBINHOOD
    ? { fromChain: ETH_CHAIN_ID, toChain: ROBINHOOD_CHAIN_ID }
    : { fromChain: ROBINHOOD_CHAIN_ID, toChain: ETH_CHAIN_ID };
}

/**
 * Converts a user-supplied ETH amount (number or string) into a plain decimal
 * string safe for ethers.parseEther. Number#toString() can produce
 * exponential notation for very small values (e.g. 0.0000005 -> "5e-7"),
 * which parseEther cannot parse and will throw on. toFixed(18) avoids that,
 * then we trim trailing zeros/dot so parseEther doesn't choke on excess
 * precision either.
 */
function toPlainEthString(amountEth) {
  const n = typeof amountEth === 'number' ? amountEth : Number(amountEth);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ETH amount: ${amountEth}`);
  }
  let s = n.toFixed(18);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

/**
 * Fetch a firm bridge quote for moving native ETH between Ethereum and Robinhood Chain.
 * amountEth is a decimal string/number, e.g. 0.05
 */
export async function getBridgeQuote({ direction, amountEth, fromAddress, toAddress }) {
  const { fromChain, toChain } = chainsForDirection(direction);
  const fromAmount = ethers.parseEther(toPlainEthString(amountEth)).toString();

  const params = {
    fromChain,
    toChain,
    fromToken: NATIVE_TOKEN,
    toToken: NATIVE_TOKEN,
    fromAmount,
    fromAddress,
    toAddress: toAddress || fromAddress,
    // Slippage as a fraction (0.005 = 0.5%). Fixed here; expose via settings later if needed.
    slippage: 0.005,
  };

  const res = await axios.get(`${LIFI_BASE_URL}/quote`, { params }).catch((err) => {
    console.error('LI.FI quote error:', JSON.stringify(err.response?.data ?? err.message, null, 2));
    throw new Error(err.response?.data?.message || 'Failed to get bridge quote');
  });

  const data = res.data;
  return {
    raw: data,
    tool: data.toolDetails?.name || data.tool,
    estimatedDurationSeconds: data.estimate?.executionDuration ?? null,
    toAmountFormatted: ethers.formatEther(data.estimate?.toAmount ?? '0'),
    // NOTE: these are USD-denominated fee costs from LI.FI, not ETH.
    feesUsd: (data.estimate?.feeCosts || []).reduce((sum, f) => sum + Number(f.amountUSD || 0), 0),
    transactionRequest: data.transactionRequest,
  };
}

/**
 * Estimates the ETH gas cost of a bridge's source-chain tx BEFORE it's sent,
 * for display on the confirm screen. Mirrors estimateSwapGasEth in swap.js —
 * uses the quote's own gas limit (if LI.FI supplied one) times the source
 * chain's current fee estimate, scaled by gasMultiplier so the number shown
 * matches what will actually be applied at send time.
 */
export async function estimateBridgeGasEth(provider, quote, gasMultiplier = 1) {
  const tx = quote.transactionRequest;
  const feeData = await provider.getFeeData();
  const baseFee = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : (feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei'));
  const maxFeePerGas = (baseFee * BigInt(Math.round(gasMultiplier * 1000))) / 1000n;
  const gasLimit = tx.gasLimit ? BigInt(tx.gasLimit) : 250_000n;
  const costWei = gasLimit * maxFeePerGas;
  return Number(ethers.formatEther(costWei));
}

/**
 * Sends the bridge transaction on the source chain. Does not wait for the
 * destination-side delivery — call checkBridgeStatusOnce / the bot.js poller for that.
 *
 * Same stuck-tx protection as swap.js's sendSwapWithGasBump: if the tx isn't
 * mined within `timeoutMs`, resubmits the SAME nonce with fees bumped by
 * `bumpPct`, repeating until it lands or `maxAttempts` is hit. Without this,
 * a congested source-chain tx can hang the caller's `await` forever, which
 * for bot.js means the per-user bridgesInFlight lock never releases and the
 * user is silently stuck.
 *
 * `gasMultiplier` scales the INITIAL fee estimate before any congestion
 * bumps are applied — same gas priority tier mechanism as swap.js.
 *
 * Returns { txResponse, receipt, bumped } for the transaction that actually
 * confirmed (the last resubmission, if any bumps happened).
 */
export async function sendBridgeTx(signer, quote, { timeoutMs = 45_000, bumpPct = 20, maxAttempts = 4, gasMultiplier = 1 } = {}) {
  const tx = quote.transactionRequest;
  const nonce = await signer.getNonce();
  const feeData = await signer.provider.getFeeData();
  const baseMaxFee = tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : (feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei'));
  const basePriorityFee = tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : (feeData.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'));
  const multBps = BigInt(Math.round(gasMultiplier * 1000));
  let maxFeePerGas = (baseMaxFee * multBps) / 1000n;
  let maxPriorityFeePerGas = (basePriorityFee * multBps) / 1000n;

  const baseTxRequest = {
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
    gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
  };

  let lastTxResponse;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastTxResponse = await signer.sendTransaction({ ...baseTxRequest, nonce, maxFeePerGas, maxPriorityFeePerGas });
    try {
      const receipt = await lastTxResponse.wait(1, timeoutMs);
      return { txResponse: lastTxResponse, receipt, bumped: attempt > 1 };
    } catch (err) {
      const timedOut = err.code === 'TIMEOUT' || err.message?.toLowerCase().includes('timeout');
      if (!timedOut || attempt === maxAttempts) throw err;
      maxFeePerGas = (maxFeePerGas * BigInt(100 + bumpPct)) / 100n;
      maxPriorityFeePerGas = (maxPriorityFeePerGas * BigInt(100 + bumpPct)) / 100n;
    }
  }
  throw new Error('sendBridgeTx: exhausted attempts'); // unreachable
}

/** One-shot status check (no waiting) — used by the periodic background poller in bot.js. */
export async function checkBridgeStatusOnce({ txHash, fromChain, toChain, bridgeTool }) {
  const res = await axios.get(`${LIFI_BASE_URL}/status`, {
    params: { txHash, fromChain, toChain, bridge: bridgeTool },
  }).catch((err) => {
    console.error('LI.FI status error:', err.response?.data ?? err.message);
    return null;
  });
  if (!res?.data) return { status: 'PENDING', destTxHash: null, raw: null };
  const { status, receiving } = res.data;
  if (status === 'DONE') return { status: 'DONE', destTxHash: receiving?.txHash ?? null, raw: res.data };
  if (status === 'FAILED') return { status: 'FAILED', destTxHash: null, raw: res.data };
  return { status: 'PENDING', destTxHash: null, raw: res.data };
}

export function chainIdsForDirection(direction) {
  return chainsForDirection(direction);
}

export { ETH_CHAIN_ID, ROBINHOOD_CHAIN_ID };
