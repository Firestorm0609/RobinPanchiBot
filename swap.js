import axios from 'axios';
import { ethers } from 'ethers';

const ZEROX_BASE_URL = 'https://api.0x.org/swap/permit2/quote';

/**
 * Fetch a firm swap quote from 0x, including your affiliate fee.
 */
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export async function getQuote({ sellToken, buyToken, sellAmount, taker, slippageBps = 100 }) {
  const params = {
    chainId: process.env.CHAIN_ID,
    sellToken: sellToken === 'ETH' ? NATIVE_ETH : ethers.getAddress(sellToken),
    buyToken: buyToken === 'ETH' ? NATIVE_ETH : ethers.getAddress(buyToken),
    sellAmount,
    taker: ethers.getAddress(taker),
    slippageBps,
    swapFeeRecipient: ethers.getAddress(process.env.AFFILIATE_ADDRESS),
    swapFeeBps: process.env.AFFILIATE_FEE_BPS,
    swapFeeToken: buyToken === 'ETH' ? NATIVE_ETH : ethers.getAddress(buyToken),
  };

  const res = await axios.get(ZEROX_BASE_URL, {
    params,
    headers: {
      '0x-api-key': process.env.ZEROX_API_KEY,
      '0x-version': 'v2',
    },
  }).catch((err) => {
    console.error('0x quote error:', JSON.stringify(err.response?.data ?? err.message, null, 2));
    throw err;
  });

  const data = res.data;
  return {
    ...data,
    buyAmountFormatted: ethers.formatUnits(data.buyAmount, data.buyToken?.decimals ?? 18),
  };
}

/**
 * Builds the swap tx request (does NOT send it) from the 0x quote.
 * Handles Permit2 signature if required by the quote.
 */
export async function buildSwapTx(signer, quote) {
  const tx = {
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: quote.transaction.value ? BigInt(quote.transaction.value) : 0n,
    gasLimit: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
  };

  // If quote requires Permit2 signature, sign and append it (see 0x docs for exact EIP-712 payload).
  if (quote.permit2?.eip712) {
    const { domain, types, message } = quote.permit2.eip712;
    const cleanTypes = { ...types };
    delete cleanTypes.EIP712Domain; // ethers v6 derives this from `domain` itself
    const signature = await signer.signTypedData(domain, cleanTypes, message);
    // Append signature length + signature to calldata per 0x spec
    const sigLengthHex = ethers.zeroPadValue(ethers.toBeHex(ethers.dataLength(signature)), 32);
    tx.data = ethers.concat([tx.data, sigLengthHex, signature]);
  }

  return tx;
}

/**
 * Estimates the ETH cost of a built tx BEFORE it's sent, for display on a
 * confirm screen. Uses the tx's own gasLimit (from the 0x quote) times the
 * network's current fee estimate, scaled by the same gasMultiplier that
 * will actually be applied at send time — so the number shown matches what
 * the user will pay (modulo any gas bumps if the network is congested).
 */
export async function estimateSwapGasEth(provider, txRequest, gasMultiplier = 1) {
  const feeData = await provider.getFeeData();
  const baseFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
  const maxFeePerGas = (baseFee * BigInt(Math.round(gasMultiplier * 1000))) / 1000n;
  const gasLimit = txRequest.gasLimit ?? 250_000n;
  const costWei = gasLimit * maxFeePerGas;
  return Number(ethers.formatEther(costWei));
}

/**
 * Sends a built tx and waits for confirmation. If the tx isn't mined within
 * `timeoutMs`, resubmits the SAME nonce with fees bumped by `bumpPct`,
 * repeating until it lands or `maxAttempts` is hit. This is what keeps a
 * trade from getting silently stuck forever when the network is congested.
 *
 * `gasMultiplier` scales the INITIAL fee estimate before any congestion
 * bumps are applied — this is how the user's configured gas priority tier
 * (slow/normal/fast, see GAS_TIER_MULTIPLIERS in bot.js) takes effect.
 *
 * Returns { txResponse, receipt, bumped } for the transaction that actually
 * confirmed (the last resubmission, if any bumps happened).
 */
export async function sendSwapWithGasBump(signer, txRequest, { timeoutMs = 45_000, bumpPct = 20, maxAttempts = 4, gasMultiplier = 1 } = {}) {
  const nonce = await signer.getNonce();
  const feeData = await signer.provider.getFeeData();
  const baseMaxFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
  const basePriorityFee = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei');
  const multBps = BigInt(Math.round(gasMultiplier * 1000));
  let maxFeePerGas = (baseMaxFee * multBps) / 1000n;
  let maxPriorityFeePerGas = (basePriorityFee * multBps) / 1000n;

  let lastTxResponse;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastTxResponse = await signer.sendTransaction({ ...txRequest, nonce, maxFeePerGas, maxPriorityFeePerGas });
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
  throw new Error('sendSwapWithGasBump: exhausted attempts'); // unreachable
}
