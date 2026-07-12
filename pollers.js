import { ethers } from 'ethers';
import { getTokenMarketData } from './price.js';
import { sendAdminAlert } from './alerts.js';
import {
  getStuckPendingTrades,
  getAllActiveWallets,
  getSettings,
  updateSettings,
  getActiveAutoRules,
  getWallet,
  getPosition,
  markAutoRuleTriggered,
  getOpenLimitOrders,
  markLimitOrderDone,
} from './storage.js';
import { getChain, getEvmProvider, isSolanaChain, explorerTxUrl } from './chains.js';
import { getSolBalance } from './solana.js';
import {
  AUTO_TRADE_POLL_INTERVAL_MS, LIMIT_ORDER_POLL_INTERVAL_MS, LOW_BALANCE_POLL_INTERVAL_MS,
} from './config.js';
import { tradesInFlight } from './state.js';
import { performSellCore, performBuyCore } from './trade-core.js';

// ---------- Startup: crash recovery check ----------

export async function checkStuckTrades(bot) {
  const stuck = getStuckPendingTrades();
  if (stuck.length === 0) return;
  const lines = stuck.map((t) =>
    `• [${t.chain}] ${t.side} ${t.amount} on ${t.token_address} (user ${t.uid}, status: ${t.status}${t.tx_hash ? `, tx: ${t.tx_hash}` : ''})`
  );
  await sendAdminAlert(
    bot.telegram,
    `Bot restarted with ${stuck.length} unresolved trade(s) from before the crash — verify these manually:\n${lines.join('\n')}`
  );
  console.warn(`${stuck.length} pending trade(s) unresolved from before restart. See admin alert / pending_trades table.`);
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
