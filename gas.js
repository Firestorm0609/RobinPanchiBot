import { ethers } from 'ethers';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { getUsdcBalance } from './erc20.js';
import { getChain } from './chains.js';
import { getSolBalance } from './solana.js';
import { MIN_GAS_ETH_RESERVE, GAS_TOPUP_USDC_AMOUNT, MIN_SOL_GAS_RESERVE } from './config.js';

/**
 * EVM only. Ensures `signer`'s wallet has enough native gas token to pay for
 * the trade it's about to make, on whatever chain `signer`/`provider` point
 * to. If native balance is low, swaps GAS_TOPUP_USDC_AMOUNT of that chain's
 * own USDC into the native token via a normal 0x quote, and waits for it.
 */
export async function ensureGasReserve(chainKey, signer, walletAddress) {
  const chain = getChain(chainKey);
  const provider = signer.provider;
  const nativeBalance = await provider.getBalance(walletAddress);
  const nativeBalanceNum = Number(ethers.formatEther(nativeBalance));

  if (nativeBalanceNum >= MIN_GAS_ETH_RESERVE) {
    return { toppedUp: false };
  }

  const usdcBalance = await getUsdcBalance(provider, chain.usdcAddress, walletAddress);
  const usdcBalanceNum = Number(ethers.formatUnits(usdcBalance, chain.usdcDecimals));

  if (usdcBalanceNum < GAS_TOPUP_USDC_AMOUNT) {
    throw new Error(
      `Wallet is low on ${chain.nativeSymbol} (${nativeBalanceNum.toFixed(5)}) and doesn't hold enough USDC ` +
      `(${usdcBalanceNum.toFixed(2)}) on ${chain.name} to auto-top-up. Add USDC to this wallet on ${chain.name}.`
    );
  }

  const sellAmount = ethers.parseUnits(GAS_TOPUP_USDC_AMOUNT.toString(), chain.usdcDecimals).toString();
  const quote = await getQuote({
    chainKey,
    sellToken: chain.usdcAddress,
    buyToken: 'ETH', // 0x's native-token convention regardless of the chain's actual symbol
    sellAmount,
    taker: walletAddress,
    slippageBps: 200,
  });

  const txRequest = await buildSwapTx(signer, quote);
  const { txResponse } = await sendSwapWithGasBump(signer, txRequest);

  return { toppedUp: true, txHash: txResponse.hash };
}

/**
 * Solana only. Unlike EVM, there's no auto-top-up here: paying for a swap
 * requires already holding SOL (you can't pay Solana tx fees in USDC), so a
 * USDC->SOL swap to "top up gas" would itself need gas to execute — a
 * chicken-and-egg problem. Instead this just checks the balance and gives
 * the user a clear, actionable error if it's too low, telling them to
 * deposit a small amount of SOL directly.
 */
export async function ensureSolanaGasReserve(solAddress) {
  const balance = await getSolBalance(solAddress);
  if (balance < MIN_SOL_GAS_RESERVE) {
    throw new Error(
      `Wallet only has ${balance.toFixed(4)} SOL, below the ${MIN_SOL_GAS_RESERVE} SOL needed to cover network fees. ` +
      `Deposit a small amount of SOL directly to this wallet's Solana address (a few cents' worth covers dozens of trades).`
    );
  }
  return { ok: true, balance };
}
