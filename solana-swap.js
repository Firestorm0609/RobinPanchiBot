import axios from 'axios';
import { VersionedTransaction } from '@solana/web3.js';
import { getSolanaConnection } from './solana.js';
import { CHAINS } from './chains.js';

const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';
const USDC_MINT = CHAINS.solana.usdcMint;
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Fetch a firm swap quote from Jupiter. sellToken/buyToken accept 'USDC' or
 * 'SOL' shorthand as well as raw mint addresses, mirroring swap.js's 'ETH'
 * shorthand convention for the EVM side.
 */
export async function getSolanaQuote({ sellToken, buyToken, sellAmountRaw, slippageBps = 100, feeBps = null }) {
  const inputMint = sellToken === 'USDC' ? USDC_MINT : sellToken === 'SOL' ? NATIVE_SOL_MINT : sellToken;
  const outputMint = buyToken === 'USDC' ? USDC_MINT : buyToken === 'SOL' ? NATIVE_SOL_MINT : buyToken;

  const params = {
    inputMint,
    outputMint,
    amount: sellAmountRaw.toString(),
    slippageBps,
  };
  if (feeBps) params.platformFeeBps = feeBps;

  const res = await axios.get(JUPITER_QUOTE_URL, { params }).catch((err) => {
    console.error('Jupiter quote error:', JSON.stringify(err.response?.data ?? err.message, null, 2));
    throw new Error(err.response?.data?.error || 'Failed to get Jupiter quote');
  });

  return res.data; // includes outAmount, routePlan, etc. — pass straight into buildSolanaSwapTx
}

/**
 * Builds a ready-to-sign VersionedTransaction from a Jupiter quote.
 * `feeAccount` is your affiliate/fee-collection token account, if using
 * platformFeeBps on the quote — omit if not collecting a fee this way.
 */
export async function buildSolanaSwapTx(quote, userPublicKey, { feeAccount = null, priorityFeeLamports = null } = {}) {
  const body = {
    quoteResponse: quote,
    userPublicKey: userPublicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };
  if (feeAccount) body.feeAccount = feeAccount;
  if (priorityFeeLamports) body.prioritizationFeeLamports = priorityFeeLamports;
  else body.prioritizationFeeLamports = 'auto';

  const res = await axios.post(JUPITER_SWAP_URL, body).catch((err) => {
    console.error('Jupiter swap-build error:', JSON.stringify(err.response?.data ?? err.message, null, 2));
    throw new Error(err.response?.data?.error || 'Failed to build Jupiter swap transaction');
  });

  const txBuf = Buffer.from(res.data.swapTransaction, 'base64');
  return VersionedTransaction.deserialize(txBuf);
}

/**
 * Signs and sends the built transaction, waiting for confirmation.
 * Solana doesn't have the "stuck nonce" problem EVM does (no nonces), but
 * a dropped tx during congestion is still possible — this retries the send
 * (not a resubmit-with-higher-fee, just resend the same signed tx) up to
 * maxAttempts times if it isn't confirmed within timeoutMs.
 */
export async function sendSolanaSwap(signerKeypair, transaction, { timeoutMs = 30_000, maxAttempts = 3 } = {}) {
  const connection = getSolanaConnection();
  transaction.sign([signerKeypair]);
  const rawTx = transaction.serialize();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const signature = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
    try {
      const latestBlockhash = await connection.getLatestBlockhash();
      const confirmation = await Promise.race([
        connection.confirmTransaction({ signature, ...latestBlockhash }, 'confirmed'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)),
      ]);
      if (confirmation.value?.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      return { signature };
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      // loop and resend
    }
  }
  throw new Error('sendSolanaSwap: exhausted attempts'); // unreachable
}
