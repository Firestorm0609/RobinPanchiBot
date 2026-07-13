import { bot } from '../bot-instance.js';
import { pending, stopAllViewRefreshes } from '../state.js';
import {
  getActiveMomentumTriggersForUser,
  cancelMomentumTrigger,
  getActiveWallet,
} from '../storage.js';
import { getTokenMarketData } from '../price.js';
import { momentumMenu, momentumListText, walletsMenu } from '../menus.js';

// ---------- Momentum Trigger: menu + cancel ----------
// The create flow itself (paste Alpha CA -> paste Beta CA -> % -> amount)
// lives in handlers/text.js since it's a multi-step free-text conversation,
// same pattern as limit orders / TP-SL. This file only owns the menu,
// entry point, and cancel action.

// Pre-fetches market data (symbol) for every Alpha/Beta token across the
// user's active triggers, same pattern as the limit-orders list in
// handlers/token.js, so the list shows real token symbols instead of
// shortened contract addresses.
async function buildMarketMap(triggers) {
  const marketByToken = new Map();
  for (const t of triggers) {
    for (const addr of [t.alpha_token, t.beta_token]) {
      if (!marketByToken.has(addr)) {
        const market = await getTokenMarketData(addr).catch(() => null);
        marketByToken.set(addr, market);
      }
    }
  }
  return marketByToken;
}

bot.action('menu_momentum', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const triggers = getActiveMomentumTriggersForUser(uid);
  const marketByToken = await buildMarketMap(triggers);
  await ctx.editMessageText(momentumListText(triggers, marketByToken), {
    parse_mode: 'Markdown',
    ...momentumMenu(triggers, marketByToken),
  });
});

bot.action('momentum_new', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(uid));

  pending.set(uid, { type: 'momentum_alpha' });
  await ctx.editMessageText(
    '⚡ *New Momentum Trigger*\n\n' +
    'Paste the *Alpha* token contract address — the one you\'ll watch for a price move:',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^momentumcancel_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const cancelled = cancelMomentumTrigger(uid, ctx.match[1]);
  await ctx.answerCbQuery(cancelled ? 'Trigger cancelled' : 'Could not cancel (already fired?)');

  const triggers = getActiveMomentumTriggersForUser(uid);
  const marketByToken = await buildMarketMap(triggers);
  await ctx.editMessageText(momentumListText(triggers, marketByToken), {
    parse_mode: 'Markdown',
    ...momentumMenu(triggers, marketByToken),
  }).catch(() => {});
});
