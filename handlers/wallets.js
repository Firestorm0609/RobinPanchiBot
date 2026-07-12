import { bot } from '../bot-instance.js';
import { pending, stopAllViewRefreshes } from '../state.js';
import { getUser, getWallet, removeWallet, setActiveWallet } from '../storage.js';
import { allChainsBalanceSummary } from '../format.js';
import { walletsMenu, walletDetailMenu, exportConfirmMenu } from '../menus.js';

bot.action('menu_wallets', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const user = getUser(uid);
  const header = user.wallets.length === 0
    ? 'No wallets yet. Create or import one to get started.'
    : '💼 *Your Wallets*\n✅ = active wallet for trading';
  await ctx.editMessageText(header, { parse_mode: 'Markdown', ...walletsMenu(uid) });
});

bot.action('wallet_create', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'create_name' });
  await ctx.editMessageText('Send a name for this new wallet (e.g. "Main"):');
});

bot.action('wallet_import', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'import_name' });
  await ctx.editMessageText('Send a name for the imported wallet (e.g. "Cold Wallet"):');
});

bot.action(/^wallet_activate_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Active wallet updated');
  setActiveWallet(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText('💼 *Your Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ctx.from.id) });
});

bot.action(/^wallet_rename_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'rename', walletId: ctx.match[1] });
  await ctx.editMessageText('Send the new name for this wallet:');
});

bot.action(/^wallet_remove_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Wallet removed');
  removeWallet(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText('💼 *Your Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ctx.from.id) });
});

bot.action(/^wallet_export_confirm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  pending.set(ctx.from.id, { type: 'export_type_confirm', walletId: w.id, walletName: w.name });
  await ctx.editMessageText(
    `⚠️ Type the wallet's name exactly (*${w.name}*) to confirm you want to reveal its private keys:`,
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^wallet_export_(?!confirm)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  await ctx.editMessageText(
    `⚠️ This will display the raw EVM and Solana private keys for *${w.name}* in this chat.\n\nAnyone who sees them can take everything in this wallet. Continue?`,
    { parse_mode: 'Markdown', ...exportConfirmMenu(w.id) }
  );
});

bot.action(/^wallet_(?!create|import|activate|rename|remove|export)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  const bal = await allChainsBalanceSummary(w).catch(() => 'unavailable');
  const solLine = w.solAddress ? `\nSolana: \`${w.solAddress}\`` : '';
  await ctx.editMessageText(
    `*${w.name}*\nEVM: \`${w.address}\`${solLine}\n\nBalances (each chain's stablecoin):\n${bal}`,
    { parse_mode: 'Markdown', ...walletDetailMenu(w.id) }
  );
});
