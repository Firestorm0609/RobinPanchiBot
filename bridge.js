import axios from 'axios';
import { ethers } from 'ethers';
import { VersionedTransaction, Transaction } from '@solana/web3.js';
import { getChain, getEvmProvider, isSolanaChain } from './chains.js';
import { getSolanaConnection } from './solana.js';

// ---------------------------------------------------------------------------
// LI.FI REST integration (https://li.quest/v1). Deliberately NOT using
// @lifi/sdk: the SDK just went through a breaking v3->v4 change (v4 requires
// viem wallet clients + separate per-ecosystem provider packages; this bot
// has zero viem dependency and signs with raw ethers.Wallet / Solana
// Keypair everywhere). The REST API needs no SDK at all and matches the
// pattern already used in swap.js (0x) and solana-swap.js (Jupiter).
//
// No API key is required — LI.FI's public endpoints work unauthenticated
// (200 req/2hr). Set LIFI_API_KEY in .env for higher limits (200 req/min);
// this module works with or without it.
// ---------------------------------------------------------------------------

const LIFI_BASE_URL = 'https://li.quest/v1';
const LIFI_INTEGRATOR = 'panchi-trading-bot';
const SOLANA_LIFI_CHAIN_ID = 1151111081099710;
const NATIVE_TOKEN_PLACEHOLDER = '0x0000000000000000000000000000000000000000';

function lifiHeaders() {
  const headers = {};
  if (process.env.LIFI_API_KEY) headers['x-lifi-api-key'] = process.env.LIFI_API_KEY;
  return headers;
}

/** Maps a chains.js chainKey to LI.FI's numeric chain id. */
function lifiChainId(chainKey) {
  if (isSolanaChain(chainKey)) return SOLANA_LIFI_CHAIN_ID;
  return getChain(chainKey).chainId;
}

/**
 * Fetches a firm bridge (or bridge+swap) quote from LI.FI.
 *
 * fromToken/toToken: token contract address / SPL mint, or NATIVE_TOKEN_PLACEHOLDER
 * for the native gas token. amount is the raw (smallest-unit) string/bigint.
 * fromAddress/toAddress: normally the same wallet's address on each
 * respective chain (EVM address for EVM legs, Solana address for Solana legs)
 * — this bot's wallets share one identity across chains via wallet.js, so
 * callers typically pass the same logical wallet's two addresses.
 *
 * Returns the raw LI.FI quote object. quote.transactionRequest is what
 * executeBridge() signs and sends. quote.estimate has the fee/time breakdown
 * needed to show the user what bridging will cost/take.
 */
export async function getBridgeQuote({
  fromChainKey, toChainKey, fromToken, toToken, amount, fromAddress, toAddress, slippage = 0.03,
}) {
  const params = {
    fromChain: lifiChainId(fromChainKey),
    toChain: lifiChainId(toChainKey),
    fromToken,
    toToken,
    fromAmount: amount.toString(),
    fromAddress,
    toAddress: toAddress || fromAddress,
    slippage,
    integrator: LIFI_INTEGRATOR,
  };

  const res = await axios.get(`${LIFI_BASE_URL}/quote`, { params, headers: lifiHeaders() }).catch((err) => {
    console.error(
      `LI.FI quote error (${fromChainKey} -> ${toChainKey}):`,
      JSON.stringify(err.response?.data ?? err.message, null, 2)
    );
    throw new Error(err.response?.data?.message || 'Failed to get LI.FI bridge quote');
  });

  return { ...res.data, fromChainKey, toChainKey };
}

/**
 * Human-readable summary of what a quote will cost/take, for confirm
 * messages. LI.FI's `feeCosts` and `gasCosts` are both already denominated
 * in the amounts/tokens shown in `estimate` — this just sums their USD
 * values so the caller doesn't have to know LI.FI's response shape.
 */
export function summarizeBridgeQuote(quote) {
  const est = quote.estimate || {};
  const feeUsd = (est.feeCosts || []).reduce((sum, f) => sum + Number(f.amountUSD || 0), 0);
  const gasUsd = (est.gasCosts || []).reduce((sum, g) => sum + Number(g.amountUSD || 0), 0);
  const totalFeeUsd = feeUsd + gasUsd;
  const etaSeconds = est.executionDuration ?? null;
  const toAmountUsd = Number(est.toAmountUSD || 0);
  return {
    totalFeeUsd,
    etaSeconds,
    toAmountUsd,
    toolUsed: quote.toolDetails?.name || quote.tool || 'unknown route',
  };
}

// ---------------------------------------------------------------------------
// Execution — three distinct signing paths, since an EVM signer can't touch
// a Solana tx and vice versa. `signerOrKeypair` is an ethers.Wallet for
// EVM-source quotes, or a @solana/web3.js Keypair for Solana-source quotes.
// ---------------------------------------------------------------------------

async function executeEvmLeg(quote, signer) {
  const chainKey = quote.fromChainKey;
  const provider = getEvmProvider(chainKey);
  const tr = quote.transactionRequest;

  // Approve the LI.FI contract to move the source token, if this isn't a
  // native-token send (LI.FI's quote already tells us the spender).
  if (quote.action?.fromToken?.address && quote.action.fromToken.address !== NATIVE_TOKEN_PLACEHOLDER) {
    const ERC20_ABI = [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
    ];
    const token = new ethers.Contract(quote.action.fromToken.address, ERC20_ABI, signer);
    const owner = await signer.getAddress();
    const needed = BigInt(quote.action.fromAmount);
    const current = await token.allowance(owner, tr.to);
    if (current < needed) {
      const approveTx = await token.approve(tr.to, ethers.MaxUint256);
      await approveTx.wait();
    }
  }

  const txRequest = {
    to: tr.to,
    data: tr.data,
    value: tr.value ? BigInt(tr.value) : 0n,
    gasLimit: tr.gasLimit ? BigInt(tr.gasLimit) : undefined,
    gasPrice: tr.gasPrice ? BigInt(tr.gasPrice) : undefined,
  };

  const txResponse = await signer.sendTransaction(txRequest);
  const receipt = await txResponse.wait();
  return { txHash: txResponse.hash, provider, receipt };
}

async function executeSolanaLeg(quote, keypair) {
  const connection = getSolanaConnection();
  const tr = quote.transactionRequest;
  const raw = Buffer.from(tr.data, 'base64');

  // LI.FI returns either a legacy or versioned Solana transaction depending
  // on the route — try versioned first (current default for most routes),
  // fall back to legacy on deserialize failure.
  let signature;
  try {
    const vtx = VersionedTransaction.deserialize(raw);
    vtx.sign([keypair]);
    signature = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 3 });
  } catch {
    const tx = Transaction.from(raw);
    tx.sign(keypair);
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  }

  const latestBlockhash = await connection.getLatestBlockhash();
  const confirmation = await connection.confirmTransaction({ signature, ...latestBlockhash }, 'confirmed');
  if (confirmation.value?.err) {
    throw new Error(`Solana bridge leg failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return { txHash: signature };
}

/**
 * Signs + submits the quote's transaction on the SOURCE chain, then polls
 * LI.FI's /status endpoint until the bridge (and any destination-side swap)
 * completes, fails, or the timeout is hit. This is deliberately awaitable
 * end-to-end — bridges can take seconds to several minutes, and the caller
 * (trade-core.js in Phase 4) needs to know definitively before proceeding
 * to the swap leg on the destination chain.
 *
 * Returns { ok, sourceTxHash, destTxHash, status, receivedAmount } — or
 * throws on outright failure (source tx reverted, or LI.FI reports FAILED).
 * A DONE status with a partial/different destTxHash than expected can
 * happen if LI.FI's route re-routed mid-flight; always trust the returned
 * receivedAmount over what the quote estimated.
 */
export async function executeBridge(quote, signerOrKeypair, { pollIntervalMs = 5000, timeoutMs = 8 * 60_000 } = {}) {
  const isSolanaSource = isSolanaChain(quote.fromChainKey);

  const { txHash: sourceTxHash } = isSolanaSource
    ? await executeSolanaLeg(quote, signerOrKeypair)
    : await executeEvmLeg(quote, signerOrKeypair);

  const deadline = Date.now() + timeoutMs;
  const bridgeTool = quote.tool;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    let statusRes;
    try {
      statusRes = await axios.get(`${LIFI_BASE_URL}/status`, {
        params: {
          txHash: sourceTxHash,
          bridge: bridgeTool,
          fromChain: lifiChainId(quote.fromChainKey),
          toChain: lifiChainId(quote.toChainKey),
        },
        headers: lifiHeaders(),
      });
    } catch (err) {
      // Transient — LI.FI hasn't indexed the tx yet, or a momentary API
      // hiccup. Keep polling until timeout rather than failing on one miss.
      console.warn('LI.FI status check failed (will retry):', err.response?.data?.message || err.message);
      continue;
    }

    const data = statusRes.data;
    if (data.status === 'DONE') {
      return {
        ok: true,
        sourceTxHash,
        destTxHash: data.receiving?.txHash ?? null,
        status: 'DONE',
        receivedAmount: data.receiving?.amount ?? null,
        receivedToken: data.receiving?.token?.address ?? null,
      };
    }
    if (data.status === 'FAILED') {
      throw new Error(`LI.FI bridge failed: ${data.substatusMessage || data.substatus || 'unknown reason'}`);
    }
    // 'PENDING' / 'NOT_FOUND' -> keep polling.
  }

  // Timed out waiting for LI.FI to confirm completion. The source tx DID
  // land (we have sourceTxHash) — funds are very likely fine and just
  // slow — but we can't confirm the destination leg from here. Caller
  // (Phase 2's pending_trades 'bridging' status) should treat this as a
  // recoverable stuck state, not a failure, and re-poll /status later
  // rather than re-sending anything.
  return { ok: false, sourceTxHash, destTxHash: null, status: 'TIMEOUT', receivedAmount: null };
}

/**
 * One-off status check, for resuming a bridge that was mid-flight across a
 * bot restart (Phase 2 / pollers.js territory) without re-executing anything.
 */
export async function checkBridgeStatus({ sourceTxHash, bridgeTool, fromChainKey, toChainKey }) {
  const res = await axios.get(`${LIFI_BASE_URL}/status`, {
    params: {
      txHash: sourceTxHash,
      bridge: bridgeTool,
      fromChain: lifiChainId(fromChainKey),
      toChain: lifiChainId(toChainKey),
    },
    headers: lifiHeaders(),
  });
  return res.data;
}

export { NATIVE_TOKEN_PLACEHOLDER };
