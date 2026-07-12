import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { pending, stopPositionsRefresh, stopAllViewRefreshes } from '../state.js';
import { scheduleCardAutoRefresh } from '../autorefresh.js';
import {
  walletsMenu, mainMenu, renderTokenCard, limitOrdersText, limitOrdersMenu, confirmMenu,
} from '../menus.js';
import { getOpenLimitOrdersForUser, cancelLimitOrder, getSettings, getActiveWallet } from '../storage.js';
import { getTokenMarketData, fmtUsd } from '../price.js';
import { shortAddr } from '../wallet.js';
import { dualEthBalanceLines, gasEstimateLine } from '../format.js';
import { executeBuy, executeSell } from '../trade-core.js';
import { isRateLimited } from '../ratelimit.js';
import { FALLBACK_GAS_LIMIT_BUY, FALLBACK_GAS_LIMIT_SELL } from '../config.js';

// ---------- Custom buy/sell prompts ----------

bot.action(/^custombuy_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_buy', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send the USD amount to spend, e.g. `100`:',
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
  const { text, markup } = await renderTokenCard(uid, tokenAddress);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup }).catch((err) => {
    if (!err.description?.includes('message is not modified')) throw err;
  });
  scheduleCardAutoRefresh(uid, tokenAddress, ctx.chat.id, ctx.callbackQuery.message.message_id);
});

// ---------- Buy ----------
// Amount is USDC (trades are USDC-denominated) — plain USD number, no
// price-feed conversion needed.

bot.action(/^buy_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const [, tokenAddress, usdcAmountStr] = ctx.match;
  const uid = ctx.from.id;
  const { confirmTrades, maxBuyUsdc } = getSettings(uid);
  const usdcAmount = Number(usdcAmountStr);
  if (usdcAmount > maxBuyUsdc) {
    return ctx.editMessageText(`❌ ${fmtUsd(usdcAmount)} exceeds your max buy size.`, mainMenu());
  }
  if (confirmTrades) {
    const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_BUY);
    await ctx.editMessageText(`Confirm: buy *${fmtUsd(usdcAmount)}* worth of this token?${gasLine}`, {
      parse_mode: 'Markdown',
      ...confirmMenu('buy', tokenAddress, usdcAmountStr),
    });
  } else {
    await executeBuy(ctx, uid, tokenAddress, usdcAmount);
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

bot.action('cancel_trade', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('Trade cancelled.', mainMenu());
});
