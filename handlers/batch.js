import { ethers } from 'ethers';
import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { pending, fundsInFlight, gasMultiplierFor } from '../state.js';
import { getUser, getWallet, getSettings } from '../storage.js';
import {
  walletsMenu, mainMenu, batchSelectMenu, batchSellSelectMenu, batchFundSelectMenu, collectSelectMenu,
} from '../menus.js';
import { performBuyCore, performSellCore, performCollectCore } from '../trade-core.js';
import { friendlyErrorMessage } from '../format.js';
import { fmtUsd } from '../price.js';
import { isRateLimited } from '../ratelimit.js';
import { sendAdminAlert } from '../alerts.js';
import { getUsdcBalance } from '../erc20.js';
import { USDC_DECIMALS, MAX_BATCH_FUND_NEW_WALLETS } from '../config.js';
import { shortAddr } from '../wallet.js';

// ---------- Batch Buy ----------

bot.action(/^batchbuy_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);
  if (user.wallets.length < 2) return ctx.reply('You need at least 2 wallets to use Batch Buy.', mainMenu());
  pending.set(uid, { type: 'batch_amount', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send the USD amount to buy on EACH selected wallet, e.g. `50`:',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^batchtoggle_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batch_select') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const walletId = ctx.match[1];
  const idx = state.selected.indexOf(walletId);
  if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(walletId);
  pending.set(uid, state);
  await ctx.editMessageText('Select wallets to buy on:', batchSelectMenu(uid, state.selected)).catch(() => {});
});

bot.action('batchconfirm', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batch_select') return;
  if (state.selected.length === 0) return ctx.reply('No wallets selected — tap wallets to select, then Confirm.');
  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  const { maxBuyUsdc } = getSettings(uid);
  if (state.usdcAmount > maxBuyUsdc) {
    pending.delete(uid);
    return ctx.reply(`❌ ${fmtUsd(state.usdcAmount)} exceeds your max buy size.`, mainMenu());
  }

  pending.delete(uid);
  await ctx.editMessageText(`Buying ${fmtUsd(state.usdcAmount)} on ${state.selected.length} wallet(s)... this may take a moment.`);

  const results = [];
  for (const walletId of state.selected) {
    const w = getWallet(uid, walletId);
    if (!w) { results.push({ ok: false, walletName: walletId, error: 'Wallet not found.' }); continue; }
    const result = await performBuyCore(uid, w, state.tokenAddress, state.usdcAmount);
    results.push(result);
  }

  const lines = results.map((r) =>
    r.ok ? `✅ ${r.walletName}: bought (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
  );
  await ctx.reply(`📦 *Batch Buy Results* — ${fmtUsd(state.usdcAmount)} each\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

// ---------- Batch Sell ----------

bot.action(/^batchsell_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);
  if (user.wallets.length < 2) return ctx.reply('You need at least 2 wallets to use Batch Sell.', mainMenu());
  pending.set(uid, { type: 'batchsell_pct', tokenAddress: ctx.match[1] });
  await ctx.editMessageText('Send the percentage to sell on EACH wallet holding this token, e.g. `50` for 50%', { parse_mode: 'Markdown' });
});

bot.action(/^bselltoggle_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batchsell_select') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const walletId = ctx.match[1];
  const idx = state.selected.indexOf(walletId);
  if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(walletId);
  pending.set(uid, state);
  await ctx.editMessageText(
    'Select wallets to sell on:',
    batchSellSelectMenu(state.candidates, state.selected)
  ).catch(() => {});
});

bot.action('batchsellconfirm', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batchsell_select') return;
  if (state.selected.length === 0) return ctx.reply('No wallets selected — tap wallets to select, then Confirm.');
  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  pending.delete(uid);
  await ctx.editMessageText(`Selling ${state.pct}% on ${state.selected.length} wallet(s)... this may take a moment.`);

  const results = [];
  for (const walletId of state.selected) {
    const w = getWallet(uid, walletId);
    if (!w) { results.push({ ok: false, walletName: walletId, error: 'Wallet not found.' }); continue; }
    const result = await performSellCore(uid, w, state.tokenAddress, state.pct);
    results.push(result);
  }

  const lines = results.map((r) =>
    r.ok ? `✅ ${r.walletName}: sold (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
  );
  await ctx.reply(`📦 *Batch Sell Results* — ${state.pct}% each\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

// ---------- Batch Fund ----------
// Source wallet is picked by highest USDC balance (the trading currency),
// not native ETH — gas top-ups happen automatically per-transfer.

bot.action('batchfund_start', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);

  if (user.wallets.length === 0) {
    return ctx.editMessageText('No wallets yet. Create one first.', walletsMenu(uid));
  }

  if (user.wallets.length === 1) {
    pending.set(uid, { type: 'batchfund_create_count', sourceWalletId: user.wallets[0].id });
    await ctx.editMessageText(
      `You only have one wallet (*${user.wallets[0].name}*).\n\n` +
      `How many new wallets would you like to create and fund from it? (max ${MAX_BATCH_FUND_NEW_WALLETS})`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.editMessageText('📤 *Batch Fund*\n\nChecking wallet balances...', { parse_mode: 'Markdown' });

  const balances = await Promise.all(
    user.wallets.map(async (w) => ({
      ...w,
      balance: await getUsdcBalance(w.address).then((b) => Number(ethers.formatUnits(b, USDC_DECIMALS))).catch(() => 0),
    }))
  );
  const source = balances.reduce((a, b) => (b.balance > a.balance ? b : a));

  if (source.balance <= 0) {
    pending.delete(uid);
    return ctx.editMessageText(
      '📤 *Batch Fund*\n\nNone of your wallets have a USDC balance to fund others with. Add funds to a wallet first.',
      { parse_mode: 'Markdown', ...walletsMenu(uid) }
    );
  }

  const candidates = balances.filter((w) => w.id !== source.id);

  pending.set(uid, { type: 'batchfund_select', sourceWalletId: source.id, candidates, selected: [] });

  await ctx.editMessageText(
    `📤 *Batch Fund*\n\n` +
    `Source wallet: *${source.name}* — ${fmtUsd(source.balance)}\n\n` +
    `Select which wallets to fund (the amount you choose next will be sent to EACH one):`,
    { parse_mode: 'Markdown', ...batchFundSelectMenu(candidates, []) }
  );
});

bot.action(/^bfundtoggle_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batchfund_select') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const walletId = ctx.match[1];
  const idx = state.selected.indexOf(walletId);
  if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(walletId);
  pending.set(uid, state);
  await ctx.editMessageText(
    'Select which wallets to fund:',
    batchFundSelectMenu(state.candidates, state.selected)
  ).catch(() => {});
});

bot.action('bfundconfirm', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'batchfund_select') return;
  if (state.selected.length === 0) return ctx.reply('No wallets selected — tap wallets to select, then Confirm.');

  pending.set(uid, {
    type: 'batchfund_amount',
    sourceWalletId: state.sourceWalletId,
    targets: state.candidates.filter((w) => state.selected.includes(w.id)),
  });
  await ctx.editMessageText(
    'Send the USD amount to send to EACH selected wallet, e.g. `50`:',
    { parse_mode: 'Markdown' }
  );
});

// ---------- Batch Collect ----------

bot.action('collect_start', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);
  if (user.wallets.length < 2) return ctx.editMessageText('You need at least 2 wallets to use Batch Collect.', walletsMenu(uid));

  pending.set(uid, { type: 'collect_select_dest' });
  const rows = user.wallets.map((w) => [Markup.button.callback(`${w.name} (${shortAddr(w.address)})`, `collectdest_${w.id}`)]);
  rows.push([Markup.button.callback('❌ Cancel', 'menu_wallets')]);
  await ctx.editMessageText(
    '📥 *Batch Collect*\n\nChoose the destination wallet — USDC and all tokens from your other wallets will be swept here:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
  );
});

bot.action(/^collectdest_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const dest = getWallet(uid, ctx.match[1]);
  if (!dest) return ctx.editMessageText('Wallet not found.', walletsMenu(uid));

  const user = getUser(uid);
  const candidates = user.wallets.filter((w) => w.id !== dest.id);
  const allIds = candidates.map((w) => w.id);
  pending.set(uid, { type: 'collect_select_sources', destWalletId: dest.id, destName: dest.name, destAddress: dest.address, candidates, selected: allIds });

  await ctx.editMessageText(
    `📥 *Batch Collect* → *${dest.name}*\n\nSelect source wallets to sweep from (all selected by default):`,
    { parse_mode: 'Markdown', ...collectSelectMenu(candidates, allIds) }
  );
});

bot.action(/^collecttoggle_(.+)$/, async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'collect_select_sources') return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const walletId = ctx.match[1];
  const idx = state.selected.indexOf(walletId);
  if (idx >= 0) state.selected.splice(idx, 1); else state.selected.push(walletId);
  pending.set(uid, state);
  await ctx.editMessageText(
    `📥 *Batch Collect* → *${state.destName}*\n\nSelect source wallets to sweep from:`,
    { parse_mode: 'Markdown', ...collectSelectMenu(state.candidates, state.selected) }
  ).catch(() => {});
});

bot.action('collectconfirm', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state || state.type !== 'collect_select_sources') return;
  if (state.selected.length === 0) return ctx.reply('No wallets selected — tap wallets to select, then Confirm.');
  if (fundsInFlight.has(uid)) return ctx.reply('⏳ A batch fund/collect run is already in progress — please wait for it to finish.');
  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  const dest = getWallet(uid, state.destWalletId);
  if (!dest) { pending.delete(uid); return ctx.reply('Destination wallet not found.', walletsMenu(uid)); }
  const sources = state.candidates.filter((w) => state.selected.includes(w.id));

  fundsInFlight.add(uid);
  pending.delete(uid);
  await ctx.editMessageText(`Sweeping USDC + tokens from ${sources.length} wallet(s) into *${dest.name}*... this may take a moment.`, { parse_mode: 'Markdown' });

  try {
    const gasMultiplier = gasMultiplierFor(uid);
    const lines = [];
    for (const src of sources) {
      const wallet = getWallet(uid, src.id);
      if (!wallet) { lines.push(`*${src.name}*: ❌ wallet not found`); continue; }
      const results = await performCollectCore(uid, wallet, dest.address, gasMultiplier);
      lines.push(`*${wallet.name}*:`);
      if (results.length === 0) {
        lines.push('  nothing to collect');
      } else {
        for (const r of results) {
          lines.push(r.ok ? `  ✅ ${r.label}: sent (tx \`${r.txHash.slice(0, 12)}...\`)` : `  ❌ ${r.label}: ${r.error}`);
        }
      }
    }
    await ctx.reply(`📥 *Batch Collect Results* → ${dest.name}\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...mainMenu() });
  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ Batch collect failed: ${friendlyErrorMessage(err)}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Batch collect failed for user ${uid}: ${err.message}`);
  } finally {
    fundsInFlight.delete(uid);
  }
});
