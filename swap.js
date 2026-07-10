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
 * Execute the swap tx returned by 0x using the user's signer.
 * Handles Permit2 signature if required by the quote.
 */
export async function getSwapTx(signer, quote) {
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

  return signer.sendTransaction(tx);
}
