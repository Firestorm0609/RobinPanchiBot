import { ethers } from 'ethers';
import { checkBridgeStatusOnce } from './bridge.js';
import { getTokenMarketData, getEthUsdPrice } from './price.js';
import { sendAdminAlert } from './alerts.js';
import {
  getStuckPendingTrades,
  getInFlightBridges,
  markPendingBridgeDone,
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
import {
  provider,
  BRIDGE_POLL_INTERVAL_MS,
  LOW_BALANCE_POLL_INTERVAL_MS,
  AUTO_TRADE_POLL_INTERVAL_MS,
  LIMIT_ORDER_POLL_INTERVAL_MS,
} from './config.js';
import { tradesInFlight } from './state.js';
import { explorerTxUrl, explorerTxUrlForChain } from './format.js';
import { directionLabel } from './menus.js';
import { performSellCore, performBuyCore } from './trade-core.js';

// ---------- Startup: crash recovery check ----------

export async function checkStuckTrades(bot) {
  const stuck = getStuckPendingTrades();
  if (stuck.length === 0) return;
  const lines = stuck.map((t) =>
    `• ${t.side} ${t.amount} on ${t.token_address} (user ${t.uid}, status: ${t.status}${t.tx_hash ? `, tx: ${t.tx_hash}` : ''})`
  );
  await sendAdminAlert(
    bot.telegram,
    `Bot restarted with ${stuck.length} unresolved trade(s) from before the crash — verify these manually:\n${lines.join('\n')}`
  );
  console.warn(`${stuck.length} pending trade(s) unresolved from before restart. See admin alert / pending_trades table.`);
}

export async function checkStuckBridges(bot) {
  const stuck = getInFlightBridges();
  if (stuck.length === 0) return;

  const resumable = stuck.filter((b) => b.source_tx_hash);
  const needsManualReview = stuck.filter((b) => !b.source_tx_hash);

  if (resumable.length > 0) {
    await sendAdminAlert(
      bot.telegram,
      `Bot restarted with ${resumable.length} in-flight bridge(s) — the poller will resume tracking them automatically.`
    );
    console.warn(`${resumable.length} in-flight bridge(s) resuming after restart.`);
  }

  if (needsManualReview.length > 0) {
    const lines = needsManualReview.map((b) =>
      `• ${b.direction} — ${b.amount_eth} ETH (user ${b.uid}, id ${b.id}, status: ${b.status})`
    );
    await sendAdminAlert(
      bot.telegram,
      `⚠️ Bot restarted with ${needsManualReview.length} bridge(s) that have NO source tx hash — ` +
      `unknown whether the source-chain transaction was ever sent. These CANNOT be auto-recovered ` +
      `by the poller and need manual verification (check the user's wallet/chain explorer):\n${lines.join('\n')}`
    );
    console.warn(`${needsManualReview.length} bridge(s) with no source_tx_hash need manual review after restart.`);
  }
}

export function startBridgePoller(bot) {
  setInterval(async () => {
    let inFlight;
    try {
      inFlight = getInFlightBridges();
    } catch (err) {
      console.error('Bridge poller: failed to read in-flight bridges:', err.message);
      return;
    }

    for (const b of inFlight) {
      if (!b.source_tx_hash) continue;
      try {
        const result = await checkBridgeStatusOnce({
          txHash: b.source_tx_hash,
          fromChain: b.from_chain,
          toChain: b.to_chain,
          bridgeTool: b.bridge_tool,
        });

        if (result.status === 'DONE') {
          markPendingBridgeDone(b.id, 'done', result.destTxHash);
          const destLink = result.destTxHash ? explorerTxUrlForChain(result.destTxHash, b.to_chain) : null;
          await bot.telegram.sendMessage(
            b.uid,
            `✅ Your bridge (${directionLabel(b.direction)}, ${b.amount_eth} ETH) has landed!` +
            (destLink ? `\n[View transaction](${destLink})` : ''),
            { parse_mode: 'Markdown' }
          ).catch((err) => console.error(`Failed to notify uid ${b.uid} of bridge completion:`, err.message));
        } else if (result.status === 'FAILED') {
          markPendingBridgeDone(b.id, 'failed', null);
          await bot.telegram.sendMessage(
            b.uid,
            `❌ Your bridge (${directionLabel(b.direction)}, ${b.amount_eth} ETH) failed on the destination side. Contact support if funds don't show up: panchi.eth@gmail.com`
          ).catch((err) => console.error(`Failed to notify uid ${b.uid} of bridge failure:`, err.message));
          await sendAdminAlert(bot.telegram, `Bridge FAILED for user ${b.uid}: ${b.direction}, ${b.amount_eth} ETH, tx ${b.source_tx_hash}`);
        }
      } catch (err) {
        console.error(`Bridge poller: status check failed for bridge ${b.id}:`, err.message);
      }
    }
  }, BRIDGE_POLL_INTERVAL_MS);
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

        const bal = await provider.getBalance(w.address).then((b) => Number(ethers.formatEther(b)));

        // Persisted in DB settings (not an in-memory Set) so this dedupe
        // survives a bot restart — otherwise every restart while a wallet
        // is still low re-sends the alert.
        if (bal < lowBalanceThresholdEth) {
          if (!settings.lowBalanceWarned) {
            updateSettings(w.uid, { lowBalanceWarned: true });
            await bot.telegram.sendMessage(
              w.uid,
              `⚠️ Low balance: *${w.name}* has ${bal.toFixed(4)} ETH, below your alert threshold of ${lowBalanceThresholdEth} ETH.\n` +
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

        const pos = getPosition(rule.uid, rule.wallet_id, rule.token_address);
        if (!pos || pos.tokenAmount <= 0) { markAutoRuleTriggered(rule.id); continue; }

        const market = await getTokenMarketData(rule.token_address).catch(() => null);
        const ethUsd = await getEthUsdPrice().catch(() => null);
        if (!market || !ethUsd) continue;

        const valueUsd = pos.tokenAmount * market.priceUsd;
        const costUsd = pos.costEth * ethUsd;
        if (costUsd <= 0) continue;
        const pnlPct = ((valueUsd - costUsd) / costUsd) * 100;

        let trigger = null;
        if (rule.tp_pct != null && pnlPct >= rule.tp_pct) trigger = 'take-profit';
        else if (rule.sl_pct != null && pnlPct <= -rule.sl_pct) trigger = 'stop-loss';
        if (!trigger) continue;

        // Wallet is mid-trade (manual, batch, or another poller) — skip this
        // cycle and retry next tick rather than retiring the rule outright.
        if (tradesInFlight.has(rule.uid)) continue;

        markAutoRuleTriggered(rule.id);

        const result = await performSellCore(rule.uid, wallet, rule.token_address, 100);
        if (result.ok) {
          const txLink = explorerTxUrl(result.txHash);
          await bot.telegram.sendMessage(
            rule.uid,
            `🎯 ${trigger === 'take-profit' ? 'Take-profit' : 'Stop-loss'} triggered on *${wallet.name}* (${pnlPct.toFixed(1)}%) — sold 100% of your ${market.symbol} position.` +
            (txLink ? `\n[View transaction](${txLink})` : ''),
            { parse_mode: 'Markdown' }
          ).catch((err) => console.error(`Failed to notify uid ${rule.uid} of auto-trade:`, err.message));
        } else {
          await bot.telegram.sendMessage(
            rule.uid,
            `⚠️ ${trigger === 'take-profit' ? 'Take-profit' : 'Stop-loss'} triggered on *${wallet.name}* but the sell failed: ${result.error}\nYour rule has been retired — set a new one if you'd like to try again.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          await sendAdminAlert(bot.telegram, `Auto-trade sell failed for uid ${rule.uid} on ${rule.token_address}: ${result.error}`);
        }
      } catch (err) {
        console.error(`Auto-trade poller: rule ${rule.id} failed:`, err.message);
      }
    }
  }, AUTO_TRADE_POLL_INTERVAL_MS);
}

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

        const market = await getTokenMarketData(order.token_address).catch(() => null);
        if (!market) continue;

        const crossed = order.side === 'buy'
          ? market.priceUsd <= order.trigger_price
          : market.priceUsd >= order.trigger_price;
        if (!crossed) continue;

        // Wallet is mid-trade elsewhere — skip this cycle and retry next
        // tick rather than marking the order filled/failed prematurely.
        if (tradesInFlight.has(order.uid)) continue;

        markLimitOrderDone(order.id, 'filled');

        if (order.side === 'buy') {
          const result = await performBuyCore(order.uid, wallet, order.token_address, order.amount);
          if (result.ok) {
            const txLink = explorerTxUrl(result.txHash);
            await bot.telegram.sendMessage(
              order.uid,
              `⏰ Limit buy filled on *${wallet.name}*: ${order.amount} ETH of ${market.symbol} @ ~$${market.priceUsd.toPrecision(4)}` +
              (txLink ? `\n[View transaction](${txLink})` : ''),
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          } else {
            markLimitOrderDone(order.id, 'failed');
            await bot.telegram.sendMessage(order.uid, `⚠️ Limit buy triggered on *${wallet.name}* but failed: ${result.error}`, { parse_mode: 'Markdown' }).catch(() => {});
            await sendAdminAlert(bot.telegram, `Limit buy failed for uid ${order.uid} on ${order.token_address}: ${result.error}`);
          }
        } else {
          const pos = getPosition(order.uid, order.wallet_id, order.token_address);
          if (!pos || pos.tokenAmount <= 0) continue;
          const pct = Math.min((order.amount / pos.tokenAmount) * 100, 100);
          const result = await performSellCore(order.uid, wallet, order.token_address, pct);
          if (result.ok) {
            const txLink = explorerTxUrl(result.txHash);
            await bot.telegram.sendMessage(
              order.uid,
              `⏰ Limit sell filled on *${wallet.name}*: ${order.amount.toFixed(4)} ${market.symbol} @ ~$${market.priceUsd.toPrecision(4)}` +
              (txLink ? `\n[View transaction](${txLink})` : ''),
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          } else {
            markLimitOrderDone(order.id, 'failed');
            await bot.telegram.sendMessage(order.uid, `⚠️ Limit sell triggered on *${wallet.name}* but failed: ${result.error}`, { parse_mode: 'Markdown' }).catch(() => {});
            await sendAdminAlert(bot.telegram, `Limit sell failed for uid ${order.uid} on ${order.token_address}: ${result.error}`);
          }
        }
      } catch (err) {
        console.error(`Limit order poller: order ${order.id} failed:`, err.message);
      }
    }
  }, LIMIT_ORDER_POLL_INTERVAL_MS);
}
