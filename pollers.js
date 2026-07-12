import { ethers } from 'ethers';
import { getTokenMarketData } from './price.js';
import { sendAdminAlert } from './alerts.js';
import { checkBridgeStatus } from './bridge.js';
import { performSwapBuy, performSellCore, performBuyCore } from './trade-core.js';
import {
  getStuckPendingTradesByKind,
  getAllActiveWallets,
  getSettings,
  updateSettings,
  getActiveAutoRules,
  getWallet,
  getPosition,
  markAutoRuleTriggered,
  getOpenLimitOrders,
  markLimitOrderDone,
  markPendingTradeBridged,
  markPendingTradeSwapping,
  markPendingTradeDone,
} from './storage.js';
import { getChain, getEvmProvider, isSolanaChain, explorerTxUrl } from './chains.js';
import { getSolBalance } from './solana.js';
import {
  AUTO_TRADE_POLL_INTERVAL_MS, LIMIT_ORDER_POLL_INTERVAL_MS, LOW_BALANCE_POLL_INTERVAL_MS,
  BRIDGE_RESUME_POLL_INTERVAL_MS,
} from './config.js';
import { tradesInFlight } from './state.js';

// ---------- Startup: crash recovery check ----------

/**
 * On restart, any pending_trades row not in a terminal state means the bot
 * died mid-trade. Split into two buckets so the admin alert is actually
 * actionable instead of one undifferentiated wall of "verify manually":
 *
 *   - bridgeStuck ('bridging' | 'bridged'): a LI.FI bridge leg was in
 *     flight or had already landed when the bot died. Funds are very
 *     likely fine — resumeStuckBridges() (below) actually acts on this
 *     bucket now, this alert is just the heads-up that it's working on it.
 *   - swapStuck (everything else unresolved): the same "something broke
 *     mid-swap, go look at the chain/logs" bucket that existed before
 *     bridging existed at all — unchanged behavior for same-chain trades.
 */
export async function checkStuckTrades(bot) {
  const { bridgeStuck, swapStuck } = getStuckPendingTradesByKind();
  if (bridgeStuck.length === 0 && swapStuck.length === 0) return;

  const lines = [];

  if (bridgeStuck.length > 0) {
    lines.push(`🌉 ${bridgeStuck.length} trade(s) stuck mid-bridge — will attempt auto-resume:`);
    for (const t of bridgeStuck) {
      lines.push(
        `  • [${t.chain}] ${t.side} ${t.amount} on ${t.token_address} (user ${t.uid}, status: ${t.status}` +
        `${t.bridge_from_chain ? `, from: ${t.bridge_from_chain}` : ''}${t.bridge_hash ? `, bridge tx: ${t.bridge_hash}` : ''})`
      );
    }
  }

  if (swapStuck.length > 0) {
    lines.push(`⚠️ ${swapStuck.length} trade(s) stuck mid-swap (verify manually):`);
    for (const t of swapStuck) {
      lines.push(
        `  • [${t.chain}] ${t.side} ${t.amount} on ${t.token_address} (user ${t.uid}, status: ${t.status}${t.tx_hash ? `, tx: ${t.tx_hash}` : ''})`
      );
    }
  }

  await sendAdminAlert(
    bot.telegram,
    `Bot restarted with ${bridgeStuck.length + swapStuck.length} unresolved trade(s) from before the crash:\n${lines.join('\n')}`
  );
  console.warn(
    `${bridgeStuck.length} bridge-stuck + ${swapStuck.length} swap-stuck trade(s) unresolved from before restart. See admin alert / pending_trades table.`
  );
}

// ---------- Bridge resume poller (Phase 4) ----------
//
// Finds every pending_trade stuck in 'bridging' or 'bridged' (i.e. the bot
// died — or a bridge simply timed out on LI.FI's status endpoint — before
// the destination-chain swap could run) and tries to finish the job:
//
//   'bridging' -> re-check LI.FI's /status for bridge_hash. If DONE, mark
//                 'bridged' and fall through to the swap step below. If
//                 still pending, leave it — retry next poll tick.
//   'bridged'  -> bridge already confirmed landed (either by us just now,
//                 or before the restart) but the swap leg never ran or
//                 never got confirmed. Attempt the swap now.
//
// A trade is only ever resumed while its uid isn't already locked by
// tradesInFlight — same lock performBuyCore/performSellCore use — so a
// resume never races a trade the user initiates manually in the meantime.

async function resumeOneBridgeTrade(bot, trade) {
  const uid = trade.uid;
  if (tradesInFlight.has(uid)) return; // something else in flight; retry next tick

  const wallet = getWallet(uid, trade.wallet_id);
  if (!wallet) {
    markPendingTradeDone(trade.id, 'failed');
    await sendAdminAlert(bot.telegram, `Bridge-resume: wallet ${trade.wallet_id} not found for stuck trade ${trade.id} (uid ${uid}) — marked failed.`);
    return;
  }

  if (trade.status === 'bridging') {
    if (!trade.bridge_hash || !trade.bridge_from_chain) return; // nothing to check yet
    let status;
    try {
      status = await checkBridgeStatus({
        sourceTxHash: trade.bridge_hash,
        fromChainKey: trade.bridge_from_chain,
        toChainKey: trade.chain,
      });
    } catch (err) {
      console.warn(`Bridge-resume: status check failed for trade ${trade.id}:`, err.message);
      return;
    }

    if (status.status === 'FAILED') {
      markPendingTradeDone(trade.id, 'failed');
      await bot.telegram.sendMessage(
        uid,
        `❌ A bridge transfer for your pending buy failed (${status.substatusMessage || status.substatus || 'unknown reason'}). ` +
        `Check your wallet on ${getChain(trade.bridge_from_chain).name} — funds may still be there.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      await sendAdminAlert(bot.telegram, `Bridge FAILED for uid ${uid}, trade ${trade.id}: ${status.substatusMessage || status.substatus}`);
      return;
    }

    if (status.status !== 'DONE') return; // still in transit, retry next tick

    markPendingTradeBridged(trade.id);
    trade = { ...trade, status: 'bridged' };
  }

  if (trade.status !== 'bridged') return;

  tradesInFlight.add(uid);
  try {
    markPendingTradeSwapping(trade.id);
    const result = await performSwapBuy(uid, wallet, trade.chain, trade.token_address, trade.amount, trade.id);
    const txLink = explorerTxUrl(trade.chain, result.txHash);
    await bot.telegram.sendMessage(
      uid,
      `✅ Your bridged buy on ${getChain(trade.chain).name} just completed automatically after resuming from a bridge delay.` +
      (txLink ? `\n[View transaction](${txLink})` : ''),
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  } catch (err) {
    markPendingTradeDone(trade.id, 'failed');
    await bot.telegram.sendMessage(
      uid,
      `⚠️ Your funds bridged successfully to ${getChain(trade.chain).name}, but the follow-up swap failed: ${err.message}. ` +
      `Your ${getChain(trade.chain).stableSymbol || 'USDC'} balance is safe there — try the trade again manually.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    await sendAdminAlert(bot.telegram, `Bridge-resume swap failed for uid ${uid}, trade ${trade.id}: ${err.message}`);
  } finally {
    tradesInFlight.delete(uid);
  }
}

export async function resumeStuckBridges(bot) {
  let bridgeStuck;
  try {
    ({ bridgeStuck } = getStuckPendingTradesByKind());
  } catch (err) {
    console.error('Bridge-resume: failed to read stuck trades:', err.message);
    return;
  }
  for (const trade of bridgeStuck) {
    try {
      await resumeOneBridgeTrade(bot, trade);
    } catch (err) {
      console.error(`Bridge-resume: unexpected error on trade ${trade.id}:`, err.message);
    }
  }
}

export function startBridgeResumePoller(bot) {
  setInterval(() => {
    resumeStuckBridges(bot).catch((err) => console.error('Bridge-resume poller tick failed:', err.message));
  }, BRIDGE_RESUME_POLL_INTERVAL_MS);
}

// ---------- Low balance (native gas token) poller ----------

async function getNativeBalance(chainKey, wallet) {
  if (isSolanaChain(chainKey)) {
    if (!wallet.sol_address) return null;
    return getSolBalance(wallet.sol_address);
  }
  const provider = getEvmProvider(chainKey);
  const bal = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(bal));
}

export function startLowBalancePoller(bot) {
  setInterval(async () => {
    let wallets;
    try {
      wallets = getAllActiveWallets();
    } catch (err) {
      console.error('Low-balance poller: failed to read active wallets:', err.message);
      return;
    }

    for (const w of wallets) {
      try {
        const settings = getSettings(w.uid);
        const { lowBalanceThresholdEth } = settings;
        if (!lowBalanceThresholdEth || lowBalanceThresholdEth <= 0) continue;

        const chain = getChain(w.chain);
        const bal = await getNativeBalance(w.chain, w).catch(() => null);
        if (bal === null) continue;

        if (bal < lowBalanceThresholdEth) {
          if (!settings.lowBalanceWarned) {
            updateSettings(w.uid, { lowBalanceWarned: true });
            await bot.telegram.sendMessage(
              w.uid,
              `⚠️ Low balance: *${w.name}* has ${bal.toFixed(4)} ${chain.nativeSymbol} on ${chain.name}, below your alert threshold of ${lowBalanceThresholdEth}.\n` +
              `Add funds to keep trading smoothly. Adjust this threshold anytime in ⚙️ Settings.`,
              { parse_mode: 'Markdown' }
            ).catch((err) => console.error(`Failed to send low-balance alert to uid ${w.uid}:`, err.message));
          }
        } else if (settings.lowBalanceWarned) {
          updateSettings(w.uid, { lowBalanceWarned: false });
        }
      } catch (err) {
        console.error(`Low-balance poller: check failed for uid ${w.uid}:`, err.message);
      }
    }
  }, LOW_BALANCE_POLL_INTERVAL_MS);
}

// ---------- Auto TP/SL poller ----------

export function startAutoTradePoller(bot) {
  setInterval(async () => {
    let rules;
    try {
      rules = getActiveAutoRules();
    } catch (err) {
      console.error('Auto-trade poller: failed to read active rules:', err.message);
      return;
    }

    for (const rule of rules) {
      try {
        const wallet = getWallet(rule.uid, rule.wallet_id);
        if (!wallet) { markAutoRuleTriggered(rule.id); continue; }

        const pos = getPosition(rule.uid, rule.wallet_id, rule.chain, rule.token_address);
        if (!pos || pos.tokenAmount <= 0) { markAutoRuleTriggered(rule.id); continue; }

        const market = await getTokenMarketData(rule.token_address, rule.chain).catch(() => null);
        if (!market) continue;

        const valueUsd = pos.tokenAmount * market.priceUsd;
        const costUsd = pos.costUsdc;
        if (costUsd <= 0) continue;
        const pnlPct = ((valueUsd - costUsd) / costUsd) * 100;

        let trigger = null;
        if (rule.tp_pct != null && pnlPct >= rule.tp_pct) trigger = 'take-profit';
        else if (rule.sl_pct != null && pnlPct <= -rule.sl_pct) trigger = 'stop-loss';
        if (!trigger) continue;

        if (tradesInFlight.has(rule.uid)) continue;

        markAutoRuleTriggered(rule.id);

        const result = await performSellCore(rule.uid, wallet, rule.chain, rule.token_address, 100);
        if (result.ok) {
          const txLink = explorerTxUrl(rule.chain, result.txHash);
          await bot.telegram.sendMessage(
            rule.uid,
            `🎯 ${trigger === 'take-profit' ? 'Take-profit' : 'Stop-loss'} triggered on *${wallet.name}* _(${getChain(rule.chain).name})_ (${pnlPct.toFixed(1)}%) — sold 100% of your ${market.symbol} position.` +
            (txLink ? `\n[View transaction](${txLink})` : ''),
            { parse_mode: 'Markdown' }
          ).catch((err) => console.error(`Failed to notify uid ${rule.uid} of auto-trade:`, err.message));
        } else {
          await bot.telegram.sendMessage(
            rule.uid,
            `⚠️ ${trigger === 'take-profit' ? 'Take-profit' : 'Stop-loss'} triggered on *${wallet.name}* but the sell failed: ${result.error}\nYour rule has been retired — set a new one if you'd like to try again.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          await sendAdminAlert(bot.telegram, `Auto-trade sell failed for uid ${rule.uid} on ${rule.chain}/${rule.token_address}: ${result.error}`);
        }
      } catch (err) {
        console.error(`Auto-trade poller: rule ${rule.id} failed:`, err.message);
      }
    }
  }, AUTO_TRADE_POLL_INTERVAL_MS);
}

// ---------- Limit order poller ----------

export function startLimitOrderPoller(bot) {
  setInterval(async () => {
    let orders;
    try {
      orders = getOpenLimitOrders();
    } catch (err) {
      console.error('Limit order poller: failed to read open orders:', err.message);
      return;
    }

    for (const order of orders) {
      try {
        const wallet = getWallet(order.uid, order.wallet_id);
        if (!wallet) { markLimitOrderDone(order.id, 'cancelled'); continue; }

        const market = await getTokenMarketData(order.token_address, order.chain).catch(() => null);
        if (!market) continue;

        const crossed = order.side === 'buy'
          ? market.priceUsd <= order.trigger_price
          : market.priceUsd >= order.trigger_price;
        if (!crossed) continue;

        if (tradesInFlight.has(order.uid)) continue;

        markLimitOrderDone(order.id, 'filled');

        if (order.side === 'buy') {
          const result = await performBuyCore(order.uid, wallet, order.chain, order.token_address, order.amount);
          if (result.ok) {
            const txLink = explorerTxUrl(order.chain, result.txHash);
            await bot.telegram.sendMessage(
              order.uid,
              `⏰ Limit buy filled on *${wallet.name}* _(${getChain(order.chain).name})_: ${order.amount} ETH-equivalent of ${market.symbol} @ ~$${market.priceUsd.toPrecision(4)}` +
              (txLink ? `\n[View transaction](${txLink})` : ''),
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          } else {
            markLimitOrderDone(order.id, 'failed');
            await bot.telegram.sendMessage(order.uid, `⚠️ Limit buy triggered on *${wallet.name}* but failed: ${result.error}`, { parse_mode: 'Markdown' }).catch(() => {});
            await sendAdminAlert(bot.telegram, `Limit buy failed for uid ${order.uid} on ${order.chain}/${order.token_address}: ${result.error}`);
          }
        } else {
          const pos = getPosition(order.uid, order.wallet_id, order.chain, order.token_address);
          if (!pos || pos.tokenAmount <= 0) continue;
          const pct = Math.min((order.amount / pos.tokenAmount) * 100, 100);
          const result = await performSellCore(order.uid, wallet, order.chain, order.token_address, pct);
          if (result.ok) {
            const txLink = explorerTxUrl(order.chain, result.txHash);
            await bot.telegram.sendMessage(
              order.uid,
              `⏰ Limit sell filled on *${wallet.name}* _(${getChain(order.chain).name})_: ${order.amount.toFixed(4)} ${market.symbol} @ ~$${market.priceUsd.toPrecision(4)}` +
              (txLink ? `\n[View transaction](${txLink})` : ''),
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          } else {
            markLimitOrderDone(order.id, 'failed');
            await bot.telegram.sendMessage(order.uid, `⚠️ Limit sell triggered on *${wallet.name}* but failed: ${result.error}`, { parse_mode: 'Markdown' }).catch(() => {});
            await sendAdminAlert(bot.telegram, `Limit sell failed for uid ${order.uid} on ${order.chain}/${order.token_address}: ${result.error}`);
          }
        }
      } catch (err) {
        console.error(`Limit order poller: order ${order.id} failed:`, err.message);
      }
    }
  }, LIMIT_ORDER_POLL_INTERVAL_MS);
}
