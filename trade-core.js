import { ethers } from 'ethers';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { getSolanaQuote, buildSolanaSwapTx, sendSolanaSwap } from './solana-swap.js';
import { getBridgeQuote, summarizeBridgeQuote, executeBridge } from './bridge.js';
import { ensureAllowance, getDecimals, getTokenBalance } from './erc20.js';
import { ensureGasReserve, ensureSolanaGasReserve } from './gas.js';
import { shortAddr } from './wallet.js';
import {
  getSettings, createPendingTrade, markPendingTradeSubmitted, markPendingTradeDone,
  markPendingTradeBridging, markPendingTradeBridged, markPendingTradeSwapping,
  recordTrade, getPosition, getActiveWallet, getActiveChain,
} from './storage.js';
import { sendAdminAlert } from './alerts.js';
import {
  getChain, getEvmProvider, isSolanaChain, explorerTxUrl, getStableDecimals, ALL_CHAIN_KEYS,
} from './chains.js';
import {
  keypairFromPrivateKey, getSplTokenBalanceRaw, getSplTokenDecimals,
} from './solana.js';
import { getBondingCurveState, executePumpFunBuy, executePumpFunSell } from './pumpfun.js';
import { gasMultiplierFor, tradesInFlight } from './state.js';
import {
  friendlyErrorMessage, getFreshQuote, getChainUsdcBalance,
} from './format.js';
import { mainMenu, walletsMenu, renderTokenCard } from './menus.js';
import { getTokenMarketData, fmtUsd } from './price.js';
import { generateSellPnlCard } from './pnl-card.js';
import { MIN_BRIDGE_USD, BRIDGE_SHORTFALL_BUFFER_PCT } from './config.js';

function walletAddressForChain(wallet, chainKey) {
  return isSolanaChain(chainKey) ? wallet.solAddress : wallet.address;
}

/** Converts a human-readable USD amount into the chain's stablecoin's raw (smallest-unit) amount. Decimals are resolved per chain — hardcoded for known stablecoins, fetched on-chain (and cached) otherwise. */
async function toRawUsdc(chainKey, usdcAmount) {
  const decimals = await getStableDecimals(chainKey);
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
const noop = async () => {};

// ---------------------------------------------------------------------------
// Cross-chain auto-bridge (Phase 4 of CROSSCHAIN_BUILD_PLAN.md)
// ---------------------------------------------------------------------------

function stablecoinTokenFor(chainKey) {
  const chain = getChain(chainKey);
  return isSolanaChain(chainKey) ? chain.usdcMint : chain.usdcAddress;
}

/** Finds the chain (other than `excludeChainKey`) with the largest stablecoin balance, provided it covers `neededUsd`. Returns null if none qualifies. */
async function findBridgeSourceChain(wallet, excludeChainKey, neededUsd) {
  const candidates = ALL_CHAIN_KEYS.filter((k) => k !== excludeChainKey);
  const balances = await Promise.all(candidates.map(async (chainKey) => {
    try {
      return { chainKey, balance: await getChainUsdcBalance(wallet, chainKey) };
    } catch {
      return { chainKey, balance: 0 };
    }
  }));
  balances.sort((a, b) => b.balance - a.balance);
  const best = balances[0];
  if (!best || best.balance < neededUsd) return null;
  return best;
}

/**
 * Bridges `shortfallUsd` (plus a buffer to absorb bridge fees/slippage) of
 * stablecoin from `fromChainKey` to `toChainKey`, for the given wallet.
 * Updates `pendingTradeId`'s status via storage.js as it progresses so a
 * crash mid-bridge is resumable (see pollers.js's resumeStuckBridges).
 *
 * Throws on failure. A LI.FI TIMEOUT (source tx landed, completion just
 * unconfirmed) throws an Error with `.bridgeTimeout = true` so the caller
 * can leave the pending_trade in 'bridging' status instead of marking it
 * failed — pollers.js will pick it up on the next restart or resume poll.
 */
async function bridgeShortfall({ wallet, fromChainKey, toChainKey, shortfallUsd, pendingTradeId, onProgress }) {
  const fromChain = getChain(fromChainKey);
  const toChain = getChain(toChainKey);
  const fromDecimals = await getStableDecimals(fromChainKey);

  const bufferedUsd = shortfallUsd * (1 + BRIDGE_SHORTFALL_BUFFER_PCT / 100);
  const fromAmountRaw = isSolanaChain(fromChainKey)
    ? BigInt(Math.round(bufferedUsd * 10 ** fromDecimals)).toString()
    : ethers.parseUnits(bufferedUsd.toFixed(fromDecimals), fromDecimals).toString();

  const fromAddress = walletAddressForChain(wallet, fromChainKey);
  const toAddress = walletAddressForChain(wallet, toChainKey);

  const quote = await getBridgeQuote({
    fromChainKey,
    toChainKey,
    fromToken: stablecoinTokenFor(fromChainKey),
    toToken: stablecoinTokenFor(toChainKey),
    amount: fromAmountRaw,
    fromAddress,
    toAddress,
  });

  const summary = summarizeBridgeQuote(quote);
  await onProgress(
    `🌉 Bridging ~${fmtUsd(bufferedUsd)} from ${fromChain.name} → ${toChain.name} via ${summary.toolUsed} ` +
    `(fee ~${fmtUsd(summary.totalFeeUsd)}, ETA ~${summary.etaSeconds ? Math.round(summary.etaSeconds / 60) + 'm' : 'a few minutes'})...`
  );

  if (isSolanaChain(fromChainKey)) {
    await ensureSolanaGasReserve(fromAddress);
  }

  const signer = isSolanaChain(fromChainKey)
    ? keypairFromPrivateKey(wallet.solPrivateKey)
    : new ethers.Wallet(wallet.privateKey, getEvmProvider(fromChainKey));

  if (!isSolanaChain(fromChainKey)) {
    await ensureGasReserve(fromChainKey, signer, fromAddress);
  }

  const result = await executeBridge(quote, signer, {
    onSourceTxSent: async (hash) => markPendingTradeBridging(pendingTradeId, hash, fromChainKey),
  });

  if (!result.ok) {
    throw Object.assign(
      new Error(
        `Bridge from ${fromChain.name} was submitted (tx ${result.sourceTxHash}) but LI.FI hasn't confirmed ` +
        `completion yet. Your funds are very likely safe and in transit — this trade will resume automatically ` +
        `once the bridge lands, no action needed.`
      ),
      { bridgeTimeout: true }
    );
  }

  markPendingTradeBridged(pendingTradeId);

  const destDecimals = await getStableDecimals(toChainKey);
  const receivedUsd = result.receivedAmount ? Number(result.receivedAmount) / 10 ** destDecimals : null;
  await onProgress(
    `✅ Bridge complete — ${receivedUsd != null ? fmtUsd(receivedUsd) : 'funds'} landed on ${toChain.name}. Swapping now...`
  );

  return result;
}

// ---------------------------------------------------------------------------
// pump.fun bonding-curve buy/sell — used ONLY for Solana tokens that haven't
// graduated to an AMM pool yet (Jupiter has no route for those at all; see
// pumpfun.js). The curve trades native SOL, not USDC, so both legs below
// bridge through a plain Jupiter USDC<->SOL swap (a deep, always-liquid
// pair) around the bonding-curve instruction itself.
// ---------------------------------------------------------------------------

async function performPumpFunBuy(uid, wallet, tokenAddress, usdcAmount, pendingTradeId) {
  const keypair = keypairFromPrivateKey(wallet.solPrivateKey);
  await ensureSolanaGasReserve(wallet.solAddress);

  const sellAmountRaw = await toRawUsdc('solana', usdcAmount);
  const solQuote = await getSolanaQuote({ sellToken: 'USDC', buyToken: 'SOL', sellAmountRaw });
  const solTx = await buildSolanaSwapTx(solQuote, keypair.publicKey);
  await sendSolanaSwap(keypair, solTx);
  const solInLamports = BigInt(solQuote.outAmount);

  const { slippageBps } = getSettings(uid);
  const { signature, tokensOut } = await executePumpFunBuy(keypair, tokenAddress, solInLamports, slippageBps);
  markPendingTradeSubmitted(pendingTradeId, signature);
  markPendingTradeDone(pendingTradeId, 'confirmed');

  const tokenAmount = Number(tokensOut) / 10 ** 6; // pump.fun tokens are always 6 decimals pre-graduation
  const entryMarket = await getTokenMarketData(tokenAddress, 'solana').catch(() => null);
  recordTrade(uid, wallet.id, 'solana', tokenAddress, 'buy', tokenAmount, usdcAmount, entryMarket?.marketCap ?? null);

  return {
    ok: true, txHash: signature, walletName: wallet.name,
    entryMcap: entryMarket?.marketCap ?? null, viaPumpFunBondingCurve: true,
  };
}

async function performPumpFunSell(uid, wallet, tokenAddress, pos, rawAmount, tokenAmount, pendingTradeId) {
  const keypair = keypairFromPrivateKey(wallet.solPrivateKey);
  await ensureSolanaGasReserve(wallet.solAddress);

  const { slippageBps } = getSettings(uid);
  const { signature, solOut } = await executePumpFunSell(keypair, tokenAddress, rawAmount, slippageBps);

  // Convert the received native SOL back into USDC so the position's PnL
  // stays denominated the same way every other chain's trades are. If this
  // leg fails, the sell itself already succeeded on-chain — the SOL is safe
  // in the wallet, just not yet converted, so this is logged rather than
  // thrown (throwing here would incorrectly mark a successful sell as failed).
  let usdcReceived = 0;
  try {
    const solQuote = await getSolanaQuote({ sellToken: 'SOL', buyToken: 'USDC', sellAmountRaw: solOut });
    const solTx = await buildSolanaSwapTx(solQuote, keypair.publicKey);
    await sendSolanaSwap(keypair, solTx);
    usdcReceived = Number(solQuote.outAmount) / 10 ** getChain('solana').usdcDecimals;
  } catch (err) {
    console.error(`Post pump.fun-sell SOL->USDC conversion failed for uid ${uid}, token ${tokenAddress}:`, err.message);
    // usdcReceived stays 0 — the sell itself succeeded on-chain (SOL is in
    // the wallet), we just couldn't price/convert it right now. Recorded
    // as a $0 sell rather than guessing a USD value.
  }

  markPendingTradeSubmitted(pendingTradeId, signature);
  markPendingTradeDone(pendingTradeId, 'confirmed');

  const exitMarket = await getTokenMarketData(tokenAddress, 'solana').catch(() => null);
  recordTrade(uid, wallet.id, 'solana', tokenAddress, 'sell', tokenAmount, usdcReceived, exitMarket?.marketCap ?? null);

  return {
    ok: true, txHash: signature, walletName: wallet.name, usdcReceived,
    entryMcap: pos.entryMcap ?? null, exitMcap: exitMarket?.marketCap ?? null, viaPumpFunBondingCurve: true,
  };
}

// ---------------------------------------------------------------------------
// Swap execution — factored out of performBuyCore so it can also be called
// standalone by pollers.js when resuming a trade whose bridge leg completed
// after a restart (bridge already done, pending_trade already exists;
// just needs the destination-chain swap).
// ---------------------------------------------------------------------------

/**
 * Executes the actual on-chain swap for a buy, assuming the target chain
 * already holds enough stablecoin (bridging, if any, is the caller's job).
 * Does NOT create the pending trade or manage tradesInFlight — caller does
 * both, since this is shared between a fresh buy and a resumed bridge.
 *
 * On Solana, first checks whether the token is a pump.fun bonding-curve
 * token that hasn't graduated yet — if so, routes through pumpfun.js
 * instead of Jupiter (see performPumpFunBuy above), since Jupiter has no
 * route for pre-graduation tokens at all.
 */
export async function performSwapBuy(uid, wallet, chainKey, tokenAddress, usdcAmount, pendingTradeId) {
  const address = walletAddressForChain(wallet, chainKey);

  if (isSolanaChain(chainKey)) {
    let curve = null;
    try {
      curve = await getBondingCurveState(tokenAddress);
    } catch (err) {
      console.error(`[pump.fun] bonding-curve check failed for ${tokenAddress}, falling back to Jupiter:`, err.message);
    }
    console.log(`[pump.fun] ${tokenAddress}: ${curve ? `curve found, complete=${curve.complete}` : 'no curve account (not pump.fun-launched, or lookup failed — see above)'}`);

    if (curve && !curve.complete) {
      return performPumpFunBuy(uid, wallet, tokenAddress, usdcAmount, pendingTradeId);
    }

    await ensureSolanaGasReserve(address);
    const keypair = keypairFromPrivateKey(wallet.solPrivateKey);
    const sellAmountRaw = await toRawUsdc(chainKey, usdcAmount);

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

  const sellAmount = await toRawUsdc(chainKey, usdcAmount);
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
}

/**
 * Buys `usdcAmount` worth of `tokenAddress` on `chainKey`. If the wallet
 * doesn't hold enough of that chain's stablecoin, automatically bridges the
 * shortfall in from whichever other chain has the largest balance (Phase 4
 * of CROSSCHAIN_BUILD_PLAN.md), then completes the swap. Same-chain trades
 * (the overwhelming majority) are unaffected — no bridge check runs unless
 * the target-chain balance is actually short.
 *
 * `onProgress(message)` is an optional callback fired with human-readable
 * status updates during a bridge (e.g. "Bridging $50 from Base -> Robinhood
 * Chain..."). Callers that don't care (auto TP/SL, limit orders) can omit
 * it — bridging still happens, just silently to them, same as any other
 * async step in this function.
 */
export async function performBuyCore(uid, wallet, chainKey, tokenAddress, usdcAmount, { onProgress = noop } = {}) {
  if (tradesInFlight.has(uid)) return { ok: false, error: LOCKED_ERROR, locked: true, walletName: wallet.name };

  const { maxBuyUsdc } = getSettings(uid);
  if (usdcAmount > maxBuyUsdc) {
    return { ok: false, error: `Buy of ${fmtUsd(usdcAmount)} exceeds max buy size (${fmtUsd(maxBuyUsdc)}).`, walletName: wallet.name };
  }

  tradesInFlight.add(uid);
  let pendingTradeId;
  let bridged = false;
  let bridgeFromChain = null;

  try {
    pendingTradeId = createPendingTrade({ uid, walletId: wallet.id, chain: chainKey, tokenAddress, side: 'buy', amount: usdcAmount });

    const targetBalance = await getChainUsdcBalance(wallet, chainKey).catch(() => 0);

    if (targetBalance < usdcAmount) {
      const shortfall = usdcAmount - targetBalance;
      const targetChainName = getChain(chainKey).name;
      const targetSymbol = getChain(chainKey).stableSymbol || 'USDC';

      if (shortfall < MIN_BRIDGE_USD) {
        markPendingTradeDone(pendingTradeId, 'failed');
        return {
          ok: false,
          walletName: wallet.name,
          error: `Short ${fmtUsd(shortfall)} of ${targetSymbol} on ${targetChainName} — too small to auto-bridge ` +
            `(min ${fmtUsd(MIN_BRIDGE_USD)}). Add funds directly on ${targetChainName}.`,
        };
      }

      const source = await findBridgeSourceChain(wallet, chainKey, shortfall);
      if (!source) {
        markPendingTradeDone(pendingTradeId, 'failed');
        return {
          ok: false,
          walletName: wallet.name,
          error: `Short ${fmtUsd(shortfall)} of ${targetSymbol} on ${targetChainName}, and no other chain has enough ` +
            `balance to auto-bridge it. Add funds on ${targetChainName} directly, or fund another chain first.`,
        };
      }

      try {
        await bridgeShortfall({
          wallet, fromChainKey: source.chainKey, toChainKey: chainKey, shortfallUsd: shortfall, pendingTradeId, onProgress,
        });
      } catch (bridgeErr) {
        markPendingTradeDone(pendingTradeId, bridgeErr.bridgeTimeout ? 'bridging' : 'failed');
        return { ok: false, walletName: wallet.name, error: bridgeErr.message, bridgeTimeout: !!bridgeErr.bridgeTimeout };
      }

      bridged = true;
      bridgeFromChain = source.chainKey;

      const postBridgeBalance = await getChainUsdcBalance(wallet, chainKey).catch(() => 0);
      if (postBridgeBalance < usdcAmount) {
        markPendingTradeDone(pendingTradeId, 'failed');
        return {
          ok: false,
          walletName: wallet.name,
          error: `Bridge landed but ${targetChainName} balance (${fmtUsd(postBridgeBalance)}) is still short of ` +
            `${fmtUsd(usdcAmount)}, likely due to bridge fees. Try a smaller amount or fund ${targetChainName} directly.`,
        };
      }
    }

    markPendingTradeSwapping(pendingTradeId);
    const swapResult = await performSwapBuy(uid, wallet, chainKey, tokenAddress, usdcAmount, pendingTradeId);
    return { ...swapResult, bridged, bridgeFromChain };
  } catch (err) {
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    return { ok: false, error: friendlyErrorMessage(err), walletName: wallet.name };
  } finally {
    tradesInFlight.delete(uid);
  }
}

// ---------------------------------------------------------------------------
// Sells — deliberately stay same-chain-only for v1 (CROSSCHAIN_BUILD_PLAN.md
// Phase 4 decision). Bridging proceeds back to a preferred chain after a
// sell is a possible v2 addition, not built here.
// ---------------------------------------------------------------------------

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
      let curve = null;
      try {
        curve = await getBondingCurveState(tokenAddress);
      } catch (err) {
        console.error(`[pump.fun] bonding-curve check failed for ${tokenAddress}, falling back to Jupiter:`, err.message);
      }
      console.log(`[pump.fun] ${tokenAddress}: ${curve ? `curve found, complete=${curve.complete}` : 'no curve account (not pump.fun-launched, or lookup failed — see above)'}`);

      if (curve && !curve.complete) {
        return await performPumpFunSell(uid, wallet, tokenAddress, pos, rawAmount, tokenAmount, pendingTradeId);
      }

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
  const result = await performBuyCore(uid, w, chainKey, tokenAddress, usdcAmount, {
    onProgress: async (msg) => { await ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => {}); },
  });

  if (!result.ok) {
    await ctx.reply(`❌ Trade failed: ${result.error}`, mainMenu());
    if (!result.locked && !result.bridgeTimeout) {
      await sendAdminAlert(ctx.telegram, `Buy failed for user ${uid} on ${chain.name}/${tokenAddress}: ${result.error}`);
    }
    return;
  }

  const txLink = explorerTxUrl(chainKey, result.txHash);
  const mcapLine = result.entryMcap != null ? `\nEntry mcap: ${fmtUsd(result.entryMcap)}` : '';
  const bridgeLine = result.bridged ? `\n_(auto-bridged shortfall from ${getChain(result.bridgeFromChain).name})_` : '';
  const pumpLine = result.viaPumpFunBondingCurve ? `\n_(bought via pump.fun bonding curve — not yet graduated)_` : '';
  await ctx.reply(
    (txLink ? `✅ Confirmed on ${chain.name} — [view transaction](${txLink})` : `✅ Confirmed on ${chain.name}`) + mcapLine + bridgeLine + pumpLine,
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
  const pumpLine = result.viaPumpFunBondingCurve ? `\n_(sold via pump.fun bonding curve — not yet graduated)_` : '';

  await ctx.reply(
    (txLink ? `✅ Confirmed on ${chain.name} — [view transaction](${txLink})` : `✅ Confirmed on ${chain.name}`) + mcapBlock + pumpLine,
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

/**
 * Sends a stablecoin transfer (withdrawal) on `chainKey`. Unlike buy/sell,
 * this doesn't go through 0x/Jupiter at all — it's a plain token transfer
 * (or native SPL transfer on Solana) — so "no quotes available" /
 * "slippage" style errors CANNOT apply here. If this fails, it's an
 * on-chain revert (balance, allowance-irrelevant since transfer() doesn't
 * need one, or a decimals/amount mismatch) or a gas-reserve top-up failure
 * upstream. The raw error is logged here (with err.reason / err.code /
 * err.shortMessage if present) specifically because friendlyErrorMessage()
 * collapses everything into a generic, swap-flavored message that doesn't
 * help diagnose a transfer failure — see README/runbook note.
 */
export async function performUsdcTransferCore(uid, chainKey, sourceWallet, toAddress, usdcAmount) {
  try {
    if (isSolanaChain(chainKey)) {
      const keypair = keypairFromPrivateKey(sourceWallet.solPrivateKey);
      await ensureSolanaGasReserve(sourceWallet.solAddress);
      const rawAmount = await toRawUsdc(chainKey, usdcAmount);
      const { transferSolanaUsdc } = await import('./solana.js');
      const { signature } = await transferSolanaUsdc(keypair, toAddress, rawAmount);
      return { ok: true, txHash: signature };
    }

    const chain = getChain(chainKey);
    const signer = new ethers.Wallet(sourceWallet.privateKey, getEvmProvider(chainKey));
    await ensureGasReserve(chainKey, signer, sourceWallet.address);
    const decimals = await getStableDecimals(chainKey);
    const rawAmount = ethers.parseUnits(usdcAmount.toString(), decimals);

    // Extra diagnostic: confirm on-chain balance actually covers rawAmount
    // BEFORE attempting the transfer, so a decimals mismatch or a gas
    // top-up that ate into the balance shows up clearly in logs instead of
    // surfacing only as an opaque revert from the token contract.
    const { getUsdcBalance } = await import('./erc20.js');
    const preBalance = await getUsdcBalance(getEvmProvider(chainKey), chain.usdcAddress, sourceWallet.address).catch(() => null);
    console.log(
      `[withdraw debug] uid=${uid} chain=${chainKey} decimals=${decimals} ` +
      `requestedRaw=${rawAmount.toString()} onChainBalanceRaw=${preBalance !== null ? preBalance.toString() : 'unknown'}`
    );
    if (preBalance !== null && preBalance < rawAmount) {
      console.error(
        `[withdraw] Insufficient on-chain balance: have ${preBalance.toString()}, need ${rawAmount.toString()} ` +
        `(decimals=${decimals}). Likely cause: gas top-up (ensureGasReserve) consumed part of the balance just now, ` +
        `or getStableDecimals() resolved a wrong decimals value for this chain's stablecoin.`
      );
    }

    const { transferToken } = await import('./erc20.js');
    const receipt = await transferToken(signer, chain.usdcAddress, toAddress, rawAmount);
    return { ok: true, txHash: receipt.hash };
  } catch (err) {
    console.error(
      `[withdraw] Raw transfer error for uid=${uid} chain=${chainKey} amount=${usdcAmount}:`,
      {
        message: err.message,
        code: err.code,
        reason: err.reason,
        shortMessage: err.shortMessage,
        data: err.data,
        info: err.info,
      }
    );
    return { ok: false, error: friendlyErrorMessage(err) };
  }
}
