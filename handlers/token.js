import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { pending, stopPositionsRefresh, stopAllViewRefreshes } from '../state.js';
import { scheduleCardAutoRefresh } from '../autorefresh.js';
import {
  walletsMenu, mainMenu, renderTokenCard, limitOrdersText, limitOrdersMenu, confirmMenu,
} from '../menus.js';
import { getOpenLimitOrdersForUser, cancelLimitOrder, getSettings, getActiveWallet, getActiveChain } from '../storage.js';
import { getTokenMarketData, fmtUsd } from '../price.js';
import { shortAddr } from '../wallet.js';
import { getUnifiedUsdBalance, formatUnifiedBalanceLines, gasEstimateLine } from '../format.js';
import { executeBuy, executeSell } from '../trade-core.js';
import { isRateLimited } from '../ratelimit.js';
import { getChain } from '../chains.js';
import { FALLBACK_GAS_LIMIT_BUY, FALLBACK_GAS_LIMIT_SELL, TOKEN_ADDR_SRC } from '../config.js';

// All buttons below are keyed off a pasted token address, which can be
// either an EVM address (0x...) or a Solana mint. The regexes previously
// only matched 0x..., so every button silently no-op'd once the user
// switched to a Solana token (Telegraf found no matching bot.action at
// all for that callback_data). TOKEN_ADDR_SRC (config.js) matches either.

const custombuyRe = new RegExp(`^custombuy_(${TOKEN_ADDR_SRC})$`);
const customsellRe = new RegExp(`^customsell_(${TOKEN_ADDR_SRC})$`);
const tpslRe = new RegExp(`^tpsl_(${TOKEN_ADDR_SRC})$`);
const limitbuyRe = new RegExp(`^limitbuy_(${TOKEN_ADDR_SRC})$`);
const limitsellRe = new RegExp(`^limitsell_(${TOKEN_ADDR_SRC})$`);
const refreshRe = new RegExp(`^refresh_(${TOKEN_ADDR_SRC})$`);
const buyRe = new RegExp(`^buy_(${TOKEN_ADDR_SRC})_([\\d.]+)$`);
const sellRe = new RegExp(`^sell_(${TOKEN_ADDR_SRC})_([\\d.]+)$`);
const confirmBuyRe = new RegExp(`^confirm_buy_(${TOKEN_ADDR_SRC})_([\\d.]+)$`);
const confirmSellRe = new RegExp(`^confirm_sell_(${TOKEN_ADDR_SRC})_([\\d.]+)$`);

// ---------- Custom buy/sell prompts ----------

bot.action(custombuyRe, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_buy', tokenAddress: ctx.match[1] });
  await ctx.editMessageText('Send the USD amount to spend, e.g. `100`:', { parse_mode: 'Markdown' });
});

bot.action(customsellRe, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_sell', tokenAddress: ctx.match[1] });
  await ctx.editMessageText('Send the percentage to sell, e.g. `40` for 40%');
});

// ---------- Auto TP/SL ----------

bot.action(tpslRe, async (ctx) => {
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

bot.action(limitbuyRe, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'limitbuy_mcap', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send the target *market cap* to buy at (fires when mcap drops to or below this).\n' +
    'Use shorthand: `50k`, `2.5m`, `1b` — or a plain number.',
    { parse_mode: 'Markdown' }
  );
});

bot.action(limitsellRe, async (ctx) => {
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

  const marketByKey = new Map();
  for (const o of orders) {
    const key = `${o.chain}:${o.token_address}`;
    if (!marketByKey.has(key)) {
      const market = await getTokenMarketData(o.token_address, o.chain).catch(() => null);
      marketByKey.set(key, market);
    }
    o._symbol = marketByKey.get(key)?.symbol ?? shortAddr(o.token_address);
  }

  await ctx.editMessageText(limitOrdersText(orders, marketByKey), {
    parse_mode: 'Markdown',
    ...limitOrdersMenu(orders),
  });
});

bot.action(/^limitordercancel_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const cancelled = cancelLimitOrder(uid, ctx.match[1]);
  await ctx.answerCbQuery(cancelled ? 'Order cancelled' : 'Could not cancel (already filled/cancelled?)');

  const orders = getOpenLimitOrdersForUser(uid);
  const marketByKey = new Map();
  for (const o of orders) {
    const key = `${o.chain}:${o.token_address}`;
    if (!marketByKey.has(key)) {
      const market = await getTokenMarketData(o.token_address, o.chain).catch(() => null);
      marketByKey.set(key, market);
    }
    o._symbol = marketByKey.get(key)?.symbol ?? shortAddr(o.token_address);
  }

  await ctx.editMessageText(limitOrdersText(orders, marketByKey), {
    parse_mode: 'Markdown',
    ...limitOrdersMenu(orders),
  }).catch(() => {});
});

// ---------- Balance ----------
// Shows the unified total across every chain only — the per-chain
// active-chain breakdown that used to follow it was removed on request as
// unnecessary clutter (the token card still shows the active-chain balance
// where it's actually relevant, i.e. right before you'd trade on it).

bot.action('menu_balance', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(uid));

  const unified = await getUnifiedUsdBalance(w).catch(() => null);

  const text = unified
    ? `💰 *${w.name}*\n\n${formatUnifiedBalanceLines(unified)}`
    : `💰 *${w.name}*\n\nBalance unavailable right now.`;

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});

// ---------- Token card: refresh ----------

bot.action(refreshRe, async (ctx) => {
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

bot.action(buyRe, async (ctx) => {
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
    const chainKey = getActiveChain(uid);
    const gasLine = await gasEstimateLine(chainKey, uid, FALLBACK_GAS_LIMIT_BUY).catch(() => '');
    await ctx.editMessageText(`Confirm: buy *${fmtUsd(usdcAmount)}* worth of this token on ${getChain(chainKey).name}?${gasLine}`, {
      parse_mode: 'Markdown',
      ...confirmMenu('buy', tokenAddress, usdcAmountStr),
    });
  } else {
    await executeBuy(ctx, uid, tokenAddress, usdcAmount);
  }
});

// ---------- Sell ----------

bot.action(sellRe, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const [, tokenAddress, pctStr] = ctx.match;
  const uid = ctx.from.id;
  const { confirmTrades } = getSettings(uid);
  if (confirmTrades) {
    const chainKey = getActiveChain(uid);
    const gasLine = await gasEstimateLine(chainKey, uid, FALLBACK_GAS_LIMIT_SELL).catch(() => '');
    await ctx.editMessageText(`Confirm: sell *${pctStr}%* of your position?${gasLine}`, {
      parse_mode: 'Markdown',
      ...confirmMenu('sell', tokenAddress, pctStr),
    });
  } else {
    await executeSell(ctx, uid, tokenAddress, Number(pctStr));
  }
});

bot.action(confirmBuyRe, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  await executeBuy(ctx, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

bot.action(confirmSellRe, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  await executeSell(ctx, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

bot.action('cancel_trade', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('Trade cancelled.', mainMenu());
});
