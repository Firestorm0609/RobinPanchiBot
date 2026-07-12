import { bot } from '../bot-instance.js';
import { renderPositionsView, renderPortfolioView } from '../menus.js';
import { stopAutoRefresh, stopPositionsRefresh, stopPortfolioRefresh } from '../state.js';
import { schedulePositionsAutoRefresh, schedulePortfolioAutoRefresh } from '../autorefresh.js';

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
