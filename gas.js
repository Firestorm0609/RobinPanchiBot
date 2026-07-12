import { ethers } from 'ethers';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { getUsdcBalance, ensureAllowance } from './erc20.js';
import { getChain, getStableDecimals } from './chains.js';
import { getSolBalance } from './solana.js';
import { MIN_GAS_ETH_RESERVE, GAS_TOPUP_USDC_AMOUNT, MIN_SOL_GAS_RESERVE } from './config.js';

// Minimum stablecoin amount worth bothering to swap for a gas top-up — below
// this, 0x's fee + slippage would eat too much of it to be worth attempting.
const MIN_TOPUP_USDC_AMOUNT = 1;

/**
 * EVM only. Ensures `signer`'s wallet has enough native gas token to pay for
 * the trade/withdrawal it's about to make, on whatever chain `signer`/
 * `provider` point to. If native balance is low, swaps stablecoin into the
 * native token via a normal 0x quote, and waits for it.
 *
 * Two bugs fixed here vs. the original:
 *   1. The swap amount is capped to min(GAS_TOPUP_USDC_AMOUNT, actual
 *      on-chain balance) — never requests more than the wallet holds.
 *   2. ensureAllowance() is now called before building/sending the swap tx.
 *      This was MISSING before — performSwapBuy/performSellCore in
 *      trade-core.js always approve Permit2 first, but this function built
 *      and sent the swap tx directly with zero allowance, causing a silent
 *      CALL_EXCEPTION (transferFrom failing with no revert reason) even
 *      when the wallet had plenty of balance. This is what was breaking
 *      gas top-ups (and therefore withdrawals/trades that needed one) on
 *      Robinhood Chain.
 */
export async function ensureGasReserve(chainKey, signer, walletAddress) {
  const chain = getChain(chainKey);
  const provider = signer.provider;
  const nativeBalance = await provider.getBalance(walletAddress);
  const nativeBalanceNum = Number(ethers.formatEther(nativeBalance));

  if (nativeBalanceNum >= MIN_GAS_ETH_RESERVE) {
    return { toppedUp: false };
  }

  const usdcDecimals = await getStableDecimals(chainKey);
  const usdcBalance = await getUsdcBalance(provider, chain.usdcAddress, walletAddress);
  const usdcBalanceNum = Number(ethers.formatUnits(usdcBalance, usdcDecimals));

  console.log(
    `[gas debug] chain=${chainKey} wallet=${walletAddress} nativeBalance=${nativeBalanceNum} ` +
    `stableDecimals=${usdcDecimals} stableBalanceRaw=${usdcBalance.toString()} stableBalanceNum=${usdcBalanceNum}`
  );

  if (usdcBalanceNum < MIN_TOPUP_USDC_AMOUNT) {
    throw new Error(
      `Wallet is low on ${chain.nativeSymbol} (${nativeBalanceNum.toFixed(5)}) and doesn't hold enough ${chain.stableSymbol || 'USDC'} ` +
      `(${usdcBalanceNum.toFixed(2)}) on ${chain.name} to auto-top-up. Add ${chain.stableSymbol || 'USDC'} to this wallet on ${chain.name}.`
    );
  }

  // Cap the swap amount to what's actually available.
  const topupAmount = Math.min(GAS_TOPUP_USDC_AMOUNT, usdcBalanceNum);
  const sellAmount = ethers.parseUnits(topupAmount.toFixed(usdcDecimals), usdcDecimals).toString();

  console.log(`[gas debug] attempting top-up swap of ${topupAmount} ${chain.stableSymbol || 'USDC'} -> ${chain.nativeSymbol} on ${chain.name}`);

  // THE FIX: approve Permit2 to pull the stablecoin before building/sending
  // the swap tx — this was missing entirely before.
  await ensureAllowance(signer, chain.usdcAddress, BigInt(sellAmount));

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
