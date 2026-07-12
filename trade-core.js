import { ethers } from 'ethers';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { ensureAllowance, getDecimals, getTokenBalance, transferToken } from './erc20.js';
import { ensureGasReserve } from './gas.js';
import { shortAddr } from './wallet.js';
import { getSettings, createPendingTrade, markPendingTradeSubmitted, markPendingTradeDone, recordTrade, getPosition, getAllPositions } from './storage.js';
import { sendAdminAlert } from './alerts.js';
import {
  provider, USDC_ROBINHOOD_ADDRESS, USDC_DECIMALS, FALLBACK_GAS_LIMIT_TRANSFER,
  MIN_GAS_ETH_RESERVE, GAS_TOPUP_USDC_AMOUNT,
} from './config.js';
import { gasMultiplierFor, tradesInFlight } from './state.js';
import { explorerTxUrl, friendlyErrorMessage, getFreshQuote } from './format.js';
import { mainMenu, walletsMenu, renderTokenCard } from './menus.js';
import { getActiveWallet } from './storage.js';
import { getTokenMarketData, fmtUsd } from './price.js';
import { generateSellPnlCard } from './pnl-card.js';

// ---------- Sell amount resolution (raw on-chain, no float round-tripping) ----------
//
// Previously the sell amount was computed as `pos.tokenAmount * (pct/100)`
// (a JS float from our own locally-tracked cost-basis bookkeeping), then
// `.toFixed(decimals)` truncated it before parseUnits converted it to the
// raw smallest-unit amount. Two problems with that:
//   1. Floats can't exactly represent most on-chain balances, so toFixed()
//      routinely rounds DOWN, leaving a small remainder unsold even on a
//      "100%" sell.
//   2. The locally tracked pos.tokenAmount can drift from the wallet's real
//      balance (fee-on-transfer tokens, missed trades, manual transfers),
//      so "100%" only ever meant "100% of what our DB thinks we have".
//
// Fix: read the wallet's actual on-chain balance (raw bigint, smallest
// unit) right before selling, and derive the sell amount from THAT via
// integer math only — never round-tripping through a float. A 100% sell now
// always sells the wallet's exact live balance, leaving zero dust.
async function resolveSellAmountRaw(tokenAddress, walletAddress, pct) {
  const decimals = await getDecimals(provider, tokenAddress).catch(() => 18);
  const rawBalance = await getTokenBalance(provider, tokenAddress, walletAddress);

  if (rawBalance <= 0n) {
    return { rawAmount: 0n, decimals, humanAmount: 0 };
  }

  // Integer-only percentage math: pct may have up to 2 decimal places
  // (e.g. 33.33), so scale by 10000 and floor-divide — avoids any float
  // multiplication of the raw balance.
  const pctBps = BigInt(Math.round(pct * 100)); // e.g. 100% -> 10000, 33.33% -> 3333
  const rawAmount = pctBps >= 10000n
    ? rawBalance // 100%+ (or rounding over) always means "sell the whole live balance"
    : (rawBalance * pctBps) / 10000n;

  const humanAmount = Number(ethers.formatUnits(rawAmount, decimals));
  return { rawAmount, decimals, humanAmount };
}

/** Converts a human USDC amount (e.g. 50, 12.5) into raw smallest-unit string for 0x. */
function toRawUsdc(usdcAmount) {
  return ethers.parseUnits(usdcAmount.toString(), USDC_DECIMALS).toString();
}

// ---------- Shared trade execution (interactive, ctx-based) ----------

export async function executeBuy(ctx, uid, tokenAddress, usdcAmount) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

  const { maxBuyUsdc } = getSettings(uid);
  if (usdcAmount > maxBuyUsdc) {
    return ctx.reply(`❌ ${fmtUsd(usdcAmount)} exceeds your max buy size (${fmtUsd(maxBuyUsdc)}). Adjust it in Settings if this was intentional.`, mainMenu());
  }

  if (tradesInFlight.has(uid)) {
    return ctx.reply('⏳ A trade is already in progress — please wait for it to finish.');
  }
  tradesInFlight.add(uid);

  let pendingTradeId;
  try {
    await ctx.reply(`Buying ${fmtUsd(usdcAmount)} worth... fetching quote.`);
    const signer = new ethers.Wallet(w.privateKey, provider);

    await ensureGasReserve(signer, w.address);

    const sellAmount = toRawUsdc(usdcAmount);
    const { slippageBps } = getSettings(uid);
    const quoteParams = { sellToken: USDC_ROBINHOOD_ADDRESS, buyToken: tokenAddress, sellAmount, taker: w.address, slippageBps };

    pendingTradeId = createPendingTrade({ uid, walletId: w.id, tokenAddress, side: 'buy', amount: usdcAmount });

    await ensureAllowance(signer, USDC_ROBINHOOD_ADDRESS, BigInt(sellAmount));

    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse, receipt, bumped } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    const txLink = explorerTxUrl(txResponse.hash);
    if (bumped) await ctx.reply('⛽ Network was congested — resubmitted with higher gas.');
    markPendingTradeDone(pendingTradeId, 'confirmed');

    const entryMarket = await getTokenMarketData(tokenAddress).catch(() => null);
    recordTrade(uid, w.id, tokenAddress, 'buy', Number(quote.buyAmountFormatted), usdcAmount, entryMarket?.marketCap ?? null);

    const mcapLine = entryMarket?.marketCap != null ? `\nEntry mcap: ${fmtUsd(entryMarket.marketCap)}` : '';
    await ctx.reply(
      (txLink ? `✅ Confirmed — [view transaction](${txLink})` : `✅ Confirmed in block ${receipt.blockNumber}`) + mcapLine,
      { parse_mode: 'Markdown' }
    );
    const { text, markup } = await renderTokenCard(uid, tokenAddress);
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  } catch (err) {
    console.error(err);
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    await ctx.reply(`❌ Trade failed: ${friendlyErrorMessage(err)}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Buy failed for user ${uid} on ${tokenAddress}: ${err.message}`);
  } finally {
    tradesInFlight.delete(uid);
  }
}

export async function executeSell(ctx, uid, tokenAddress, pct) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
  const pos = getPosition(uid, w.id, tokenAddress);
  if (!pos || pos.tokenAmount <= 0) return ctx.reply('No position to sell.', mainMenu());

  if (tradesInFlight.has(uid)) {
    return ctx.reply('⏳ A trade is already in progress — please wait for it to finish.');
  }
  tradesInFlight.add(uid);

  const entryMcap = pos.entryMcap;
  // Proportional cost basis for the slice being sold, from our tracked cost
  // basis (still float-based — fine here since it's just PnL display, not
  // an on-chain amount). The actual sell amount is resolved separately from
  // the live on-chain balance below.
  const costBasisSold = pos.costUsdc * (pct / 100);
  let pendingTradeId;
  try {
    await ctx.reply(`Selling ${pct}%... fetching quote.`);
    const signer = new ethers.Wallet(w.privateKey, provider);

    await ensureGasReserve(signer, w.address);

    const { rawAmount, humanAmount: tokenAmount } = await resolveSellAmountRaw(tokenAddress, w.address, pct);
    if (rawAmount <= 0n) {
      tradesInFlight.delete(uid);
      return ctx.reply('No on-chain token balance found to sell.', mainMenu());
    }
    const sellAmount = rawAmount.toString();

    const { slippageBps } = getSettings(uid);

    pendingTradeId = createPendingTrade({ uid, walletId: w.id, tokenAddress, side: 'sell', amount: tokenAmount });

    const approvalReceipt = await ensureAllowance(signer, tokenAddress, rawAmount);
    if (approvalReceipt) await ctx.reply('Approved token for trading (one-time step). Continuing...');

    const quoteParams = { sellToken: tokenAddress, buyToken: USDC_ROBINHOOD_ADDRESS, sellAmount, taker: w.address, slippageBps };
    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse, receipt, bumped } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    const txLink = explorerTxUrl(txResponse.hash);
    if (bumped) await ctx.reply('⛽ Network was congested — resubmitted with higher gas.');
    markPendingTradeDone(pendingTradeId, 'confirmed');

    const exitMarket = await getTokenMarketData(tokenAddress).catch(() => null);
    const usdcReceived = Number(quote.buyAmountFormatted);
    recordTrade(uid, w.id, tokenAddress, 'sell', tokenAmount, usdcReceived, exitMarket?.marketCap ?? null);

    const mcapLines = [];
    if (entryMcap != null) mcapLines.push(`Entry mcap: ${fmtUsd(entryMcap)}`);
    if (exitMarket?.marketCap != null) mcapLines.push(`Exit mcap: ${fmtUsd(exitMarket.marketCap)}`);
    const mcapBlock = mcapLines.length ? `\n${mcapLines.join('\n')}` : '';

    await ctx.reply(
      (txLink ? `✅ Confirmed — [view transaction](${txLink})` : `✅ Confirmed in block ${receipt.blockNumber}`) + mcapBlock,
      { parse_mode: 'Markdown' }
    );

    // ---- PnL flex card ----
    // Best-effort: a card-generation failure (missing NFT asset, sharp
    // error, etc.) should never block the trade confirmation the user
    // actually cares about.
    try {
      const pnlUsdc = usdcReceived - costBasisSold;
      const pnlPct = costBasisSold > 0 ? (pnlUsdc / costBasisSold) * 100 : 0;
      const symbol = exitMarket?.symbol ?? shortAddr(tokenAddress);
      const cardBuffer = await generateSellPnlCard({
        uid, symbol, pct, pnlUsdc, pnlPct,
        entryMcap: entryMcap ?? null,
        exitMcap: exitMarket?.marketCap ?? null,
      });
      await ctx.replyWithPhoto({ source: cardBuffer });
    } catch (cardErr) {
      console.error('PnL card generation failed:', cardErr.message);
    }

    const { text, markup } = await renderTokenCard(uid, tokenAddress);
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  } catch (err) {
    console.error(err);
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    await ctx.reply(`❌ Trade failed: ${friendlyErrorMessage(err)}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Sell failed for user ${uid} on ${tokenAddress}: ${err.message}`);
  } finally {
    tradesInFlight.delete(uid);
  }
}

// ---------- Headless trade execution (poller/batch-triggered, no ctx) ----------
//
// IMPORTANT: these share the SAME tradesInFlight lock as executeBuy/executeSell.
// Without this, a TP/SL or limit-order poller firing at the same moment as a
// manual trade (or two headless calls overlapping) can fetch the same nonce
// via signer.getNonce() and cause one transaction to silently replace/drop
// the other. Callers (pollers.js, bot.js batch handlers) should treat a
// `{ ok: false, error: 'locked' }`-style result as "try again next cycle",
// not as a permanent failure.
//
// NOTE: headless sells (batch sell, TP/SL, limit orders) intentionally do
// NOT generate a PnL card — only the interactive executeSell path does, to
// keep this in scope. Revisit if you want cards on those too.

const LOCKED_ERROR = 'Another trade is already in progress for this account — will retry.';

export async function performBuyCore(uid, wallet, tokenAddress, usdcAmount) {
  if (tradesInFlight.has(uid)) {
    return { ok: false, error: LOCKED_ERROR, locked: true, walletName: wallet.name };
  }

  // Re-check maxBuyUsdc here too (not just at order-creation time) — settings
  // may have been lowered between when a limit order / batch buy was queued
  // and when this actually fires. Without this, headless callers (the limit
  // order poller in pollers.js) could execute a buy that bypasses the user's
  // configured spend cap entirely.
  const { maxBuyUsdc } = getSettings(uid);
  if (usdcAmount > maxBuyUsdc) {
    return {
      ok: false,
      error: `Buy of ${fmtUsd(usdcAmount)} exceeds max buy size (${fmtUsd(maxBuyUsdc)}).`,
      walletName: wallet.name,
    };
  }

  tradesInFlight.add(uid);

  let pendingTradeId;
  try {
    const signer = new ethers.Wallet(wallet.privateKey, provider);
    await ensureGasReserve(signer, wallet.address);

    const sellAmount = toRawUsdc(usdcAmount);
    const { slippageBps } = getSettings(uid);
    const quoteParams = { sellToken: USDC_ROBINHOOD_ADDRESS, buyToken: tokenAddress, sellAmount, taker: wallet.address, slippageBps };

    pendingTradeId = createPendingTrade({ uid, walletId: wallet.id, tokenAddress, side: 'buy', amount: usdcAmount });

    await ensureAllowance(signer, USDC_ROBINHOOD_ADDRESS, BigInt(sellAmount));

    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    markPendingTradeDone(pendingTradeId, 'confirmed');

    const entryMarket = await getTokenMarketData(tokenAddress).catch(() => null);
    recordTrade(uid, wallet.id, tokenAddress, 'buy', Number(quote.buyAmountFormatted), usdcAmount, entryMarket?.marketCap ?? null);

    return { ok: true, txHash: txResponse.hash, walletName: wallet.name, entryMcap: entryMarket?.marketCap ?? null };
  } catch (err) {
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    return { ok: false, error: friendlyErrorMessage(err), walletName: wallet.name };
  } finally {
    tradesInFlight.delete(uid);
  }
}

export async function performSellCore(uid, wallet, tokenAddress, pct) {
  if (tradesInFlight.has(uid)) {
    return { ok: false, error: LOCKED_ERROR, locked: true, walletName: wallet.name };
  }
  tradesInFlight.add(uid);

  let pendingTradeId;
  try {
    const pos = getPosition(uid, wallet.id, tokenAddress);
    if (!pos || pos.tokenAmount <= 0) return { ok: false, error: 'No position to sell.', walletName: wallet.name };

    const signer = new ethers.Wallet(wallet.privateKey, provider);
    await ensureGasReserve(signer, wallet.address);

    const { rawAmount, humanAmount: tokenAmount } = await resolveSellAmountRaw(tokenAddress, wallet.address, pct);
    if (rawAmount <= 0n) {
      return { ok: false, error: 'No on-chain token balance found to sell.', walletName: wallet.name };
    }
    const sellAmount = rawAmount.toString();

    const { slippageBps } = getSettings(uid);

    pendingTradeId = createPendingTrade({ uid, walletId: wallet.id, tokenAddress, side: 'sell', amount: tokenAmount });

    await ensureAllowance(signer, tokenAddress, rawAmount);

    const quoteParams = { sellToken: tokenAddress, buyToken: USDC_ROBINHOOD_ADDRESS, sellAmount, taker: wallet.address, slippageBps };
    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    markPendingTradeDone(pendingTradeId, 'confirmed');

    const exitMarket = await getTokenMarketData(tokenAddress).catch(() => null);
    recordTrade(uid, wallet.id, tokenAddress, 'sell', tokenAmount, Number(quote.buyAmountFormatted), exitMarket?.marketCap ?? null);

    return {
      ok: true,
      txHash: txResponse.hash,
      walletName: wallet.name,
      usdcReceived: Number(quote.buyAmountFormatted),
      entryMcap: pos.entryMcap ?? null,
      exitMcap: exitMarket?.marketCap ?? null,
    };
  } catch (err) {
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    return { ok: false, error: friendlyErrorMessage(err), walletName: wallet.name };
  } finally {
    tradesInFlight.delete(uid);
  }
}

// ---------- Headless native ETH transfer (used internally for gas bookkeeping) ----------
// Same stuck-tx protection shape as swap.js/bridge.js: resubmit with bumped
// fees if the network is too slow, so a batch run can't hang forever.
// NOTE: this moves native ETH, not USDC — used internally for gas
// bookkeeping (e.g. sweeping leftover ETH during Batch Collect). User-facing
// fund/collect flows move USDC instead; see performUsdcTransferCore below.

export async function performTransferCore(uid, sourceWallet, toAddress, amountEth, gasMultiplier, { timeoutMs = 45_000, bumpPct = 20, maxAttempts = 4 } = {}) {
  try {
    const signer = new ethers.Wallet(sourceWallet.privateKey, provider);
    const nonce = await signer.getNonce();
    const feeData = await provider.getFeeData();
    const baseMaxFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
    const basePriorityFee = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei');
    const multBps = BigInt(Math.round(gasMultiplier * 1000));
    let maxFeePerGas = (baseMaxFee * multBps) / 1000n;
    let maxPriorityFeePerGas = (basePriorityFee * multBps) / 1000n;
    const value = ethers.parseEther(amountEth.toString());

    let lastTxResponse;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastTxResponse = await signer.sendTransaction({
        to: toAddress,
        value,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: FALLBACK_GAS_LIMIT_TRANSFER,
      });
      try {
        await lastTxResponse.wait(1, timeoutMs);
        return { ok: true, txHash: lastTxResponse.hash, bumped: attempt > 1 };
      } catch (err) {
        const timedOut = err.code === 'TIMEOUT' || err.message?.toLowerCase().includes('timeout');
        if (!timedOut || attempt === maxAttempts) throw err;
        maxFeePerGas = (maxFeePerGas * BigInt(100 + bumpPct)) / 100n;
        maxPriorityFeePerGas = (maxPriorityFeePerGas * BigInt(100 + bumpPct)) / 100n;
      }
    }
    throw new Error('performTransferCore: exhausted attempts'); // unreachable
  } catch (err) {
    return { ok: false, error: friendlyErrorMessage(err) };
  }
}

/**
 * Headless USDC transfer — used by Batch Fund / Batch Collect (balances are
 * USDC-denominated). Ensures the source wallet has gas before sending (via
 * ensureGasReserve, which auto-tops-up ETH from the wallet's own USDC if
 * needed), then does a plain ERC-20 transfer.
 */
export async function performUsdcTransferCore(uid, sourceWallet, toAddress, usdcAmount) {
  try {
    const signer = new ethers.Wallet(sourceWallet.privateKey, provider);
    await ensureGasReserve(signer, sourceWallet.address);
    const rawAmount = ethers.parseUnits(usdcAmount.toString(), USDC_DECIMALS);
    const receipt = await transferToken(signer, USDC_ROBINHOOD_ADDRESS, toAddress, rawAmount);
    return { ok: true, txHash: receipt.hash };
  } catch (err) {
    return { ok: false, error: friendlyErrorMessage(err) };
  }
}

export async function distributeUsdc(uid, sourceWallet, targets, usdcAmount) {
  const results = [];
  for (const target of targets) {
    const result = await performUsdcTransferCore(uid, sourceWallet, target.address, usdcAmount);
    results.push({ ...result, walletName: target.name });
  }
  return results;
}

/**
 * Preflight estimate of how much EXTRA USDC a batch-fund run might consume
 * beyond the amount actually being distributed. ensureGasReserve auto-tops-up
 * gas by swapping GAS_TOPUP_USDC_AMOUNT of the source wallet's own USDC into
 * ETH whenever its native ETH balance drops below MIN_GAS_ETH_RESERVE — that
 * top-up then covers many transfers, so this only needs to reserve for ONE
 * top-up if the source is already running low, not one per transfer.
 */
export async function estimateTransferGasReserve(sourceWallet, count) {
  try {
    const ethBalance = await provider.getBalance(sourceWallet.address);
    const ethBalanceNum = Number(ethers.formatEther(ethBalance));
    if (ethBalanceNum >= MIN_GAS_ETH_RESERVE) return 0;
    return GAS_TOPUP_USDC_AMOUNT;
  } catch {
    return GAS_TOPUP_USDC_AMOUNT; // can't check — be conservative
  }
}

// ---------- Headless collect: sweep USDC + every tracked token from one wallet ----------
// Used by Batch Collect. Tokens are sent first (each its own tx, gas paid out
// of the wallet's native balance via auto-top-up), then whatever USDC
// remains is swept last.

export async function performCollectCore(uid, sourceWallet, destAddress) {
  const results = [];
  const signer = new ethers.Wallet(sourceWallet.privateKey, provider);

  const positions = getAllPositions(uid, sourceWallet.id);
  for (const pos of positions) {
    try {
      await ensureGasReserve(signer, sourceWallet.address);
      const onChainBalance = await getTokenBalance(provider, pos.tokenAddress, sourceWallet.address);
      if (onChainBalance <= 0n) continue;
      const receipt = await transferToken(signer, pos.tokenAddress, destAddress, onChainBalance);
      results.push({ ok: true, label: shortAddr(pos.tokenAddress), txHash: receipt.hash });
    } catch (err) {
      results.push({ ok: false, label: shortAddr(pos.tokenAddress), error: friendlyErrorMessage(err) });
    }
  }

  try {
    const { getUsdcBalance } = await import('./erc20.js');
    const usdcBalance = await getUsdcBalance(sourceWallet.address);
    if (usdcBalance > 0n) {
      await ensureGasReserve(signer, sourceWallet.address);
      const receipt = await transferToken(signer, USDC_ROBINHOOD_ADDRESS, destAddress, usdcBalance);
      results.push({ ok: true, label: 'USDC', txHash: receipt.hash });
    }
  } catch (err) {
    results.push({ ok: false, label: 'USDC', error: friendlyErrorMessage(err) });
  }

  return results;
}
