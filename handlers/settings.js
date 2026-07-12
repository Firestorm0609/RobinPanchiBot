import { bot } from '../bot-instance.js';
import { pending, stopAllViewRefreshes } from '../state.js';
import { getSettings, updateSettings } from '../storage.js';
import { settingsMenu } from '../menus.js';
import { GAS_TIERS } from '../config.js';

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
