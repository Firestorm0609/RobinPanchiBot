import { bot } from '../bot-instance.js';
import { renderPositionsView, renderTokenCard } from '../menus.js';
import { stopAutoRefresh, stopPositionsRefresh, stopAllViewRefreshes } from '../state.js';
import { schedulePositionsAutoRefresh, scheduleCardAutoRefresh } from '../autorefresh.js';
import { setActiveWallet } from '../storage.js';

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

// ---------- Open a position straight into its token card ----------
// A position can be held in any of the user's wallets, but trading always
// runs against the currently active wallet — so tapping "Open" first
// switches the active wallet to the one holding this position, then
// renders the normal token card (same buy/sell menu as pasting the CA).
bot.action(/^openpos~(.+)~(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const [, walletId, tokenAddress] = ctx.match;

  setActiveWallet(uid, walletId);
  stopAllViewRefreshes(uid);

  const { text, markup } = await renderTokenCard(uid, tokenAddress);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup });

  if (ctx.callbackQuery?.message?.message_id) {
    scheduleCardAutoRefresh(uid, tokenAddress, ctx.chat.id, ctx.callbackQuery.message.message_id);
  }
});
