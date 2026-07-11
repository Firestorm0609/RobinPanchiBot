import { ethers } from 'ethers';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { ensureAllowance, getDecimals, getTokenBalance, transferToken } from './erc20.js';
import { shortAddr } from './wallet.js';
import { getSettings, createPendingTrade, markPendingTradeSubmitted, markPendingTradeDone, recordTrade, getPosition, getAllPositions } from './storage.js';
import { sendAdminAlert } from './alerts.js';
import { provider, FALLBACK_GAS_LIMIT_TRANSFER } from './config.js';
import { gasMultiplierFor, tradesInFlight } from './state.js';
import { explorerTxUrl, friendlyErrorMessage, getFreshQuote } from './format.js';
import { mainMenu, walletsMenu, renderTokenCard } from './menus.js';
import { getActiveWallet } from './storage.js';

// ---------- Shared trade execution (interactive, ctx-based) ----------

export async function executeBuy(ctx, uid, tokenAddress, ethAmount) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

  const { maxBuyEth } = getSettings(uid);
  if (ethAmount > maxBuyEth) {
    return ctx.reply(`❌ ${ethAmount} ETH exceeds your max buy size (${maxBuyEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
  }

  if (tradesInFlight.has(uid)) {
    return ctx.reply('⏳ A trade is already in progress — please wait for it to finish.');
  }
  tradesInFlight.add(uid);

  let pendingTradeId;
  try {
    await ctx.reply(`Buying ${ethAmount} ETH worth... fetching quote.`);
    const sellAmount = ethers.parseEther(ethAmount.toString()).toString();
    const { slippageBps } = getSettings(uid);
    const quoteParams = { sellToken: 'ETH', buyToken: tokenAddress, sellAmount, taker: w.address, slippageBps };

    pendingTradeId = createPendingTrade({ uid, walletId: w.id, tokenAddress, side: 'buy', amount: ethAmount });

    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    const signer = new ethers.Wallet(w.privateKey, provider);
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse, receipt, bumped } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    const txLink = explorerTxUrl(txResponse.hash);
    if (bumped) await ctx.reply('⛽ Network was congested — resubmitted with higher gas.');
    markPendingTradeDone(pendingTradeId, 'confirmed');
    recordTrade(uid, w.id, tokenAddress, 'buy', Number(quote.buyAmountFormatted), ethAmount);
    await ctx.reply(
      txLink ? `✅ Confirmed — [view transaction](${txLink})` : `✅ Confirmed in block ${receipt.blockNumber}`,
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

  const tokenAmount = pos.tokenAmount * (pct / 100);
  let pendingTradeId;
  try {
    await ctx.reply(`Selling ${pct}%... fetching quote.`);

    const decimals = await getDecimals(provider, tokenAddress).catch(() => 18);
    const sellAmount = ethers.parseUnits(tokenAmount.toFixed(Math.min(decimals, 18)), decimals).toString();

    const { slippageBps } = getSettings(uid);
    const signer = new ethers.Wallet(w.privateKey, provider);

    pendingTradeId = createPendingTrade({ uid, walletId: w.id, tokenAddress, side: 'sell', amount: tokenAmount });

    const approvalReceipt = await ensureAllowance(signer, tokenAddress, BigInt(sellAmount));
    if (approvalReceipt) await ctx.reply('Approved token for trading (one-time step). Continuing...');

    const quoteParams = { sellToken: tokenAddress, buyToken: 'ETH', sellAmount, taker: w.address, slippageBps };
    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse, receipt, bumped } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    const txLink = explorerTxUrl(txResponse.hash);
    if (bumped) await ctx.reply('⛽ Network was congested — resubmitted with higher gas.');
    markPendingTradeDone(pendingTradeId, 'confirmed');
    recordTrade(uid, w.id, tokenAddress, 'sell', tokenAmount, Number(quote.buyAmountFormatted));
    await ctx.reply(
      txLink ? `✅ Confirmed — [view transaction](${txLink})` : `✅ Confirmed in block ${receipt.blockNumber}`,
      { parse_mode: 'Markdown' }
    );
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

export async function performBuyCore(uid, wallet, tokenAddress, ethAmount) {
  let pendingTradeId;
  try {
    const sellAmount = ethers.parseEther(ethAmount.toString()).toString();
    const { slippageBps } = getSettings(uid);
    const quoteParams = { sellToken: 'ETH', buyToken: tokenAddress, sellAmount, taker: wallet.address, slippageBps };

    pendingTradeId = createPendingTrade({ uid, walletId: wallet.id, tokenAddress, side: 'buy', amount: ethAmount });

    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    const signer = new ethers.Wallet(wallet.privateKey, provider);
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    markPendingTradeDone(pendingTradeId, 'confirmed');
    recordTrade(uid, wallet.id, tokenAddress, 'buy', Number(quote.buyAmountFormatted), ethAmount);
    return { ok: true, txHash: txResponse.hash, walletName: wallet.name };
  } catch (err) {
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    return { ok: false, error: friendlyErrorMessage(err), walletName: wallet.name };
  }
}

export async function performSellCore(uid, wallet, tokenAddress, pct) {
  let pendingTradeId;
  try {
    const pos = getPosition(uid, wallet.id, tokenAddress);
    if (!pos || pos.tokenAmount <= 0) return { ok: false, error: 'No position to sell.', walletName: wallet.name };

    const tokenAmount = pos.tokenAmount * (pct / 100);
    const decimals = await getDecimals(provider, tokenAddress).catch(() => 18);
    const sellAmount = ethers.parseUnits(tokenAmount.toFixed(Math.min(decimals, 18)), decimals).toString();

    const { slippageBps } = getSettings(uid);
    const signer = new ethers.Wallet(wallet.privateKey, provider);

    pendingTradeId = createPendingTrade({ uid, walletId: wallet.id, tokenAddress, side: 'sell', amount: tokenAmount });

    await ensureAllowance(signer, tokenAddress, BigInt(sellAmount));

    const quoteParams = { sellToken: tokenAddress, buyToken: 'ETH', sellAmount, taker: wallet.address, slippageBps };
    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    markPendingTradeDone(pendingTradeId, 'confirmed');
    recordTrade(uid, wallet.id, tokenAddress, 'sell', tokenAmount, Number(quote.buyAmountFormatted));
    return { ok: true, txHash: txResponse.hash, walletName: wallet.name, ethReceived: Number(quote.buyAmountFormatted) };
  } catch (err) {
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    return { ok: false, error: friendlyErrorMessage(err), walletName: wallet.name };
  }
}

// ---------- Headless native ETH transfer (used by Batch Fund / Batch Collect) ----------
// Same stuck-tx protection shape as swap.js/bridge.js: resubmit with bumped
// fees if the network is too slow, so a batch run can't hang forever.

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

    // Same stuck-tx protection as swap.js/bridge.js: resubmit the same nonce
    // with bumped fees if it doesn't confirm in time, instead of reporting a
    // false "failed" for a transfer that may still land later.
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
 * Estimated ETH to reserve for gas across `count` sequential native transfers,
 * so a batch fund run doesn't spend the whole source balance on principal and
 * leave nothing for the transactions themselves.
 */
export async function estimateTransferGasReserve(uid, count) {
  try {
    const mult = gasMultiplierFor(uid);
    const feeData = await provider.getFeeData();
    const baseFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
    const maxFee = (baseFee * BigInt(Math.round(mult * 1000))) / 1000n;
    const perTxWei = FALLBACK_GAS_LIMIT_TRANSFER * maxFee;
    return Number(ethers.formatEther(perTxWei * BigInt(count)));
  } catch {
    return 0; // fee data unavailable — fall back to no reserve rather than blocking the flow
  }
}

export async function distributeEth(uid, sourceWallet, targets, amountEth) {
  const results = [];
  const gasMultiplier = gasMultiplierFor(uid);
  for (const target of targets) {
    const result = await performTransferCore(uid, sourceWallet, target.address, amountEth, gasMultiplier);
    results.push({ ...result, walletName: target.name });
  }
  return results;
}

// ---------- Headless collect: sweep ETH + every tracked token from one wallet ----------
// Used by Batch Collect. Tokens are sent first (each its own tx, gas paid out
// of the wallet's native balance), then whatever native ETH remains is swept
// last, minus a gas reserve for that final transfer.

export async function performCollectCore(uid, sourceWallet, destAddress, gasMultiplier) {
  const results = [];
  const signer = new ethers.Wallet(sourceWallet.privateKey, provider);

  const positions = getAllPositions(uid, sourceWallet.id);
  for (const pos of positions) {
    try {
      const onChainBalance = await getTokenBalance(provider, pos.tokenAddress, sourceWallet.address);
      if (onChainBalance <= 0n) continue;
      const receipt = await transferToken(signer, pos.tokenAddress, destAddress, onChainBalance);
      results.push({ ok: true, label: shortAddr(pos.tokenAddress), txHash: receipt.hash });
    } catch (err) {
      results.push({ ok: false, label: shortAddr(pos.tokenAddress), error: friendlyErrorMessage(err) });
    }
  }

  try {
    const balance = await provider.getBalance(sourceWallet.address);
    const feeData = await provider.getFeeData();
    const baseFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
    const maxFeePerGas = (baseFee * BigInt(Math.round(gasMultiplier * 1000))) / 1000n;
    const gasReserve = FALLBACK_GAS_LIMIT_TRANSFER * maxFeePerGas;
    const sendable = balance - gasReserve;

    if (sendable > 0n) {
      const amountEth = Number(ethers.formatEther(sendable));
      const result = await performTransferCore(uid, sourceWallet, destAddress, amountEth, gasMultiplier);
      results.push(result.ok
        ? { ok: true, label: 'Robinhood ETH', txHash: result.txHash }
        : { ok: false, label: 'Robinhood ETH', error: result.error });
    }
  } catch (err) {
    results.push({ ok: false, label: 'Robinhood ETH', error: friendlyErrorMessage(err) });
  }

  return results;
}
