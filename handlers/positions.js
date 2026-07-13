import { bot } from '../bot-instance.js';
import { renderPositionsView, renderTokenCard } from '../menus.js';
import { stopAutoRefresh, stopPositionsRefresh, stopAllViewRefreshes, positionRefs } from '../state.js';
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
//
// The button only carries a short index ("openpos~3"), not the raw wallet
// id + token address — Telegram's callback_data caps out at 64 bytes and a
// full "openpos~<walletId>~<0xaddress>" routinely blows past that, which
// silently drops the tap. The actual wallet/token pair is resolved here
// against positionRefs, populated fresh each time Positions is rendered.
bot.action(/^openpos~(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const idx = Number(ctx.match[1]);

  const refs = positionRefs.get(String(uid));
  const ref = refs?.[idx];
  if (!ref) {
    return ctx.reply('That position list is stale — open 📊 Positions again and try tapping Open.');
  }

  setActiveWallet(uid, ref.walletId);
  stopAllViewRefreshes(uid);

  const { text, markup } = await renderTokenCard(uid, ref.tokenAddress);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup });

  if (ctx.callbackQuery?.message?.message_id) {
    scheduleCardAutoRefresh(uid, ref.tokenAddress, ctx.chat.id, ctx.callbackQuery.message.message_id);
  }
});
