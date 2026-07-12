import { ethers } from 'ethers';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { getUsdcBalance, ensureAllowance } from './erc20.js';
import { getChain, getStableDecimals } from './chains.js';
import { getSolBalance } from './solana.js';
import { MIN_GAS_ETH_RESERVE, MIN_SOL_GAS_RESERVE } from './config.js';

// Minimum stablecoin amount worth bothering to swap for a gas top-up — below
// this, 0x's fee + slippage would eat too much of it to be worth attempting.
const MIN_TOPUP_USDC_AMOUNT = 0.20;

// How many "typical transactions worth" of gas to top up to at once, so
// we're not doing a top-up swap before literally every single tx. A typical
// EVM tx here (ERC20 transfer/approve/swap) costs a few cents on Robinhood
// Chain — this buys enough ETH for several transactions, nowhere near the
// old flat $5.
const TOPUP_TX_MULTIPLE = 8;

// Absolute ceiling on a single top-up, regardless of how the gas estimate
// comes out — a safety cap in case of a fee-estimation spike, so we never
// silently convert a large chunk of someone's stablecoin into gas.
const MAX_TOPUP_USDC_AMOUNT = 0.50;

/**
 * Estimates the USD cost of one typical transaction on this chain (an
 * ERC20 transfer/approve/swap — ~65k-300k gas depending on the op; we use a
 * generous 150k as a single "typical tx" estimate since this is just for
 * sizing a gas top-up, not for the actual tx's own gas limit).
 */
async function estimateTypicalTxCostEth(provider) {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits('30', 'gwei');
  const typicalGasLimit = 150_000n;
  const costWei = typicalGasLimit * gasPrice;
  return Number(ethers.formatEther(costWei));
}

// Lightweight native-USD price lookup for sizing purposes only (kept local
// to gas.js to avoid an import-cycle risk with price.js, which gets loaded
// very early in the trade path). Falls back gracefully; if unavailable, the
// MIN_TOPUP_USDC_AMOUNT floor still applies.
const NATIVE_COINGECKO_ID = { ETH: 'ethereum', BNB: 'binancecoin' };
let nativePriceCache = { symbol: null, value: null, ts: 0 };

async function getNativeUsdPriceForGas(nativeSymbol) {
  if (nativePriceCache.symbol === nativeSymbol && Date.now() - nativePriceCache.ts < 60_000) {
    return nativePriceCache.value;
  }
  const id = NATIVE_COINGECKO_ID[nativeSymbol];
  if (!id) return null;
  const axios = (await import('axios')).default;
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: id, vs_currencies: 'usd' },
    timeout: 5000,
  });
  const price = res.data?.[id]?.usd ?? null;
  if (price) nativePriceCache = { symbol: nativeSymbol, value: price, ts: Date.now() };
  return price;
}

/**
 * EVM only. Ensures `signer`'s wallet has enough native gas token to pay for
 * the trade/withdrawal it's about to make, on whatever chain `signer`/
 * `provider` point to. If native balance is low, swaps a SMALL, appropriately
 * sized amount of stablecoin into the native token via a normal 0x quote,
 * and waits for it.
 *
 * Sizing: tops up to roughly TOPUP_TX_MULTIPLE typical-transactions'-worth of
 * native gas, based on the live fee estimate for this chain — not a fixed
 * dollar amount. On a cheap chain (gas costs fractions of a cent) this ends
 * up topping up literally cents, not dollars. Capped at MAX_TOPUP_USDC_AMOUNT
 * and floored at MIN_TOPUP_USDC_AMOUNT (below which a swap isn't worth the
 * 0x fee/slippage).
 *
 * Also fixes a previous bug: ensureAllowance() is now called before
 * building/sending the swap tx. This was missing entirely before — the swap
 * tx was being sent with zero Permit2 allowance, causing a silent
 * CALL_EXCEPTION even when the wallet had plenty of stablecoin balance.
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

  // Figure out how much native gas we actually need, in USD terms, rather
  // than reaching for a flat dollar figure.
  const typicalTxCostEth = await estimateTypicalTxCostEth(provider).catch(() => null);
  let desiredTopupUsd = MIN_TOPUP_USDC_AMOUNT;
  if (typicalTxCostEth !== null) {
    const nativeUsdPrice = await getNativeUsdPriceForGas(chain.nativeSymbol).catch(() => null);
    if (nativeUsdPrice) {
      const neededEth = Math.max(0, typicalTxCostEth * TOPUP_TX_MULTIPLE - nativeBalanceNum);
      desiredTopupUsd = neededEth * nativeUsdPrice;
    }
  }
  const topupTargetUsd = Math.min(Math.max(desiredTopupUsd, MIN_TOPUP_USDC_AMOUNT), MAX_TOPUP_USDC_AMOUNT);

  console.log(
    `[gas debug] chain=${chainKey} wallet=${walletAddress} nativeBalance=${nativeBalanceNum} ` +
    `stableDecimals=${usdcDecimals} stableBalanceNum=${usdcBalanceNum} topupTargetUsd=${topupTargetUsd.toFixed(4)}`
  );

  if (usdcBalanceNum < MIN_TOPUP_USDC_AMOUNT) {
    throw new Error(
      `Wallet is low on ${chain.nativeSymbol} (${nativeBalanceNum.toFixed(5)}) and doesn't hold enough ${chain.stableSymbol || 'USDC'} ` +
      `(${usdcBalanceNum.toFixed(2)}) on ${chain.name} to auto-top-up. Add ${chain.stableSymbol || 'USDC'} to this wallet on ${chain.name}.`
    );
  }

  // Never request more than the wallet actually holds.
  const topupAmount = Math.min(topupTargetUsd, usdcBalanceNum);
  const sellAmount = ethers.parseUnits(topupAmount.toFixed(usdcDecimals), usdcDecimals).toString();

  console.log(`[gas debug] attempting top-up swap of ${topupAmount.toFixed(4)} ${chain.stableSymbol || 'USDC'} -> ${chain.nativeSymbol} on ${chain.name}`);

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

  return { toppedUp: true, txHash: txResponse.hash, amountUsd: topupAmount };
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
