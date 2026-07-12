import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { getSolanaQuote, buildSolanaSwapTx, sendSolanaSwap } from './solana-swap.js';
import { ensureAllowance, getDecimals, getTokenBalance } from './erc20.js';
import { ensureGasReserve, ensureSolanaGasReserve } from './gas.js';
import { shortAddr } from './wallet.js';
import {
  getSettings, createPendingTrade, markPendingTradeSubmitted, markPendingTradeDone,
  recordTrade, getPosition, getAllPositions, getActiveWallet, getActiveChain,
} from './storage.js';
import { sendAdminAlert } from './alerts.js';
import { getChain, getEvmProvider, isSolanaChain, explorerTxUrl } from './chains.js';
import {
  keypairFromPrivateKey, getSplTokenBalanceRaw, getSplTokenDecimals, transferSolanaUsdc,
} from './solana.js';
import { gasMultiplierFor, tradesInFlight } from './state.js';
import { friendlyErrorMessage, getFreshQuote } from './format.js';
import { mainMenu, walletsMenu, renderTokenCard } from './menus.js';
import { getTokenMarketData, fmtUsd } from './price.js';
import { generateSellPnlCard } from './pnl-card.js';

function walletAddressForChain(wallet, chainKey) {
  return isSolanaChain(chainKey) ? wallet.solAddress : wallet.address;
}

function toRawUsdc(chainKey, usdcAmount) {
  const decimals = getChain(chainKey).usdcDecimals;
  if (isSolanaChain(chainKey)) return BigInt(Math.round(usdcAmount * 10 ** decimals));
  return ethers.parseUnits(usdcAmount.toString(), decimals).toString();
}

async function resolveSellAmountRaw(chainKey, tokenAddress, walletAddress, pct) {
  if (isSolanaChain(chainKey)) {
    const [rawBalance, decimals] = await Promise.all([
      getSplTokenBalanceRaw(tokenAddress, walletAddress),
      getSplTokenDecimals(tokenAddress).catch(() => 6),
    ]);
    if (rawBalance <= 0n) return { rawAmount: 0n, decimals, humanAmount: 0 };
    const pctBps = BigInt(Math.round(pct * 100));
    const rawAmount = pctBps >= 10000n ? rawBalance : (rawBalance * pctBps) / 10000n;
    const humanAmount = Number(rawAmount) / 10 ** decimals;
    return { rawAmount, decimals, humanAmount };
  }

  const provider = getEvmProvider(chainKey);
  const decimals = await getDecimals(provider, tokenAddress).catch(() => 18);
  const rawBalance = await getTokenBalance(provider, tokenAddress, walletAddress);
  if (rawBalance <= 0n) return { rawAmount: 0n, decimals, humanAmount: 0 };
  const pctBps = BigInt(Math.round(pct * 100));
  const rawAmount = pctBps >= 10000n ? rawBalance : (rawBalance * pctBps) / 10000n;
  const humanAmount = Number(ethers.formatUnits(rawAmount, decimals));
  return { rawAmount, decimals, humanAmount };
}

const LOCKED_ERROR = 'Another trade is already in progress for this account — will retry.';

export async function performBuyCore(uid, wallet, chainKey, tokenAddress, usdcAmount) {
  if (tradesInFlight.has(uid)) return { ok: false, error: LOCKED_ERROR, locked: true, walletName: wallet.name };

  const { maxBuyUsdc } = getSettings(uid);
  if (usdcAmount > maxBuyUsdc) {
    return { ok: false, error: `Buy of ${fmtUsd(usdcAmount)} exceeds max buy size (${fmtUsd(maxBuyUsdc)}).`, walletName: wallet.name };
  }

  tradesInFlight.add(uid);
  let pendingTradeId;
  try {
    const address = walletAddressForChain(wallet, chainKey);
    pendingTradeId = createPendingTrade({ uid, walletId: wallet.id, chain: chainKey, tokenAddress, side: 'buy', amount: usdcAmount });

    if (isSolanaChain(chainKey)) {
      await ensureSolanaGasReserve(address);
      const keypair = keypairFromPrivateKey(wallet.solPrivateKey);
      const sellAmountRaw = toRawUsdc(chainKey, usdcAmount);

      const quote = await getSolanaQuote({ sellToken: 'USDC', buyToken: tokenAddress, sellAmountRaw });
      const tx = await buildSolanaSwapTx(quote, keypair.publicKey);
      const { signature } = await sendSolanaSwap(keypair, tx);
      markPendingTradeSubmitted(pendingTradeId, signature);
      markPendingTradeDone(pendingTradeId, 'confirmed');

      const buyDecimals = await getSplTokenDecimals(tokenAddress).catch(() => 6);
      const tokenAmount = Number(quote.outAmount) / 10 ** buyDecimals;
      const entryMarket = await getTokenMarketData(tokenAddress, chainKey).catch(() => null);
      recordTrade(uid, wallet.id, chainKey, tokenAddress, 'buy', tokenAmount, usdcAmount, entryMarket?.marketCap ?? null);

      return { ok: true, txHash: signature, walletName: wallet.name, entryMcap: entryMarket?.marketCap ?? null };
    }

    const chain = getChain(chainKey);
    const signer = new ethers.Wallet(wallet.privateKey, getEvmProvider(chainKey));
    await ensureGasReserve(chainKey, signer, address);

    const sellAmount = toRawUsdc(chainKey, usdcAmount);
    const { slippageBps } = getSettings(uid);
    const quoteParams = { sellToken: chain.usdcAddress, buyToken: tokenAddress, sellAmount, taker: address, slippageBps };

    await ensureAllowance(signer, chain.usdcAddress, BigInt(sellAmount));

    let quote = await getQuote({ chainKey, ...quoteParams });
    const fetchedAt = Date.now();
    quote = await getFreshQuote(chainKey, quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    markPendingTradeDone(pendingTradeId, 'confirmed');

    const entryMarket = await getTokenMarketData(tokenAddress, chainKey).catch(() => null);
    recordTrade(uid, wallet.id, chainKey, tokenAddress, 'buy', Number(quote.buyAmountFormatted), usdcAmount, entryMarket?.marketCap ?? null);

    return { ok: true, txHash: txResponse.hash, walletName: wallet.name, entryMcap: entryMarket?.marketCap ?? null };
  } catch (err) {
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    return { ok: false, error: friendlyErrorMessage(err), walletName: wallet.name };
  } finally {
    tradesInFlight.delete(uid);
  }
}

export async function performSellCore(uid, wallet, chainKey, tokenAddress, pct) {
  if (tradesInFlight.has(uid)) return { ok: false, error: LOCKED_ERROR, locked: true, walletName: wallet.name };
  tradesInFlight.add(uid);

  let pendingTradeId;
  try {
    const pos = getPosition(uid, wallet.id, chainKey, tokenAddress);
    if (!pos || pos.tokenAmount <= 0) return { ok: false, error: 'No position to sell.', walletName: wallet.name };

    const address = walletAddressForChain(wallet, chainKey);
    const { rawAmount, humanAmount: tokenAmount } = await resolveSellAmountRaw(chainKey, tokenAddress, address, pct);
    if (rawAmount <= 0n) return { ok: false, error: 'No on-chain token balance found to sell.', walletName: wallet.name };

    pendingTradeId = createPendingTrade({ uid, walletId: wallet.id, chain: chainKey, tokenAddress, side: 'sell', amount: tokenAmount });

    if (isSolanaChain(chainKey)) {
      await ensureSolanaGasReserve(address);
      const keypair = keypairFromPrivateKey(wallet.solPrivateKey);

      const quote = await getSolanaQuote({ sellToken: tokenAddress, buyToken: 'USDC', sellAmountRaw: rawAmount });
      const tx = await buildSolanaSwapTx(quote, keypair.publicKey);
      const { signature } = await sendSolanaSwap(keypair, tx);
      markPendingTradeSubmitted(pendingTradeId, signature);
      markPendingTradeDone(pendingTradeId, 'confirmed');

      const usdcReceived = Number(quote.outAmount) / 10 ** getChain('solana').usdcDecimals;
      const exitMarket = await getTokenMarketData(tokenAddress, chainKey).catch(() => null);
      recordTrade(uid, wallet.id, chainKey, tokenAddress, 'sell', tokenAmount, usdcReceived, exitMarket?.marketCap ?? null);

      return {
        ok: true, txHash: signature, walletName: wallet.name, usdcReceived,
        entryMcap: pos.entryMcap ?? null, exitMcap: exitMarket?.marketCap ?? null,
      };
    }

    const chain = getChain(chainKey);
    const signer = new ethers.Wallet(wallet.privateKey, getEvmProvider(chainKey));
    await ensureGasReserve(chainKey, signer, address);

    const { slippageBps } = getSettings(uid);
    await ensureAllowance(signer, tokenAddress, rawAmount);

    const quoteParams = { sellToken: tokenAddress, buyToken: chain.usdcAddress, sellAmount: rawAmount.toString(), taker: address, slippageBps };
    let quote = await getQuote({ chainKey, ...quoteParams });
    const fetchedAt = Date.now();
    quote = await getFreshQuote(chainKey, quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    markPendingTradeDone(pendingTradeId, 'confirmed');

    const exitMarket = await getTokenMarketData(tokenAddress, chainKey).catch(() => null);
    const usdcReceived = Number(quote.buyAmountFormatted);
    recordTrade(uid, wallet.id, chainKey, tokenAddress, 'sell', tokenAmount, usdcReceived, exitMarket?.marketCap ?? null);

    return {
      ok: true, txHash: txResponse.hash, walletName: wallet.name, usdcReceived,
      entryMcap: pos.entryMcap ?? null, exitMcap: exitMarket?.marketCap ?? null,
    };
  } catch (err) {
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    return { ok: false, error: friendlyErrorMessage(err), walletName: wallet.name };
  } finally {
    tradesInFlight.delete(uid);
  }
}

export async function executeBuy(ctx, uid, tokenAddress, usdcAmount) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
  const chainKey = getActiveChain(uid);
  const chain = getChain(chainKey);

  await ctx.reply(`Buying ${fmtUsd(usdcAmount)} worth on ${chain.name}... fetching quote.`);
  const result = await performBuyCore(uid, w, chainKey, tokenAddress, usdcAmount);

  if (!result.ok) {
    await ctx.reply(`❌ Trade failed: ${result.error}`, mainMenu());
    if (!result.locked) await sendAdminAlert(ctx.telegram, `Buy failed for user ${uid} on ${chain.name}/${tokenAddress}: ${result.error}`);
    return;
  }

  const txLink = explorerTxUrl(chainKey, result.txHash);
  const mcapLine = result.entryMcap != null ? `\nEntry mcap: ${fmtUsd(result.entryMcap)}` : '';
  await ctx.reply(
    (txLink ? `✅ Confirmed on ${chain.name} — [view transaction](${txLink})` : `✅ Confirmed on ${chain.name}`) + mcapLine,
    { parse_mode: 'Markdown' }
  );
  const { text, markup } = await renderTokenCard(uid, tokenAddress);
  await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
}

export async function executeSell(ctx, uid, tokenAddress, pct) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
  const chainKey = getActiveChain(uid);
  const chain = getChain(chainKey);

  const pos = getPosition(uid, w.id, chainKey, tokenAddress);
  if (!pos || pos.tokenAmount <= 0) return ctx.reply('No position to sell.', mainMenu());
  const costBasisSold = pos.costUsdc * (pct / 100);

  await ctx.reply(`Selling ${pct}% on ${chain.name}... fetching quote.`);
  const result = await performSellCore(uid, w, chainKey, tokenAddress, pct);

  if (!result.ok) {
    await ctx.reply(`❌ Trade failed: ${result.error}`, mainMenu());
    if (!result.locked) await sendAdminAlert(ctx.telegram, `Sell failed for user ${uid} on ${chain.name}/${tokenAddress}: ${result.error}`);
    return;
  }

  const txLink = explorerTxUrl(chainKey, result.txHash);
  const mcapLines = [];
  if (result.entryMcap != null) mcapLines.push(`Entry mcap: ${fmtUsd(result.entryMcap)}`);
  if (result.exitMcap != null) mcapLines.push(`Exit mcap: ${fmtUsd(result.exitMcap)}`);
  const mcapBlock = mcapLines.length ? `\n${mcapLines.join('\n')}` : '';

  await ctx.reply(
    (txLink ? `✅ Confirmed on ${chain.name} — [view transaction](${txLink})` : `✅ Confirmed on ${chain.name}`) + mcapBlock,
    { parse_mode: 'Markdown' }
  );

  try {
    const pnlUsdc = result.usdcReceived - costBasisSold;
    const pnlPct = costBasisSold > 0 ? (pnlUsdc / costBasisSold) * 100 : 0;
    const market = await getTokenMarketData(tokenAddress, chainKey).catch(() => null);
    const symbol = market?.symbol ?? shortAddr(tokenAddress);
    const cardBuffer = await generateSellPnlCard({
      uid, symbol, chainKey, pct, pnlUsdc, pnlPct,
      entryMcap: result.entryMcap ?? null, exitMcap: result.exitMcap ?? null,
    });
    await ctx.replyWithPhoto({ source: cardBuffer });
  } catch (cardErr) {
    console.error('PnL card generation failed:', cardErr.message);
  }

  const { text, markup } = await renderTokenCard(uid, tokenAddress);
  await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
}

export async function performUsdcTransferCore(uid, chainKey, sourceWallet, toAddress, usdcAmount) {
  try {
    if (isSolanaChain(chainKey)) {
      const keypair = keypairFromPrivateKey(sourceWallet.solPrivateKey);
      await ensureSolanaGasReserve(sourceWallet.solAddress);
      const rawAmount = toRawUsdc(chainKey, usdcAmount);
      const { signature } = await transferSolanaUsdc(keypair, toAddress, rawAmount);
      return { ok: true, txHash: signature };
    }

    const chain = getChain(chainKey);
    const signer = new ethers.Wallet(sourceWallet.privateKey, getEvmProvider(chainKey));
    await ensureGasReserve(chainKey, signer, sourceWallet.address);
    const rawAmount = ethers.parseUnits(usdcAmount.toString(), chain.usdcDecimals);
    const { transferToken } = await import('./erc20.js');
    const receipt = await transferToken(signer, chain.usdcAddress, toAddress, rawAmount);
    return { ok: true, txHash: receipt.hash };
  } catch (err) {
    return { ok: false, error: friendlyErrorMessage(err) };
  }
}

export async function distributeUsdc(uid, chainKey, sourceWallet, targets, usdcAmount) {
  const results = [];
  for (const target of targets) {
    const toAddress = isSolanaChain(chainKey) ? target.solAddress : target.address;
    const result = await performUsdcTransferCore(uid, chainKey, sourceWallet, toAddress, usdcAmount);
    results.push({ ...result, walletName: target.name });
  }
  return results;
}

export async function estimateTransferGasReserve(chainKey, sourceWallet, count) {
  try {
    if (isSolanaChain(chainKey)) return 0;
    const provider = getEvmProvider(chainKey);
    const balance = await provider.getBalance(sourceWallet.address);
    const balanceNum = Number(ethers.formatEther(balance));
    const { MIN_GAS_ETH_RESERVE, GAS_TOPUP_USDC_AMOUNT } = await import('./config.js');
    if (balanceNum >= MIN_GAS_ETH_RESERVE) return 0;
    return GAS_TOPUP_USDC_AMOUNT;
  } catch {
    const { GAS_TOPUP_USDC_AMOUNT } = await import('./config.js');
    return GAS_TOPUP_USDC_AMOUNT;
  }
}

async function transferSolanaToken(keypair, mintAddress, toAddress, rawAmount) {
  const { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
  const { Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
  const { getSolanaConnection } = await import('./solana.js');
  const connection = getSolanaConnection();
  const mint = new PublicKey(mintAddress);
  const dest = new PublicKey(toAddress);
  const sourceAta = await getAssociatedTokenAddress(mint, keypair.publicKey);
  const destAta = await getAssociatedTokenAddress(mint, dest);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, destAta, dest, mint),
    createTransferInstruction(sourceAta, destAta, keypair.publicKey, rawAmount)
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
  return { signature };
}

/** Sweeps USDC + every tracked token from one wallet into destAddress, on ONE chain. */
export async function performCollectCore(uid, chainKey, sourceWallet, destAddress) {
  const results = [];
  const positions = getAllPositions(uid, sourceWallet.id, chainKey);

  if (isSolanaChain(chainKey)) {
    const keypair = keypairFromPrivateKey(sourceWallet.solPrivateKey);
    for (const pos of positions) {
      try {
        const rawBalance = await getSplTokenBalanceRaw(pos.tokenAddress, sourceWallet.solAddress);
        if (rawBalance <= 0n) continue;
        const { signature } = await transferSolanaToken(keypair, pos.tokenAddress, destAddress, rawBalance);
        results.push({ ok: true, label: shortAddr(pos.tokenAddress), txHash: signature });
      } catch (err) {
        results.push({ ok: false, label: shortAddr(pos.tokenAddress), error: friendlyErrorMessage(err) });
      }
    }
    try {
      const usdcBalance = await getSplTokenBalanceRaw(getChain('solana').usdcMint, sourceWallet.solAddress);
      if (usdcBalance > 0n) {
        const { signature } = await transferSolanaUsdc(keypair, destAddress, usdcBalance);
        results.push({ ok: true, label: 'USDC', txHash: signature });
      }
    } catch (err) {
      results.push({ ok: false, label: 'USDC', error: friendlyErrorMessage(err) });
    }
    return results;
  }

  const chain = getChain(chainKey);
  const provider = getEvmProvider(chainKey);
  const signer = new ethers.Wallet(sourceWallet.privateKey, provider);
  const { transferToken, getUsdcBalance } = await import('./erc20.js');

  for (const pos of positions) {
    try {
      await ensureGasReserve(chainKey, signer, sourceWallet.address);
      const onChainBalance = await getTokenBalance(provider, pos.tokenAddress, sourceWallet.address);
      if (onChainBalance <= 0n) continue;
      const receipt = await transferToken(signer, pos.tokenAddress, destAddress, onChainBalance);
      results.push({ ok: true, label: shortAddr(pos.tokenAddress), txHash: receipt.hash });
    } catch (err) {
      results.push({ ok: false, label: shortAddr(pos.tokenAddress), error: friendlyErrorMessage(err) });
    }
  }

  try {
    const usdcBalance = await getUsdcBalance(provider, chain.usdcAddress, sourceWallet.address);
    if (usdcBalance > 0n) {
      await ensureGasReserve(chainKey, signer, sourceWallet.address);
      const receipt = await transferToken(signer, chain.usdcAddress, destAddress, usdcBalance);
      results.push({ ok: true, label: 'USDC', txHash: receipt.hash });
    }
  } catch (err) {
    results.push({ ok: false, label: 'USDC', error: friendlyErrorMessage(err) });
  }

  return results;
}
