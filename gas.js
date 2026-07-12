import { ethers } from 'ethers';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { provider, USDC_ROBINHOOD_ADDRESS, USDC_DECIMALS, MIN_GAS_ETH_RESERVE, GAS_TOPUP_USDC_AMOUNT } from './config.js';
import { getUsdcBalance } from './erc20.js';

/**
 * Ensures `signer`'s wallet has enough native ETH to pay gas for the trade
 * it's about to make. If the native balance is below MIN_GAS_ETH_RESERVE,
 * swaps GAS_TOPUP_USDC_AMOUNT worth of the wallet's own USDC into ETH via a
 * normal 0x quote (USDC -> native ETH) and waits for it to confirm.
 *
 * This is what lets the rest of the bot treat USDC as the only balance the
 * user ever has to think about — gas is topped up transparently, in the
 * background, out of the same USDC they're already trading with.
 *
 * Returns { toppedUp: boolean, txHash?: string }. Throws only if the wallet
 * has neither enough ETH nor enough USDC to cover a top-up (genuine
 * "add funds" case — surfaced to the user as a normal trade failure).
 */
export async function ensureGasReserve(signer, walletAddress) {
  const ethBalance = await provider.getBalance(walletAddress);
  const ethBalanceNum = Number(ethers.formatEther(ethBalance));

  if (ethBalanceNum >= MIN_GAS_ETH_RESERVE) {
    return { toppedUp: false };
  }

  const usdcBalance = await getUsdcBalance(walletAddress);
  const usdcBalanceNum = Number(ethers.formatUnits(usdcBalance, USDC_DECIMALS));

  if (usdcBalanceNum < GAS_TOPUP_USDC_AMOUNT) {
    throw new Error(
      `Wallet is low on gas (${ethBalanceNum.toFixed(5)} ETH) and doesn't hold enough USDC ` +
      `(${usdcBalanceNum.toFixed(2)}) to auto-top-up. Add USDC to this wallet.`
    );
  }

  const sellAmount = ethers.parseUnits(GAS_TOPUP_USDC_AMOUNT.toString(), USDC_DECIMALS).toString();
  const quote = await getQuote({
    sellToken: USDC_ROBINHOOD_ADDRESS,
    buyToken: 'ETH',
    sellAmount,
    taker: walletAddress,
    slippageBps: 200, // gas top-ups can tolerate more slippage — it's a small, non-critical amount
  });

  const txRequest = await buildSwapTx(signer, quote);
  const { txResponse } = await sendSwapWithGasBump(signer, txRequest);

  return { toppedUp: true, txHash: txResponse.hash };
}
