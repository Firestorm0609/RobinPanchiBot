import { bot } from '../bot-instance.js';
import { pending, stopAllViewRefreshes, tradesInFlight } from '../state.js';
import { getActiveWallet } from '../storage.js';
import { walletsMenu, withdrawMenu, mainMenu } from '../menus.js';
import { getChain, ALL_CHAIN_KEYS, stableSymbolFor, explorerTxUrl } from '../chains.js';
import { getChainUsdcBalance } from '../format.js';
import { fmtUsd } from '../price.js';
import { isRateLimited } from '../ratelimit.js';
import { performUsdcTransferCore } from '../trade-core.js';
import { sendAdminAlert } from '../alerts.js';

// ---------- Withdraw ----------
// Deposit's mirror image: pick a network, then (via handlers/text.js's
// pending-state text prompts, same pattern as custom buy/sell) enter an
// amount and destination address, confirm with a gas estimate shown, then
// send. Uses the SAME tradesInFlight lock as buy/sell so a withdraw can't
// race a trade signing on the same wallet.

bot.action('menu_withdraw', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Create one first.', walletsMenu(uid));

  await ctx.editMessageText(
    `📤 *Withdraw*\n\nChoose a network to withdraw from.`,
    { parse_mode: 'Markdown', ...withdrawMenu() }
  );
});

bot.action(/^withdraw_chain_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const chainKey = ctx.match[1];
  if (!ALL_CHAIN_KEYS.includes(chainKey)) return ctx.answerCbQuery('Unknown chain');
  await ctx.answerCbQuery();

  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Create one first.', walletsMenu(uid));

  const chain = getChain(chainKey);
  const symbol = stableSymbolFor(chainKey);
  const balance = await getChainUsdcBalance(w, chainKey).catch(() => null);
  const balanceLine = balance === null ? 'unavailable' : `${fmtUsd(balance)} ${symbol}`;

  pending.set(uid, { type: 'withdraw_amount', chainKey });
  await ctx.editMessageText(
    `📤 *Withdraw — ${chain.name}*\n\n` +
    `Available: ${balanceLine}\n\n` +
    `Send the amount of ${symbol} to withdraw, e.g. \`50\`:`,
    { parse_mode: 'Markdown' }
  );
});

// ---------- Confirm / cancel ----------
// The pending state (chain, amount, destination address) is looked up from
// the `pending` map rather than round-tripped through callback_data, since
// a Solana/EVM address won't fit in Telegram's 64-byte callback_data limit
// alongside the chain + amount.

bot.action('withdraw_confirm_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  pending.delete(ctx.from.id);
  await ctx.editMessageText('Withdrawal cancelled.', mainMenu());
});

bot.action('withdraw_confirm_yes', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  pending.delete(uid);

  if (!state || state.type !== 'withdraw_confirm') {
    return ctx.editMessageText('This confirmation has expired — start the withdrawal again.', mainMenu());
  }
  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet.', walletsMenu(uid));

  const { chainKey, amount, toAddress } = state;
  const chain = getChain(chainKey);
  const symbol = stableSymbolFor(chainKey);

  if (tradesInFlight.has(uid)) {
    return ctx.editMessageText('⏳ Another trade/withdrawal is already in progress for this wallet — try again in a moment.', mainMenu());
  }

  tradesInFlight.add(uid);
  await ctx.editMessageText(`Sending ${fmtUsd(amount)} ${symbol} on ${chain.name}...`);

  let result;
  try {
    result = await performUsdcTransferCore(uid, chainKey, w, toAddress, amount);
  } finally {
    tradesInFlight.delete(uid);
  }

  if (!result.ok) {
    await ctx.reply(`❌ Withdrawal failed: ${result.error}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Withdrawal failed for user ${uid} on ${chain.name}: ${result.error}`);
    return;
  }

  const txLink = explorerTxUrl(chainKey, result.txHash);
  await ctx.reply(
    (txLink
      ? `✅ Withdrawal confirmed on ${chain.name} — [view transaction](${txLink})`
      : `✅ Withdrawal confirmed on ${chain.name}`),
    { parse_mode: 'Markdown', ...mainMenu() }
  );
});
