import { bot } from '../bot-instance.js';
import { stopAllViewRefreshes } from '../state.js';
import { getActiveChain, setActiveChain } from '../storage.js';
import { chainMenu } from '../menus.js';
import { getChain, ALL_CHAIN_KEYS } from '../chains.js';

bot.action('menu_chain', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const active = getChain(getActiveChain(ctx.from.id));
  await ctx.editMessageText(
    `🔗 *Trading Chain*\n\n` +
    `Current: *${active.name}*\n\n` +
    `Your wallet works on every chain below already — just deposit native USDC on whichever one you pick and trade directly. No bridging, ever.`,
    { parse_mode: 'Markdown', ...chainMenu(ctx.from.id) }
  );
});

bot.action(/^chain_select_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const chainKey = ctx.match[1];
  if (!ALL_CHAIN_KEYS.includes(chainKey)) return ctx.answerCbQuery('Unknown chain');
  setActiveChain(uid, chainKey);
  const chain = getChain(chainKey);
  await ctx.answerCbQuery(`Switched to ${chain.name}`);
  await ctx.editMessageText(
    `🔗 *Trading Chain*\n\n` +
    `Current: *${chain.name}*\n\n` +
    `Deposit native USDC on ${chain.name} to your wallet address, then paste a token contract address (or Solana mint) to trade it.`,
    { parse_mode: 'Markdown', ...chainMenu(uid) }
  );
});
