import { bot } from '../bot-instance.js';
import { renderPositionsView } from '../menus.js';
import { stopAutoRefresh, stopPositionsRefresh } from '../state.js';
import { schedulePositionsAutoRefresh } from '../autorefresh.js';

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
