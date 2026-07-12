import { bot } from '../bot-instance.js';
import { renderPositionsView, renderTokenCard, walletsMenu } from '../menus.js';
import { stopAutoRefresh, stopPositionsRefresh, getPositionsIndexEntry } from '../state.js';
import { schedulePositionsAutoRefresh, scheduleCardAutoRefresh } from '../autorefresh.js';
import { setActiveWallet, setActiveChain } from '../storage.js';

// ---------- Positions ----------
// Shows every open position for the user's active wallet, across all
// wallets isn't needed separately anymore — Positions covers it.

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  stopAutoRefresh(uid);

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

// ---------- Tap a position -> open its token card ----------
// Index-based (see state.js's positionsIndex for why) rather than encoding
// the wallet/chain/token directly in callback_data. Switches the user's
// active wallet + chain to match the position tapped (mirrors what pasting
// that token's CA would do), then renders the normal token card with live
// buy/sell buttons.

bot.action(/^pos_(\d+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const idx = Number(ctx.match[1]);
  const entry = getPositionsIndexEntry(uid, idx);

  if (!entry) {
    await ctx.answerCbQuery('This list has changed — refresh and try again.');
    return;
  }

  await ctx.answerCbQuery();
  stopPositionsRefresh(uid);

  setActiveWallet(uid, entry.walletId);
  setActiveChain(uid, entry.chain);

  const { text, markup } = await renderTokenCard(uid, entry.tokenAddress);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup }).catch((err) => {
    if (!err.description?.includes('message is not modified')) throw err;
  });

  if (ctx.callbackQuery?.message?.message_id) {
    scheduleCardAutoRefresh(uid, entry.tokenAddress, ctx.chat.id, ctx.callbackQuery.message.message_id);
  }
});
