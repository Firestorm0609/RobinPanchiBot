import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { ethers } from 'ethers';
import { createWallet, importWallet, shortAddr } from './wallet.js';
import { getEthUsdPrice, getTokenMarketData, fmtUsd } from './price.js';
import { getBridgeQuote, estimateBridgeGasEth, checkBridgeStatusOnce, BRIDGE_DIRECTION, chainIdsForDirection, ETH_CHAIN_ID } from './bridge.js';
import { sendAdminAlert } from './alerts.js';
import { isRateLimited } from './ratelimit.js';
import { generateFlexCard } from './pnl-card.js';
import {
  getUser,
  addWallet,
  removeWallet,
  renameWallet,
  setActiveWallet,
  getActiveWallet,
  getWallet,
  recordTrade,
  getPosition,
  getAllPositions,
  getAllPositionsForUser,
  getSettings,
  updateSettings,
  getStats,
  hasAgreedTerms,
  setAgreedTerms,
  getOrCreateReferralCode,
  findUidByReferralCode,
  recordReferral,
  getTicketCount,
  hasBeenReferred,
  getBridgeHistory,
  createAutoRule,
  cancelAutoRule,
  getActiveAutoRuleForPosition,
  createLimitOrder,
  cancelLimitOrder,
  getOpenLimitOrdersForUser,
  getInFlightBridges,
  markPendingBridgeDone,
} from './storage.js';

import { validateEnv, provider, ethMainnetProvider, CA_REGEX, FALLBACK_GAS_LIMIT_BUY, FALLBACK_GAS_LIMIT_SELL, MAX_BATCH_FUND_NEW_WALLETS, GAS_TIERS, TERMS_TEXT, HELP_TEXT, WELCOME_TEXT } from './config.js';
import {
  pending, fundsInFlight, lowBalanceWarned, botIdentity, gasMultiplierFor,
  autoRefreshTimers, stopAutoRefresh,
  positionsRefreshTimers, stopPositionsRefresh,
  portfolioRefreshTimers, stopPortfolioRefresh,
  stopAllViewRefreshes, stopAllAutoRefreshes,
} from './state.js';
import { dualEthBalanceLines, getBridgeBalances, fmtBridgeBalanceLine, gasEstimateLine, friendlyErrorMessage, parseEthOrUsdInput, parseBridgeAmountInput, parseMcapInput, mcapToPrice, fmtEth, fmtAmountLabel } from './format.js';
import {
  mainMenu, walletsMenu, walletDetailMenu, exportConfirmMenu, settingsMenu, rewardsMenu,
  bridgeMenu, bridgeConfirmMenu, directionLabel, tokenMenu, batchSelectMenu, batchSellSelectMenu,
  batchFundSelectMenu, collectSelectMenu, confirmMenu, renderTokenCard, limitOrdersText, limitOrdersMenu,
  renderPositionsView, renderPortfolioView,
} from './menus.js';
import { executeBuy, executeSell, performBuyCore, performSellCore, estimateTransferGasReserve, distributeEth, performCollectCore } from './trade-core.js';
import { executeBridge } from './bridge-actions.js';
import {
  checkStuckTrades, checkStuckBridges, startBridgePoller, startLowBalancePoller,
  startAutoTradePoller, startLimitOrderPoller,
} from './pollers.js';

validateEnv();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.telegram.getMe()
  .then((me) => { botIdentity.username = me.username; })
  .catch((err) => console.error('Failed to fetch bot username:', err.message));

function referralLink(code) {
  return `https://t.me/${botIdentity.username || 'your_bot'}?start=ref_${code}`;
}

// ---------- Live-view auto-refresh (every 30s) ----------
// Keeps the last-viewed token card / positions list / portfolio summary live
// in place without the user having to tap Refresh. Only one of each runs per
// user — each call clears any prior timer of that kind for that uid.

const AUTO_REFRESH_INTERVAL_MS = 30_000;

function scheduleCardAutoRefresh(uid, tokenAddress, chatId, messageId) {
  stopAutoRefresh(uid);
  const key = String(uid);
  const timer = setInterval(async () => {
    try {
      const { text, markup } = await renderTokenCard(uid, tokenAddress);
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        ...markup,
      });
    } catch (err) {
      // "message is not modified" just means nothing changed since last
      // tick — not an error, keep the timer running.
      if (err.description?.includes('message is not modified')) return;
      // Anything else (message deleted, chat gone, bot blocked, user
      // navigated away and the message no longer exists) — stop trying.
      stopAutoRefresh(key);
    }
  }, AUTO_REFRESH_INTERVAL_MS);
  autoRefreshTimers.set(key, timer);
}

function schedulePositionsAutoRefresh(uid, chatId, messageId) {
  stopPositionsRefresh(uid);
  const key = String(uid);
  const timer = setInterval(async () => {
    try {
      const { text, markup } = await renderPositionsView(uid);
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        ...markup,
      });
    } catch (err) {
      if (err.description?.includes('message is not modified')) return;
      stopPositionsRefresh(key);
    }
  }, AUTO_REFRESH_INTERVAL_MS);
  positionsRefreshTimers.set(key, timer);
}

function schedulePortfolioAutoRefresh(uid, chatId, messageId) {
  stopPortfolioRefresh(uid);
  const key = String(uid);
  const timer = setInterval(async () => {
    try {
      const { text, markup } = await renderPortfolioView(uid);
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        ...markup,
      });
    } catch (err) {
      if (err.description?.includes('message is not modified')) return;
      stopPortfolioRefresh(key);
    }
  }, AUTO_REFRESH_INTERVAL_MS);
  portfolioRefreshTimers.set(key, timer);
}

// ---------- Start / Main menu ----------

bot.start(async (ctx) => {
  const uid = ctx.from.id;
  const payload = ctx.startPayload;

  if (payload && payload.startsWith('ref_') && !hasBeenReferred(uid)) {
    const code = payload.slice(4);
    const referrerUid = findUidByReferralCode(code);
    if (referrerUid) recordReferral(referrerUid, uid);
  }

  if (!hasAgreedTerms(uid)) {
    return ctx.reply(TERMS_TEXT, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ I understand, continue', 'agree_terms')]]),
    });
  }
  ctx.reply(WELCOME_TEXT, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

bot.command('help', async (ctx) => {
  await ctx.reply(HELP_TEXT, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Main Menu', 'menu_main')]]),
  });
});

bot.command('flex', async (ctx) => {
  const uid = ctx.from.id;
  const arg = ctx.message.text.split(/\s+/)[1];

  if (!arg || !CA_REGEX.test(arg)) {
    return ctx.reply('Usage: `/flex <contract_address>` — paste a token CA to flex your position.', { parse_mode: 'Markdown' });
  }

  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

  try {
    // generateFlexCard handles both an open position (live unrealized PnL)
    // and a closed one (realized PnL from trade history) — it returns null
    // only if there's no trade history at all for this token on this wallet,
    // or market/price data is unavailable.
    const cardBuffer = await generateFlexCard(uid, arg);
    if (!cardBuffer) {
      return ctx.reply('No trade history on that token for your active wallet — nothing to flex.', mainMenu());
    }
    await ctx.replyWithPhoto({ source: cardBuffer });
  } catch (err) {
    console.error('Flex card generation failed:', err.message);
    await ctx.reply('❌ Failed to generate flex card. Try again shortly.', mainMenu());
  }
});

bot.action('agree_terms', async (ctx) => {
  setAgreedTerms(ctx.from.id);
  await ctx.answerCbQuery('Thanks — happy trading');
  await ctx.editMessageText(WELCOME_TEXT, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

bot.command('admin_stats', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_CHAT_ID)) return;
  const s = getStats();
  const feeBps = Number(process.env.AFFILIATE_FEE_BPS || 0);
  const estFeesEth = (s.totalVolumeEth * feeBps) / 10000;
  await ctx.reply(
    `📊 *Admin Stats*\n\n` +
    `Users: ${s.totalUsers}\n` +
    `Wallets: ${s.totalWallets}\n` +
    `Open positions: ${s.openPositions}\n` +
    `Total trades: ${s.totalTrades}\n` +
    `Total volume: ${s.totalVolumeEth.toFixed(4)} ETH\n` +
    `Est. fees earned: ${estFeesEth.toFixed(4)} ETH\n` +
    `Total referrals: ${s.totalReferrals}\n` +
    `Total bridges: ${s.totalBridges} (completed volume: ${s.totalBridgeVolumeEth.toFixed(4)} ETH)\n` +
    `Active TP/SL rules: ${s.activeAutoRules}\n` +
    `Open limit orders: ${s.openLimitOrders}\n\n` +
    `Last 24h:\n` +
    `Active users: ${s.activeUsers24h}\n` +
    `Volume: ${s.volume24hEth.toFixed(4)} ETH`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('admin_bridges', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_CHAT_ID)) return;

  const stuck = getInFlightBridges();
  if (stuck.length === 0) {
    await ctx.reply('No bridges currently pending/submitted.');
    return;
  }

  await ctx.reply(`Checking ${stuck.length} in-flight bridge(s)...`);

  for (const b of stuck) {
    const header = `*${b.id}* — ${directionLabel(b.direction)} — ${b.amount_eth} ETH (user ${b.uid})`;
    if (!b.source_tx_hash) {
      await ctx.reply(`${header}\nStatus: no source tx hash recorded — cannot recheck, needs manual verification.`, { parse_mode: 'Markdown' });
      continue;
    }
    try {
      const result = await checkBridgeStatusOnce({
        txHash: b.source_tx_hash,
        fromChain: b.from_chain,
        toChain: b.to_chain,
        bridgeTool: b.bridge_tool,
      });
      if (result.status === 'DONE') {
        markPendingBridgeDone(b.id, 'done', result.destTxHash);
        await ctx.reply(`${header}\n✅ LI.FI reports DONE — marked as completed.`, { parse_mode: 'Markdown' });
      } else if (result.status === 'FAILED') {
        markPendingBridgeDone(b.id, 'failed', null);
        await ctx.reply(`${header}\n❌ LI.FI reports FAILED — marked as failed.`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(`${header}\n⏳ LI.FI still reports PENDING. Source tx: \`${b.source_tx_hash}\``, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      await ctx.reply(`${header}\n⚠️ Status check errored: ${friendlyErrorMessage(err)}\nSource tx: \`${b.source_tx_hash}\``, { parse_mode: 'Markdown' });
    }
  }
});

bot.action('menu_main', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  await ctx.editMessageText('🌴 *RobinPanchi Trading Bot*', { parse_mode: 'Markdown', ...mainMenu() });
});

bot.action('menu_trade', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  pending.set(ctx.from.id, { type: 'awaiting_ca' });
  await ctx.editMessageText('Paste the token contract address:');
});

bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  await ctx.editMessageText(HELP_TEXT, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});

// ---------- Wallets ----------

bot.action('menu_wallets', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const user = getUser(uid);
  const header = user.wallets.length === 0
    ? 'No wallets yet. Create or import one to get started.'
    : '💼 *Your Wallets*\n✅ = active wallet for trading';
  await ctx.editMessageText(header, { parse_mode: 'Markdown', ...walletsMenu(uid) });
});

bot.action('wallet_create', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'create_name' });
  await ctx.editMessageText('Send a name for this new wallet (e.g. "Main"):');
});

bot.action('wallet_import', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'import_name' });
  await ctx.editMessageText('Send a name for the imported wallet (e.g. "Cold Wallet"):');
});

bot.action(/^wallet_activate_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Active wallet updated');
  setActiveWallet(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText('💼 *Your Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ctx.from.id) });
});

bot.action(/^wallet_rename_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'rename', walletId: ctx.match[1] });
  await ctx.editMessageText('Send the new name for this wallet:');
});

bot.action(/^wallet_remove_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Wallet removed');
  removeWallet(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText('💼 *Your Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ctx.from.id) });
});

bot.action(/^wallet_export_confirm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  pending.set(ctx.from.id, { type: 'export_type_confirm', walletId: w.id, walletName: w.name });
  await ctx.editMessageText(
    `⚠️ Type the wallet's name exactly (*${w.name}*) to confirm you want to reveal its private key:`,
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^wallet_export_(?!confirm)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  await ctx.editMessageText(
    `⚠️ This will display the raw private key for *${w.name}* in this chat.\n\nAnyone who sees it can take everything in this wallet. Continue?`,
    { parse_mode: 'Markdown', ...exportConfirmMenu(w.id) }
  );
});

bot.action(/^wallet_(?!create|import|activate|rename|remove|export)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  const bal = await dualEthBalanceLines(w.address).catch(() => 'unavailable');
  await ctx.editMessageText(`*${w.name}*\n\`${w.address}\`\n\nBalance:\n${bal}`, {
    parse_mode: 'Markdown',
    ...walletDetailMenu(w.id),
  });
});

// ---------- Positions ----------

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  stopAutoRefresh(uid);
  stopPortfolioRefresh(uid);

  const { text, markup } = await renderPositionsView(uid);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup });

  if (ctx.callbackQuery?.message?.message_id) {
    schedulePositionsAutoRefresh(uid, ctx.chat.id, ctx.callbackQuery.message.message_id);
  }
});

bot.action('menu_positions_refresh', async (ctx) => {
  await ctx.answerCbQuery('Refreshed');
  const uid = ctx.from.id;
  const { text, markup } = await renderPositionsView(uid);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup }).catch((err) => {
    if (!err.description?.includes('message is not modified')) throw err;
  });
  if (ctx.callbackQuery?.message?.message_id) {
    schedulePositionsAutoRefresh(uid, ctx.chat.id, ctx.callbackQuery.message.message_id);
  }
});

// ---------- Portfolio-wide PnL summary ----------

bot.action('menu_portfolio', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  stopAutoRefresh(uid);
  stopPositionsRefresh(uid);

  const { text, markup } = await renderPortfolioView(uid);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup });

  if (ctx.callbackQuery?.message?.message_id) {
    schedulePortfolioAutoRefresh(uid, ctx.chat.id, ctx.callbackQuery.message.message_id);
  }
});

bot.action('menu_portfolio_refresh', async (ctx) => {
  await ctx.answerCbQuery('Refreshed');
  const uid = ctx.from.id;
  const { text, markup } = await renderPortfolioView(uid);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup }).catch((err) => {
    if (!err.description?.includes('message is not modified')) throw err;
  });
  if (ctx.callbackQuery?.message?.message_id) {
    schedulePortfolioAutoRefresh(uid, ctx.chat.id, ctx.callbackQuery.message.message_id);
  }
});

// ---------- Settings ----------

bot.action('menu_settings', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

bot.action('settings_buy', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_buy' });
  await ctx.editMessageText('Send comma-separated USD amounts, e.g. `10, 50, 200`', { parse_mode: 'Markdown' });
});

bot.action('settings_sell', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_sell' });
  await ctx.editMessageText('Send comma-separated sell percentages, e.g. `25, 50, 75, 100`', { parse_mode: 'Markdown' });
});

bot.action('settings_slippage', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_slippage' });
  await ctx.editMessageText('Send slippage tolerance as a percentage, e.g. `1` for 1%', { parse_mode: 'Markdown' });
});

bot.action('settings_maxbuy', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_maxbuy' });
  await ctx.editMessageText('Send the max USD allowed per single buy, e.g. `500`', { parse_mode: 'Markdown' });
});

bot.action('settings_maxbridge', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_maxbridge' });
  await ctx.editMessageText('Send the max USD allowed per single bridge, e.g. `500`', { parse_mode: 'Markdown' });
});

bot.action('settings_gastier', async (ctx) => {
  const s = getSettings(ctx.from.id);
  const idx = GAS_TIERS.indexOf(s.gasTier);
  const next = GAS_TIERS[(idx + 1) % GAS_TIERS.length];
  updateSettings(ctx.from.id, { gasTier: next });
  await ctx.answerCbQuery(`Gas priority set to ${next}`);
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

bot.action('settings_lowbalance', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_lowbalance' });
  await ctx.editMessageText(
    'Send the ETH balance threshold to alert on, e.g. `0.01`. Send `0` to disable low-balance alerts.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('settings_toggle_confirm', async (ctx) => {
  const s = getSettings(ctx.from.id);
  updateSettings(ctx.from.id, { confirmTrades: !s.confirmTrades });
  await ctx.answerCbQuery(`Confirmation ${!s.confirmTrades ? 'enabled' : 'disabled'}`);
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

// FIX: menus.js renders a "Flex card PnL: ... (tap to cycle)" button with
// callback_data 'settings_flexpnl', but there was previously no bot.action
// handler registered for it at all — tapping it silently did nothing since
// Telegraf has no matching handler to invoke. Cycles eth -> usd -> hidden.
bot.action('settings_flexpnl', async (ctx) => {
  const FLEX_PNL_MODES = ['eth', 'usd', 'hidden'];
  const s = getSettings(ctx.from.id);
  const idx = FLEX_PNL_MODES.indexOf(s.flexPnlMode);
  const next = FLEX_PNL_MODES[(idx + 1) % FLEX_PNL_MODES.length];
  updateSettings(ctx.from.id, { flexPnlMode: next });
  await ctx.answerCbQuery(`Flex card PnL set to ${next}`);
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

// ---------- Rewards ----------

bot.action('menu_rewards', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const tickets = getTicketCount(uid);
  await ctx.editMessageText(
    `🎟 *Rewards*\n\n` +
    `Refer friends to earn raffle tickets for a chance to win a Panchi NFT.\n` +
    `1 successful referral = 1 ticket. No limit.\n\n` +
    `Your tickets: *${tickets}*`,
    { parse_mode: 'Markdown', ...rewardsMenu() }
  );
});

bot.action('rewards_link', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const code = getOrCreateReferralCode(uid);
  const link = referralLink(code);
  await ctx.editMessageText(
    `🔗 *Your referral link:*\n\`${link}\`\n\n` +
    `Share it — when someone starts the bot through it, you get a raffle ticket.`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_rewards')]]) }
  );
});

// ---------- Bridge ----------

bot.action('menu_bridge', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));

  await ctx.editMessageText('🌉 *Bridge ETH*\n\nFetching your balances...', { parse_mode: 'Markdown' });

  const [balances, ethUsd] = await Promise.all([
    getBridgeBalances(w.address),
    getEthUsdPrice().catch(() => null),
  ]);

  const balanceLinesArr = [
    fmtBridgeBalanceLine('Ethereum — ETH', balances.ethMainnet, ethUsd),
    fmtBridgeBalanceLine('Robinhood — ETH', balances.ethRobinhood, ethUsd),
    fmtBridgeBalanceLine('Robinhood — USDG', balances.usdgRobinhood, balances.usdgRobinhood !== null ? 1 : null),
  ];

  await ctx.editMessageText(
    `🌉 *Bridge ETH*\n\n` +
    `Move ETH between Ethereum mainnet and Robinhood Chain.\n` +
    `Active wallet: *${w.name}* (\`${shortAddr(w.address)}\`)\n\n` +
    `*Your balances:*\n${balanceLinesArr.join('\n')}\n\n` +
    `You'll be able to enter the amount in USD or ETH.`,
    { parse_mode: 'Markdown', ...bridgeMenu() }
  );
});

bot.action(/^bridge_dir_(eth_to_robinhood|robinhood_to_eth)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const direction = ctx.match[1] === 'eth_to_robinhood' ? BRIDGE_DIRECTION.ETH_TO_ROBINHOOD : BRIDGE_DIRECTION.ROBINHOOD_TO_ETH;
  pending.set(ctx.from.id, { type: 'bridge_amount', direction });

  const w = getActiveWallet(ctx.from.id);
  let sourceBalanceLine = '';
  if (w) {
    const sourceProvider = direction === BRIDGE_DIRECTION.ETH_TO_ROBINHOOD ? ethMainnetProvider : provider;
    const bal = await sourceProvider.getBalance(w.address).then((b) => Number(ethers.formatEther(b))).catch(() => null);
    if (bal !== null) sourceBalanceLine = `\nAvailable: ${fmtEth(bal)} ETH\n`;
  }

  await ctx.editMessageText(
    `Send the amount to bridge (${directionLabel(direction)}) — USD like \`100\`, or ETH like \`0.05 eth\`:${sourceBalanceLine}`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('bridge_history', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const history = getBridgeHistory(uid, 10);
  if (history.length === 0) {
    return ctx.editMessageText('No bridges yet.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_bridge')]]),
    });
  }
  const statusEmoji = { pending: '⏳', submitted: '⏳', done: '✅', failed: '❌' };
  const lines = history.map((b) =>
    `${statusEmoji[b.status] || '•'} ${directionLabel(b.direction)} — ${b.amount_eth} ETH (${b.status})`
  );
  await ctx.editMessageText(`🕘 *Recent Bridges*\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_bridge')]]),
  });
});

// ---------- Custom buy/sell prompts ----------

bot.action(/^custombuy_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_buy', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send the amount to spend — USD like `100`, or ETH like `0.03 eth`:',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^customsell_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_sell', tokenAddress: ctx.match[1] });
  await ctx.editMessageText('Send the percentage to sell, e.g. `40` for 40%');
});

// ---------- Auto TP/SL ----------

bot.action(/^tpsl_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'tpsl_input', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send take-profit and stop-loss as percentages, comma-separated: `TP,SL`\n' +
    'e.g. `50,20` = sell 100% at +50% gain OR -20% loss, whichever hits first.\n' +
    'Send `0` for a side to skip it, e.g. `50,0` for TP-only.\n\n' +
    'This replaces any existing rule on this position.',
    { parse_mode: 'Markdown' }
  );
});

// ---------- Limit orders ----------

bot.action(/^limitbuy_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'limitbuy_mcap', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send the target *market cap* to buy at (fires when mcap drops to or below this).\n' +
    'Use shorthand: `50k`, `2.5m`, `1b` — or a plain number.',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^limitsell_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'limitsell_mcap', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send the target *market cap* to sell at (fires when mcap rises to or above this).\n' +
    'Use shorthand: `50k`, `2.5m`, `1b` — or a plain number.',
    { parse_mode: 'Markdown' }
  );
});

// ---------- Limit order list / cancel ----------

bot.action('menu_limitorders', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const orders = getOpenLimitOrdersForUser(uid);

  const marketByToken = new Map();
  for (const o of orders) {
    if (!marketByToken.has(o.token_address)) {
      const market = await getTokenMarketData(o.token_address).catch(() => null);
      marketByToken.set(o.token_address, market);
      o._symbol = market?.symbol ?? shortAddr(o.token_address);
    } else {
      o._symbol = marketByToken.get(o.token_address)?.symbol ?? shortAddr(o.token_address);
    }
  }

  await ctx.editMessageText(limitOrdersText(orders, marketByToken), {
    parse_mode: 'Markdown',
    ...limitOrdersMenu(orders),
  });
});

bot.action(/^limitordercancel_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const cancelled = cancelLimitOrder(uid, ctx.match[1]);
  await ctx.answerCbQuery(cancelled ? 'Order cancelled' : 'Could not cancel (already filled/cancelled?)');

  const orders = getOpenLimitOrdersForUser(uid);
  const marketByToken = new Map();
  for (const o of orders) {
    if (!marketByToken.has(o.token_address)) {
      const market = await getTokenMarketData(o.token_address).catch(() => null);
      marketByToken.set(o.token_address, market);
    }
    o._symbol = marketByToken.get(o.token_address)?.symbol ?? shortAddr(o.token_address);
  }

  await ctx.editMessageText(limitOrdersText(orders, marketByToken), {
    parse_mode: 'Markdown',
    ...limitOrdersMenu(orders),
  }).catch(() => {});
});

// ---------- Batch Buy ----------

bot.action(/^batchbuy_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);
  if (user.wallets.length < 2) return ctx.reply('You need at least 2 wallets to use Batch Buy.', mainMenu());
  pending.set(uid, { type: 'batch_amount', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send the amount to buy on EACH selected wallet — USD like `50`, or ETH like `0.02 eth`:',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^batchtoggle_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batch_select') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const walletId = ctx.match[1];
  const idx = state.selected.indexOf(walletId);
  if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(walletId);
  pending.set(uid, state);
  await ctx.editMessageText('Select wallets to buy on:', batchSelectMenu(uid, state.selected)).catch(() => {});
});

bot.action('batchconfirm', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batch_select') return;
  if (state.selected.length === 0) return ctx.reply('No wallets selected — tap wallets to select, then Confirm.');
  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  const { maxBuyEth } = getSettings(uid);
  if (state.ethAmount > maxBuyEth) {
    pending.delete(uid);
    return ctx.reply(`❌ ${fmtAmountLabel(state.ethAmount, state.usdInput)} exceeds your max buy size.`, mainMenu());
  }

  pending.delete(uid);
  const label = fmtAmountLabel(state.ethAmount, state.usdInput);
  await ctx.editMessageText(`Buying ${label} on ${state.selected.length} wallet(s)... this may take a moment.`);

  const results = [];
  for (const walletId of state.selected) {
    const w = getWallet(uid, walletId);
    if (!w) { results.push({ ok: false, walletName: walletId, error: 'Wallet not found.' }); continue; }
    const result = await performBuyCore(uid, w, state.tokenAddress, state.ethAmount);
    results.push(result);
  }

  const lines = results.map((r) =>
    r.ok ? `✅ ${r.walletName}: bought (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
  );
  await ctx.reply(`📦 *Batch Buy Results* — ${label} each\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

// ---------- Batch Sell ----------

bot.action(/^batchsell_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);
  if (user.wallets.length < 2) return ctx.reply('You need at least 2 wallets to use Batch Sell.', mainMenu());
  pending.set(uid, { type: 'batchsell_pct', tokenAddress: ctx.match[1] });
  await ctx.editMessageText('Send the percentage to sell on EACH wallet holding this token, e.g. `50` for 50%', { parse_mode: 'Markdown' });
});

bot.action(/^bselltoggle_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batchsell_select') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const walletId = ctx.match[1];
  const idx = state.selected.indexOf(walletId);
  if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(walletId);
  pending.set(uid, state);
  await ctx.editMessageText(
    'Select wallets to sell on:',
    batchSellSelectMenu(state.candidates, state.selected)
  ).catch(() => {});
});

bot.action('batchsellconfirm', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batchsell_select') return;
  if (state.selected.length === 0) return ctx.reply('No wallets selected — tap wallets to select, then Confirm.');
  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  pending.delete(uid);
  await ctx.editMessageText(`Selling ${state.pct}% on ${state.selected.length} wallet(s)... this may take a moment.`);

  const results = [];
  for (const walletId of state.selected) {
    const w = getWallet(uid, walletId);
    if (!w) { results.push({ ok: false, walletName: walletId, error: 'Wallet not found.' }); continue; }
    const result = await performSellCore(uid, w, state.tokenAddress, state.pct);
    results.push(result);
  }

  const lines = results.map((r) =>
    r.ok ? `✅ ${r.walletName}: sold (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
  );
  await ctx.reply(`📦 *Batch Sell Results* — ${state.pct}% each\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

// ---------- Batch Fund ----------

bot.action('batchfund_start', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);

  if (user.wallets.length === 0) {
    return ctx.editMessageText('No wallets yet. Create one first.', walletsMenu(uid));
  }

  if (user.wallets.length === 1) {
    pending.set(uid, { type: 'batchfund_create_count', sourceWalletId: user.wallets[0].id });
    await ctx.editMessageText(
      `You only have one wallet (*${user.wallets[0].name}*).\n\n` +
      `How many new wallets would you like to create and fund from it? (max ${MAX_BATCH_FUND_NEW_WALLETS})`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.editMessageText('📤 *Batch Fund*\n\nChecking wallet balances...', { parse_mode: 'Markdown' });

  const balances = await Promise.all(
    user.wallets.map(async (w) => ({
      ...w,
      balance: await provider.getBalance(w.address).then((b) => Number(ethers.formatEther(b))).catch(() => 0),
    }))
  );
  const source = balances.reduce((a, b) => (b.balance > a.balance ? b : a));

  if (source.balance <= 0) {
    pending.delete(uid);
    return ctx.editMessageText(
      '📤 *Batch Fund*\n\nNone of your wallets have an ETH balance to fund others with. Add funds to a wallet first.',
      { parse_mode: 'Markdown', ...walletsMenu(uid) }
    );
  }

  const candidates = balances.filter((w) => w.id !== source.id);

  pending.set(uid, { type: 'batchfund_select', sourceWalletId: source.id, candidates, selected: [] });

  await ctx.editMessageText(
    `📤 *Batch Fund*\n\n` +
    `Source wallet: *${source.name}* — ${source.balance.toFixed(4)} ETH\n\n` +
    `Select which wallets to fund (the amount you choose next will be sent to EACH one):`,
    { parse_mode: 'Markdown', ...batchFundSelectMenu(candidates, []) }
  );
});

bot.action(/^bfundtoggle_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batchfund_select') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const walletId = ctx.match[1];
  const idx = state.selected.indexOf(walletId);
  if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(walletId);
  pending.set(uid, state);
  await ctx.editMessageText(
    'Select which wallets to fund:',
    batchFundSelectMenu(state.candidates, state.selected)
  ).catch(() => {});
});

bot.action('bfundconfirm', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batchfund_select') return;
  if (state.selected.length === 0) return ctx.reply('No wallets selected — tap wallets to select, then Confirm.');

  pending.set(uid, {
    type: 'batchfund_amount',
    sourceWalletId: state.sourceWalletId,
    targets: state.candidates.filter((w) => state.selected.includes(w.id)),
  });
  await ctx.editMessageText(
    'Send the amount to send to EACH selected wallet — USD like `50`, or ETH like `0.02 eth`:',
    { parse_mode: 'Markdown' }
  );
});

// ---------- Batch Collect ----------

bot.action('collect_start', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);
  if (user.wallets.length < 2) return ctx.editMessageText('You need at least 2 wallets to use Batch Collect.', walletsMenu(uid));

  pending.set(uid, { type: 'collect_select_dest' });
  const rows = user.wallets.map((w) => [Markup.button.callback(`${w.name} (${shortAddr(w.address)})`, `collectdest_${w.id}`)]);
  rows.push([Markup.button.callback('❌ Cancel', 'menu_wallets')]);
  await ctx.editMessageText(
    '📥 *Batch Collect*\n\nChoose the destination wallet — ETH and all tokens from your other wallets will be swept here:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
});

bot.action(/^collectdest_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const dest = getWallet(uid, ctx.match[1]);
  if (!dest) return ctx.editMessageText('Wallet not found.', walletsMenu(uid));

  const user = getUser(uid);
  const candidates = user.wallets.filter((w) => w.id !== dest.id);
  const allIds = candidates.map((w) => w.id);
  pending.set(uid, { type: 'collect_select_sources', destWalletId: dest.id, destName: dest.name, destAddress: dest.address, candidates, selected: allIds });

  await ctx.editMessageText(
    `📥 *Batch Collect* → *${dest.name}*\n\nSelect source wallets to sweep from (all selected by default):`,
    { parse_mode: 'Markdown', ...collectSelectMenu(candidates, allIds) }
  );
});

bot.action(/^collecttoggle_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'collect_select_sources') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const walletId = ctx.match[1];
  const idx = state.selected.indexOf(walletId);
  if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(walletId);
  pending.set(uid, state);
  await ctx.editMessageText(
    `📥 *Batch Collect* → *${state.destName}*\n\nSelect source wallets to sweep from:`,
    { parse_mode: 'Markdown', ...collectSelectMenu(state.candidates, state.selected) }
  ).catch(() => {});
});

bot.action('collectconfirm', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'collect_select_sources') return;
  if (state.selected.length === 0) return ctx.reply('No wallets selected — tap wallets to select, then Confirm.');
  if (fundsInFlight.has(uid)) return ctx.reply('⏳ A batch fund/collect run is already in progress — please wait for it to finish.');
  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  const dest = getWallet(uid, state.destWalletId);
  if (!dest) { pending.delete(uid); return ctx.reply('Destination wallet not found.', walletsMenu(uid)); }
  const sources = state.candidates.filter((w) => state.selected.includes(w.id));

  fundsInFlight.add(uid);
  pending.delete(uid);
  await ctx.editMessageText(`Sweeping ETH + tokens from ${sources.length} wallet(s) into *${dest.name}*... this may take a moment.`, { parse_mode: 'Markdown' });

  try {
    const gasMultiplier = gasMultiplierFor(uid);
    const lines = [];
    for (const src of sources) {
      const wallet = getWallet(uid, src.id);
      if (!wallet) { lines.push(`*${src.name}*: ❌ wallet not found`); continue; }
      const results = await performCollectCore(uid, wallet, dest.address, gasMultiplier);
      lines.push(`*${wallet.name}*:`);
      if (results.length === 0) {
        lines.push('  nothing to collect');
      } else {
        for (const r of results) {
          lines.push(r.ok ? `  ✅ ${r.label}: sent (tx \`${r.txHash.slice(0, 12)}...\`)` : `  ❌ ${r.label}: ${r.error}`);
        }
      }
    }
    await ctx.reply(`📥 *Batch Collect Results* → ${dest.name}\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...mainMenu() });
  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ Batch collect failed: ${friendlyErrorMessage(err)}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Batch collect failed for user ${uid}: ${err.message}`);
  } finally {
    fundsInFlight.delete(uid);
  }
});

// ---------- Balance ----------

bot.action('menu_balance', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));
  const bal = await dualEthBalanceLines(w.address);
  await ctx.editMessageText(`💰 *${w.name}*\n\`${w.address}\`\n\nBalance:\n${bal}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});

// ---------- Token card: refresh ----------

bot.action(/^refresh_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Refreshed');
  const tokenAddress = ctx.match[1];
  const uid = ctx.from.id;
  stopPositionsRefresh(uid);
  stopPortfolioRefresh(uid);
  const { text, markup } = await renderTokenCard(uid, tokenAddress);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup }).catch((err) => {
    if (!err.description?.includes('message is not modified')) throw err;
  });
  scheduleCardAutoRefresh(uid, tokenAddress, ctx.chat.id, ctx.callbackQuery.message.message_id);
});

// ---------- Buy ----------

bot.action(/^buy_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const [, tokenAddress, ethAmountStr] = ctx.match;
  const uid = ctx.from.id;
  const { confirmTrades, maxBuyEth } = getSettings(uid);
  const ethAmount = Number(ethAmountStr);
  const ethUsd = await getEthUsdPrice().catch(() => null);
  const label = fmtAmountLabel(ethAmount, ethUsd ? ethAmount * ethUsd : null);
  if (ethAmount > maxBuyEth) {
    return ctx.editMessageText(`❌ ${label} exceeds your max buy size.`, mainMenu());
  }
  if (confirmTrades) {
    const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_BUY);
    await ctx.editMessageText(`Confirm: buy *${label}* worth of this token?${gasLine}`, {
      parse_mode: 'Markdown',
      ...confirmMenu('buy', tokenAddress, ethAmountStr),
    });
  } else {
    await executeBuy(ctx, uid, tokenAddress, ethAmount);
  }
});

// ---------- Sell ----------
// NOTE: percentage capture group is [\d.]+ (not \d+) so that decimal sell
// percentages — which both `custom_sell` and `settings_sell` freely accept
// via parseFloat — actually match here. With plain \d+, a preset or custom
// value like "33.5" produced a callback_data with no matching handler, so
// tapping the button silently did nothing.

bot.action(/^sell_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const [, tokenAddress, pctStr] = ctx.match;
  const uid = ctx.from.id;
  const { confirmTrades } = getSettings(uid);
  if (confirmTrades) {
    const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_SELL);
    await ctx.editMessageText(`Confirm: sell *${pctStr}%* of your position?${gasLine}`, {
      parse_mode: 'Markdown',
      ...confirmMenu('sell', tokenAddress, pctStr),
    });
  } else {
    await executeSell(ctx, uid, tokenAddress, Number(pctStr));
  }
});

bot.action(/^confirm_buy_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  await executeBuy(ctx, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

bot.action(/^confirm_sell_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  await executeSell(ctx, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

// ---------- Bridge confirm ----------

bot.action(/^bridge_confirm_(eth_to_robinhood|robinhood_to_eth)_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const direction = ctx.match[1] === 'eth_to_robinhood' ? BRIDGE_DIRECTION.ETH_TO_ROBINHOOD : BRIDGE_DIRECTION.ROBINHOOD_TO_ETH;
  await executeBridge(ctx, ctx.from.id, direction, Number(ctx.match[2]));
});

bot.action('cancel_trade', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('Trade cancelled.', mainMenu());
});

// ---------- Free-text handler ----------

bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  const text = ctx.message.text.trim();

  if (CA_REGEX.test(text)) {
    if (!hasAgreedTerms(uid)) {
      return ctx.reply(TERMS_TEXT, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ I understand, continue', 'agree_terms')]]),
      });
    }
    if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many lookups in the last minute.');
    pending.delete(uid);
    stopPositionsRefresh(uid);
    stopPortfolioRefresh(uid);
    const { text: cardText, markup } = await renderTokenCard(uid, text);
    const sent = await ctx.reply(cardText, { parse_mode: 'Markdown', ...markup });
    scheduleCardAutoRefresh(uid, text, sent.chat.id, sent.message_id);
    return;
  }

  if (!state) return;

  try {
    if (state.type === 'awaiting_ca') {
      await ctx.reply('That doesn\'t look like a valid contract address. Paste a valid 0x... address.');
      return;
    }

    if (state.type === 'create_name') {
      const w = createWallet(text);
      addWallet(uid, w);
      pending.delete(uid);
      await ctx.reply(`✅ Wallet *${text}* created:\n\`${w.address}\`\n\nFund it with ETH on Robinhood Chain to trade.`, {
        parse_mode: 'Markdown',
        ...mainMenu(),
      });
      return;
    }

    if (state.type === 'import_name') {
      pending.set(uid, { type: 'import_key', name: text });
      await ctx.reply('Now send the private key for this wallet:');
      return;
    }

    if (state.type === 'import_key') {
      const w = importWallet(state.name, text);
      addWallet(uid, w);
      pending.delete(uid);
      await ctx.reply(`✅ Wallet *${state.name}* imported:\n\`${w.address}\``, { parse_mode: 'Markdown', ...mainMenu() });
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      return;
    }

    if (state.type === 'export_type_confirm') {
      pending.delete(uid);
      if (text !== state.walletName) {
        await ctx.reply('❌ Name didn\'t match — export cancelled.', mainMenu());
        return;
      }
      const w = getWallet(uid, state.walletId);
      if (!w) return ctx.reply('Wallet not found.', walletsMenu(uid));
      await ctx.reply(
        `🔑 *${w.name}* private key:\n\`${w.privateKey}\`\n\n` +
        'Save this somewhere safe, then delete this message. Anyone with this key can drain the wallet.',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_wallets')]]) }
      );
      return;
    }

    if (state.type === 'rename') {
      renameWallet(uid, state.walletId, text);
      pending.delete(uid);
      await ctx.reply(`✅ Renamed to *${text}*`, { parse_mode: 'Markdown', ...mainMenu() });
      return;
    }

    if (state.type === 'settings_buy') {
      const usdAmounts = text.split(',').map((s) => parseFloat(s.trim().replace(/^\$/, ''))).filter((n) => !isNaN(n) && n > 0);
      if (usdAmounts.length === 0) return ctx.reply('Send valid USD numbers, e.g. `10, 50, 200`');
      let ethUsd;
      try {
        ethUsd = await getEthUsdPrice();
      } catch {
        return ctx.reply('Price feed is down right now — try again shortly.');
      }
      const amounts = usdAmounts.map((usd) => Number((usd / ethUsd).toFixed(6)));
      updateSettings(uid, { buyPresetsEth: amounts });
      pending.delete(uid);
      await ctx.reply(`✅ Buy presets updated: ${usdAmounts.map((u) => fmtUsd(u)).join(', ')}`, mainMenu());
      return;
    }

    if (state.type === 'settings_sell') {
      const pcts = text.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0 && n <= 100);
      if (pcts.length === 0) return ctx.reply('Send valid percentages (1-100), e.g. `25, 50, 100`');
      updateSettings(uid, { sellPresetsPct: pcts });
      pending.delete(uid);
      await ctx.reply(`✅ Sell presets updated: ${pcts.join(', ')}%`, mainMenu());
      return;
    }

    if (state.type === 'settings_slippage') {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0 || pct > 50) return ctx.reply('Send a valid percentage between 0 and 50.');
      updateSettings(uid, { slippageBps: Math.round(pct * 100) });
      pending.delete(uid);
      await ctx.reply(`✅ Slippage set to ${pct}%`, mainMenu());
      return;
    }

    if (state.type === 'settings_maxbuy') {
      const usd = parseFloat(text.replace(/^\$/, ''));
      if (isNaN(usd) || usd <= 0) return ctx.reply('Send a valid positive USD amount, e.g. `500`');
      let ethUsd;
      try {
        ethUsd = await getEthUsdPrice();
      } catch {
        return ctx.reply('Price feed is down right now — try again shortly.');
      }
      const amt = Number((usd / ethUsd).toFixed(6));
      updateSettings(uid, { maxBuyEth: amt });
      pending.delete(uid);
      await ctx.reply(`✅ Max buy size set to ${fmtUsd(usd)}`, mainMenu());
      return;
    }

    if (state.type === 'settings_maxbridge') {
      const usd = parseFloat(text.replace(/^\$/, ''));
      if (isNaN(usd) || usd <= 0) return ctx.reply('Send a valid positive USD amount, e.g. `500`');
      let ethUsd;
      try {
        ethUsd = await getEthUsdPrice();
      } catch {
        return ctx.reply('Price feed is down right now — try again shortly.');
      }
      const amt = Number((usd / ethUsd).toFixed(6));
      updateSettings(uid, { maxBridgeEth: amt });
      pending.delete(uid);
      await ctx.reply(`✅ Max bridge size set to ${fmtUsd(usd)}`, mainMenu());
      return;
    }

    if (state.type === 'settings_lowbalance') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt < 0) return ctx.reply('Send a valid non-negative ETH amount, e.g. `0.01`, or `0` to disable.');
      updateSettings(uid, { lowBalanceThresholdEth: amt });
      lowBalanceWarned.delete(String(uid));
      pending.delete(uid);
      await ctx.reply(
        amt === 0 ? '✅ Low balance alerts disabled.' : `✅ Low balance alert threshold set to ${amt} ETH`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'custom_buy') {
      let val, usdInput;
      try {
        ({ amountEth: val, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      val = Number(val.toFixed(6));

      const { maxBuyEth } = getSettings(uid);
      if (val > maxBuyEth) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtAmountLabel(val, usdInput)} exceeds your max buy size. Adjust it in Settings if this was intentional.`, mainMenu());
      }

      pending.delete(uid);

      const { confirmTrades } = getSettings(uid);
      const label = fmtAmountLabel(val, usdInput);
      if (confirmTrades) {
        const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_BUY);
        await ctx.reply(`Confirm: buy *${label}*?${gasLine}`, {
          parse_mode: 'Markdown',
          ...confirmMenu('buy', state.tokenAddress, val),
        });
      } else {
        await executeBuy(ctx, uid, state.tokenAddress, val);
      }
      return;
    }

    if (state.type === 'custom_sell') {
      const val = parseFloat(text);
      if (isNaN(val) || val <= 0 || val > 100) return ctx.reply('Send a valid positive number (max 100 for %).');

      pending.delete(uid);

      const { confirmTrades } = getSettings(uid);
      if (confirmTrades) {
        const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_SELL);
        await ctx.reply(`Confirm: sell *${val}%*?${gasLine}`, {
          parse_mode: 'Markdown',
          ...confirmMenu('sell', state.tokenAddress, val),
        });
      } else {
        await executeSell(ctx, uid, state.tokenAddress, val);
      }
      return;
    }

    if (state.type === 'tpsl_input') {
      const parts = text.split(',').map((s) => parseFloat(s.trim()));
      if (parts.length !== 2 || parts.some((n) => isNaN(n) || n < 0)) {
        return ctx.reply('Send two non-negative numbers separated by a comma, e.g. `50,20`');
      }
      const [tpRaw, slRaw] = parts;
      const tpPct = tpRaw > 0 ? tpRaw : null;
      const slPct = slRaw > 0 ? slRaw : null;
      if (tpPct === null && slPct === null) return ctx.reply('At least one of TP or SL must be non-zero.');

      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      const pos = getPosition(uid, w.id, state.tokenAddress);
      if (!pos || pos.tokenAmount <= 0) {
        pending.delete(uid);
        return ctx.reply('No open position on this token to set a rule for.', mainMenu());
      }

      pending.delete(uid);

      const existing = getActiveAutoRuleForPosition(uid, w.id, state.tokenAddress);
      if (existing) cancelAutoRule(uid, existing.id);

      createAutoRule({ uid, walletId: w.id, tokenAddress: state.tokenAddress, tpPct, slPct });
      const parts2 = [];
      if (tpPct !== null) parts2.push(`TP +${tpPct}%`);
      if (slPct !== null) parts2.push(`SL -${slPct}%`);
      await ctx.reply(
        `✅ Auto-sell rule set: ${parts2.join(' / ')}. I'll sell 100% of this position automatically and DM you when it fires.`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'limitbuy_mcap') {
      let targetMcap;
      try {
        targetMcap = parseMcapInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      const market = await getTokenMarketData(state.tokenAddress).catch(() => null);
      const triggerPrice = mcapToPrice(targetMcap, market);
      if (triggerPrice === null) {
        return ctx.reply('Could not fetch live market data for this token right now — try again in a moment.');
      }

      pending.set(uid, { type: 'limitbuy_amount', tokenAddress: state.tokenAddress, triggerPrice, targetMcap });
      await ctx.reply(
        'Send the amount to spend when triggered — USD like `100`, or ETH like `0.05 eth`:',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.type === 'limitbuy_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));

      // FIX: this path previously queued a limit buy of any size, bypassing
      // the user's configured maxBuyEth cap entirely — every other buy path
      // (buy_ callback, custom_buy, batch buy) already enforces this.
      const { maxBuyEth } = getSettings(uid);
      if (amt > maxBuyEth) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtAmountLabel(amt, usdInput)} exceeds your max buy size (${maxBuyEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
      }

      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      pending.delete(uid);
      createLimitOrder({ uid, walletId: w.id, tokenAddress: state.tokenAddress, side: 'buy', triggerPrice: state.triggerPrice, amount: amt, targetMcap: state.targetMcap });
      await ctx.reply(
        `✅ Limit buy queued: ${fmtAmountLabel(amt, usdInput)} when mcap ≤ ${fmtUsd(state.targetMcap)}. I'll DM you when it fills.`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'limitsell_mcap') {
      let targetMcap;
      try {
        targetMcap = parseMcapInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      const pos = getPosition(uid, w.id, state.tokenAddress);
      if (!pos || pos.tokenAmount <= 0) {
        pending.delete(uid);
        return ctx.reply('No open position on this token to sell.', mainMenu());
      }

      const market = await getTokenMarketData(state.tokenAddress).catch(() => null);
      const triggerPrice = mcapToPrice(targetMcap, market);
      if (triggerPrice === null) {
        return ctx.reply('Could not fetch live market data for this token right now — try again in a moment.');
      }

      pending.set(uid, { type: 'limitsell_amount', tokenAddress: state.tokenAddress, triggerPrice, targetMcap, maxAmount: pos.tokenAmount });
      await ctx.reply(`Send the token amount to sell when triggered (you hold ${pos.tokenAmount.toFixed(4)}):`);
      return;
    }

    if (state.type === 'limitsell_amount') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) return ctx.reply('Send a valid positive token amount.');
      pending.delete(uid);
      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      const clamped = Math.min(amt, state.maxAmount);
      createLimitOrder({ uid, walletId: w.id, tokenAddress: state.tokenAddress, side: 'sell', triggerPrice: state.triggerPrice, amount: clamped, targetMcap: state.targetMcap });
      await ctx.reply(
        `✅ Limit sell queued: ${clamped.toFixed(4)} tokens when mcap ≥ ${fmtUsd(state.targetMcap)}. I'll DM you when it fills.`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'batch_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));
      pending.set(uid, { type: 'batch_select', tokenAddress: state.tokenAddress, ethAmount: amt, usdInput, selected: [] });
      await ctx.reply('Select wallets to buy on:', batchSelectMenu(uid, []));
      return;
    }

    if (state.type === 'batchsell_pct') {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0 || pct > 100) return ctx.reply('Send a valid percentage (1-100), e.g. `50`');

      const user = getUser(uid);
      const candidates = user.wallets.filter((w) => {
        const pos = getPosition(uid, w.id, state.tokenAddress);
        return pos && pos.tokenAmount > 0;
      });

      if (candidates.length === 0) {
        pending.delete(uid);
        return ctx.reply('No wallets hold a position in this token.', mainMenu());
      }

      pending.set(uid, { type: 'batchsell_select', tokenAddress: state.tokenAddress, pct, candidates, selected: [] });
      await ctx.reply('Select wallets to sell on:', batchSellSelectMenu(candidates, []));
      return;
    }

    if (state.type === 'batchfund_create_count') {
      const count = parseInt(text, 10);
      if (isNaN(count) || count <= 0 || count > MAX_BATCH_FUND_NEW_WALLETS) {
        return ctx.reply(`Send a valid whole number between 1 and ${MAX_BATCH_FUND_NEW_WALLETS}.`);
      }
      pending.set(uid, { type: 'batchfund_new_amount', sourceWalletId: state.sourceWalletId, count });
      await ctx.reply(
        `Send the amount to fund EACH of the ${count} new wallet(s) with — USD like \`50\`, or ETH like \`0.02 eth\`:`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.type === 'batchfund_new_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));

      const source = getWallet(uid, state.sourceWalletId);
      if (!source) { pending.delete(uid); return ctx.reply('Source wallet not found.', walletsMenu(uid)); }

      const sourceBalance = await provider.getBalance(source.address).then((b) => Number(ethers.formatEther(b))).catch(() => 0);
      const gasReserve = await estimateTransferGasReserve(uid, state.count);
      const totalNeeded = amt * state.count + gasReserve;
      if (totalNeeded > sourceBalance) {
        pending.delete(uid);
        return ctx.reply(
          `❌ Need ~${totalNeeded.toFixed(6)} ETH total (${(amt * state.count).toFixed(6)} + ~${gasReserve.toFixed(6)} est. gas) but *${source.name}* only has ${sourceBalance.toFixed(6)} ETH.`,
          { parse_mode: 'Markdown', ...mainMenu() }
        );
      }

      if (fundsInFlight.has(uid)) return ctx.reply('⏳ A batch fund run is already in progress — please wait for it to finish.');
      if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
      fundsInFlight.add(uid);
      pending.delete(uid);

      const label = fmtAmountLabel(amt, usdInput);
      await ctx.reply(`Creating ${state.count} new wallet(s) and funding each with ${label}... this may take a moment.`);

      try {
        const newWallets = [];
        for (let i = 0; i < state.count; i++) {
          const existingCount = getUser(uid).wallets.length;
          const w = createWallet(`Wallet ${existingCount + 1}`);
          addWallet(uid, w);
          newWallets.push(w);
        }

        const results = await distributeEth(uid, source, newWallets, amt);
        const lines = results.map((r) =>
          r.ok ? `✅ ${r.walletName}: funded (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
        );
        await ctx.reply(`📤 *Batch Fund Results* — ${label} each\n\n${lines.join('\n')}`, {
          parse_mode: 'Markdown',
          ...mainMenu(),
        });
      } catch (err) {
        console.error(err);
        await ctx.reply(`❌ Batch fund failed: ${friendlyErrorMessage(err)}`, mainMenu());
        await sendAdminAlert(ctx.telegram, `Batch fund (new wallets) failed for user ${uid}: ${err.message}`);
      } finally {
        fundsInFlight.delete(uid);
      }
      return;
    }

    if (state.type === 'batchfund_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));

      const source = getWallet(uid, state.sourceWalletId);
      if (!source) { pending.delete(uid); return ctx.reply('Source wallet not found.', walletsMenu(uid)); }

      const sourceBalance = await provider.getBalance(source.address).then((b) => Number(ethers.formatEther(b))).catch(() => 0);
      const gasReserve = await estimateTransferGasReserve(uid, state.targets.length);
      const totalNeeded = amt * state.targets.length + gasReserve;
      if (totalNeeded > sourceBalance) {
        pending.delete(uid);
        return ctx.reply(
          `❌ Need ~${totalNeeded.toFixed(6)} ETH total (${(amt * state.targets.length).toFixed(6)} + ~${gasReserve.toFixed(6)} est. gas) but *${source.name}* only has ${sourceBalance.toFixed(6)} ETH.`,
          { parse_mode: 'Markdown', ...mainMenu() }
        );
      }

      if (fundsInFlight.has(uid)) return ctx.reply('⏳ A batch fund run is already in progress — please wait for it to finish.');
      if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
      fundsInFlight.add(uid);
      pending.delete(uid);

      const label = fmtAmountLabel(amt, usdInput);
      await ctx.reply(`Funding ${state.targets.length} wallet(s) with ${label} each from *${source.name}*... this may take a moment.`, { parse_mode: 'Markdown' });

      try {
        const results = await distributeEth(uid, source, state.targets, amt);
        const lines = results.map((r) =>
          r.ok ? `✅ ${r.walletName}: funded (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
        );
        await ctx.reply(`📤 *Batch Fund Results* — ${label} each\n\n${lines.join('\n')}`, {
          parse_mode: 'Markdown',
          ...mainMenu(),
        });
      } catch (err) {
        console.error(err);
        await ctx.reply(`❌ Batch fund failed: ${friendlyErrorMessage(err)}`, mainMenu());
        await sendAdminAlert(ctx.telegram, `Batch fund failed for user ${uid}: ${err.message}`);
      } finally {
        fundsInFlight.delete(uid);
      }
      return;
    }

    if (state.type === 'bridge_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseBridgeAmountInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      amt = Number(amt.toFixed(6));

      const { maxBridgeEth } = getSettings(uid);
      if (amt > maxBridgeEth) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtAmountLabel(amt, usdInput)} exceeds your max bridge size. Adjust it in Settings if this was intentional.`, mainMenu());
      }

      pending.delete(uid);

      let quote;
      try {
        const w = getActiveWallet(uid);
        if (!w) return ctx.reply('No active wallet. Add one first.', walletsMenu(uid));
        quote = await getBridgeQuote({ direction: state.direction, amountEth: amt, fromAddress: w.address });
      } catch (err) {
        return ctx.reply(`❌ Couldn't get a bridge quote: ${friendlyErrorMessage(err)}`, mainMenu());
      }

      const sendLine = `Send: ${fmtAmountLabel(amt, usdInput)}`;

      const { fromChain } = chainIdsForDirection(state.direction);
      const sourceProviderForEstimate = fromChain === ETH_CHAIN_ID ? ethMainnetProvider : provider;
      const gasEth = await estimateBridgeGasEth(sourceProviderForEstimate, quote, gasMultiplierFor(uid)).catch(() => null);
      const ethUsdForGas = await getEthUsdPrice().catch(() => null);
      const gasLine = gasEth !== null
        ? `\nEst. gas: ~${gasEth.toFixed(5)} ETH${ethUsdForGas !== null ? ` (${fmtUsd(gasEth * ethUsdForGas)})` : ''}`
        : '';

      await ctx.reply(
        `🌉 *${directionLabel(state.direction)}*\n\n` +
        `${sendLine}\n` +
        `Receive (est.): ${Number(quote.toAmountFormatted).toFixed(4)} ETH\n` +
        `Fees (est.): ${fmtUsd(quote.feesUsd)}${gasLine}\n` +
        `Via: ${quote.tool || 'best available route'}\n` +
        `ETA: ~${quote.estimatedDurationSeconds ? Math.ceil(quote.estimatedDurationSeconds / 60) + ' min' : 'a few minutes'}\n\n` +
        `Confirm?`,
        { parse_mode: 'Markdown', ...bridgeConfirmMenu(state.direction === BRIDGE_DIRECTION.ETH_TO_ROBINHOOD ? 'eth_to_robinhood' : 'robinhood_to_eth', amt) }
      );
      return;
    }
  } catch (err) {
    console.error(err);
    pending.delete(uid);
    await ctx.reply(`❌ Error: ${friendlyErrorMessage(err)}`, mainMenu());
  }
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  sendAdminAlert(bot.telegram, `🚨 Unhandled rejection: ${err?.message || err}`).catch(() => {});
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  sendAdminAlert(bot.telegram, `🚨 Uncaught exception (process will exit): ${err.message}`)
    .catch(() => {})
    .finally(() => process.exit(1));
});

bot.launch()
  .then(() => checkStuckTrades(bot))
  .then(() => checkStuckBridges(bot))
  .then(() => startBridgePoller(bot))
  .then(() => startLowBalancePoller(bot))
  .then(() => startAutoTradePoller(bot))
  .then(() => startLimitOrderPoller(bot))
  .then(() => sendAdminAlert(bot.telegram, '✅ Bot started.'))
  .catch((err) => {
    console.error('Failed to launch bot:', err);
    process.exit(1);
  });

console.log('Panchi trading bot running.');

process.once('SIGINT', () => { stopAllAutoRefreshes(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopAllAutoRefreshes(); bot.stop('SIGTERM'); });
