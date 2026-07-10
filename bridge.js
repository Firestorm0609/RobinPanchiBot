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
 * Fetch a firm bridge quote for moving native ETH between Ethereum and Robinhood Chain.
 * amountEth is a decimal string/number, e.g. 0.05
 */
export async function getBridgeQuote({ direction, amountEth, fromAddress, toAddress }) {
  const { fromChain, toChain } = chainsForDirection(direction);
  const fromAmount = ethers.parseEther(amountEth.toString()).toString();

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
 * Sends the bridge transaction on the source chain. Does not wait for the
 * destination-side delivery — call pollBridgeStatus for that.
 */
export async function sendBridgeTx(signer, quote) {
  const tx = quote.transactionRequest;
  const txResponse = await signer.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
    gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
  });
  const receipt = await txResponse.wait();
  return { txResponse, receipt };
}

/**
 * Polls LI.FI's status endpoint for a bridge transaction until it's DONE or
 * FAILED, or until maxWaitMs elapses (caller should keep the pending_bridges
 * row and let the background poller in bot.js pick it back up later if so).
 *
 * Returns { status: 'DONE' | 'FAILED' | 'PENDING', destTxHash, raw }
 */
export async function pollBridgeStatus({ txHash, fromChain, toChain, bridgeTool }, { maxWaitMs = 120_000, intervalMs = 5_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await axios.get(`${LIFI_BASE_URL}/status`, {
      params: { txHash, fromChain, toChain, bridge: bridgeTool },
    }).catch((err) => {
      console.error('LI.FI status error:', err.response?.data ?? err.message);
      return null;
    });

    if (res?.data) {
      const { status, receiving } = res.data;
      if (status === 'DONE') {
        return { status: 'DONE', destTxHash: receiving?.txHash ?? null, raw: res.data };
      }
      if (status === 'FAILED') {
        return { status: 'FAILED', destTxHash: null, raw: res.data };
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return { status: 'PENDING', destTxHash: null, raw: null };
}

/** One-shot status check (no waiting) — used by the periodic background poller. */
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
