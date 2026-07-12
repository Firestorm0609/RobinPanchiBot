import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { stopAllViewRefreshes } from '../state.js';
import { getActiveWallet } from '../storage.js';
import { walletsMenu, depositMenu, depositChainDetailMenu } from '../menus.js';
import { getChain, isSolanaChain, ALL_CHAIN_KEYS, explorerAddressUrl, stableSymbolFor } from '../chains.js';

// ---------- Deposit ----------
// A dedicated "choose a network to deposit from" screen, mirroring the
// familiar pattern from other wallet apps. This is purely a read-only
// convenience view — it doesn't create anything, it just shows the
// existing active wallet's address per chain so the user doesn't have to
// go hunting through 🔗 Chain or 💼 Wallets to find where to send funds.

bot.action('menu_deposit', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Create or import one first.', walletsMenu(uid));

  await ctx.editMessageText(
    `📥 *Deposit*\n\nChoose a network to deposit from — you'll get *${w.name}*'s address on that chain.`,
    { parse_mode: 'Markdown', ...depositMenu() }
  );
});

bot.action(/^deposit_chain_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const chainKey = ctx.match[1];
  if (!ALL_CHAIN_KEYS.includes(chainKey)) return ctx.answerCbQuery('Unknown chain');
  await ctx.answerCbQuery();

  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Create or import one first.', walletsMenu(uid));

  const chain = getChain(chainKey);
  const address = isSolanaChain(chainKey) ? w.solAddress : w.address;
  const symbol = stableSymbolFor(chainKey);
  const explorerUrl = explorerAddressUrl(chainKey, address);

  const explorerLine = explorerUrl ? `\n[View on explorer](${explorerUrl})` : '';

  await ctx.editMessageText(
    `📥 *Deposit — ${chain.name}*\n\n` +
    `Send *${symbol}* to *${w.name}*'s address on ${chain.name}:\n\n` +
    `\`${address}\`\n\n` +
    `Only send ${chain.name} network assets to this address — funds sent on the wrong network cannot be recovered.` +
    explorerLine,
    { parse_mode: 'Markdown', ...depositChainDetailMenu() }
  );
});
