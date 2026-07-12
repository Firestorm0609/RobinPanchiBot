import axios from 'axios';
import { ethers } from 'ethers';
import { getChain } from './chains.js';

const ZEROX_BASE_URL = 'https://api.0x.org/swap/permit2/quote';
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * Fetch a firm swap quote from 0x on a specific EVM chain. `chainKey` is one
 * of the keys in chains.js (e.g. 'base', 'arbitrum', 'robinhood') — 0x
 * itself is already multi-chain, this just stops the bot from being
 * hardcoded to a single one.
 */
export async function getQuote({ chainKey, sellToken, buyToken, sellAmount, taker, slippageBps = 100 }) {
  const chain = getChain(chainKey);

  const params = {
    chainId: chain.chainId,
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
    console.error(`0x quote error (${chain.name}):`, JSON.stringify(err.response?.data ?? err.message, null, 2));
    throw err;
  });

  const data = res.data;
  return {
    ...data,
    chainKey,
    buyAmountFormatted: ethers.formatUnits(data.buyAmount, data.buyToken?.decimals ?? 18),
  };
}

export async function buildSwapTx(signer, quote) {
  const tx = {
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: quote.transaction.value ? BigInt(quote.transaction.value) : 0n,
    gasLimit: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
  };

  if (quote.permit2?.eip712) {
    const { domain, types, message } = quote.permit2.eip712;
    const cleanTypes = { ...types };
    delete cleanTypes.EIP712Domain;
    const signature = await signer.signTypedData(domain, cleanTypes, message);
    const sigLengthHex = ethers.zeroPadValue(ethers.toBeHex(ethers.dataLength(signature)), 32);
    tx.data = ethers.concat([tx.data, sigLengthHex, signature]);
  }

  return tx;
}

export async function estimateSwapGasEth(provider, txRequest, gasMultiplier = 1) {
  const feeData = await provider.getFeeData();
  const baseFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
  const maxFeePerGas = (baseFee * BigInt(Math.round(gasMultiplier * 1000))) / 1000n;
  const gasLimit = txRequest.gasLimit ?? 250_000n;
  const costWei = gasLimit * maxFeePerGas;
  return Number(ethers.formatEther(costWei));
}

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
  throw new Error('sendSwapWithGasBump: exhausted attempts');
}
