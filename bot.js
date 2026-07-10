import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { ethers } from 'ethers';
import { getQuote, getSwapTx } from './swap.js';
import { createWallet, importWallet, shortAddr } from './wallet.js';
import {
  getUser,
  addWallet,
  removeWallet,
  renameWallet,
  setActiveWallet,
  getActiveWallet,
  getWallet,
} from './storage.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, Number(process.env.CHAIN_ID));

// Tracks what free-text reply we're expecting from a user (import key, rename, buy/sell amounts, etc.)
const pending = new Map();

// ---------- Menus ----------

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💼 Wallets', 'menu_wallets')],
    [Markup.button.callback('💰 Balance', 'menu_balance')],
    [Markup.button.callback('🛒 Buy', 'menu_buy'), Markup.button.callback('💸 Sell', 'menu_sell')],
  ]);
}

function walletsMenu(uid) {
  const user = getUser(uid);
  const rows = user.wallets.map((w) => {
    const active = w.id === user.activeWalletId ? '✅ ' : '';
    return [Markup.button.callback(`${active}${w.name} (${shortAddr(w.address)})`, `wallet_${w.id}`)];
  });
  rows.push([
    Markup.button.callback('➕ Create New', 'wallet_create'),
    Markup.button.callback('📥 Import', 'wallet_import'),
  ]);
  rows.push([Markup.button.callback('⬅️ Back', 'menu_main')]);
  return Markup.inlineKeyboard(rows);
}

function walletDetailMenu(walletId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Set Active', `wallet_activate_${walletId}`)],
    [Markup.button.callback('✏️ Rename', `wallet_rename_${walletId}`)],
    [Markup.button.callback('🗑 Remove', `wallet_remove_${walletId}`)],
    [Markup.button.callback('⬅️ Back', 'menu_wallets')],
  ]);
}

// ---------- Start / Main menu ----------

bot.start((ctx) => {
  ctx.reply('🐒 *Panchi Trading Bot*\n\nTrade tokens on Robinhood Chain, straight from Telegram.', {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

bot.action('menu_main', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🐒 *Panchi Trading Bot*', { parse_mode: 'Markdown', ...mainMenu() });
});

// ---------- Wallets ----------

bot.action('menu_wallets', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);
  if (user.wallets.length === 0) {
    await ctx.editMessageText('No wallets yet. Create or import one to get started.', walletsMenu(uid));
  } else {
    await ctx.editMessageText('💼 *Your Wallets*\n✅ = active wallet for trading', {
      parse_mode: 'Markdown',
      ...walletsMenu(uid),
    });
  }
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

bot.action(/^wallet_(?!create|import|activate|rename|remove)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  const bal = await provider.getBalance(w.address).catch(() => null);
  const balText = bal !== null ? `${ethers.formatEther(bal)} ETH` : 'unavailable';
  await ctx.editMessageText(
    `*${w.name}*\n\`${w.address}\`\n\nBalance: ${balText}`,
    { parse_mode: 'Markdown', ...walletDetailMenu(w.id) }
  );
});

// ---------- Balance ----------

bot.action('menu_balance', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));
  const bal = await provider.getBalance(w.address);
  await ctx.editMessageText(
    `💰 *${w.name}*\n\`${w.address}\`\n\nBalance: ${ethers.formatEther(bal)} ETH`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]) }
  );
});

// ---------- Buy / Sell ----------

bot.action('menu_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));
  pending.set(ctx.from.id, { type: 'buy' });
  await ctx.editMessageText('Send: `<token_address> <eth_amount>`\ne.g. `0xABC... 0.05`', { parse_mode: 'Markdown' });
});

bot.action('menu_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));
  pending.set(ctx.from.id, { type: 'sell' });
  await ctx.editMessageText('Send: `<token_address> <token_amount>`\ne.g. `0xABC... 100`', { parse_mode: 'Markdown' });
});

// ---------- Free-text handler for all pending flows ----------

bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  if (!state) return; // ignore stray text, menu is button-driven

  const text = ctx.message.text.trim();

  try {
    if (state.type === 'create_name') {
      const w = createWallet(text);
      addWallet(uid, w);
      pending.delete(uid);
      await ctx.reply(
        `✅ Wallet *${text}* created:\n\`${w.address}\`\n\nFund it with ETH on Robinhood Chain to trade.`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
      return;
    }

    if (state.type === 'import_name') {
      pending.set(uid, { type: 'import_key', name: text });
      await ctx.reply('Now send the private key for this wallet:');
      return;
    }

    if (state.type === 'import_key') {
      const w = importWallet(state.name, text);
      addWallet(uid, w);
      pending.delete(uid);
      await ctx.reply(`✅ Wallet *${state.name}* imported:\n\`${w.address}\``, {
        parse_mode: 'Markdown',
        ...mainMenu(),
      });
      // best-effort: delete the message containing the private key
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      return;
    }

    if (state.type === 'rename') {
      renameWallet(uid, state.walletId, text);
      pending.delete(uid);
      await ctx.reply(`✅ Renamed to *${text}*`, { parse_mode: 'Markdown', ...mainMenu() });
      return;
    }

    if (state.type === 'buy' || state.type === 'sell') {
      const parts = text.split(' ').filter(Boolean);
      if (parts.length !== 2) {
        await ctx.reply('Format: `<token_address> <amount>`', { parse_mode: 'Markdown' });
        return;
      }
      const [tokenAddress, amount] = parts;
      const w = getActiveWallet(uid);
      if (!w) {
        pending.delete(uid);
        await ctx.reply('No active wallet.', mainMenu());
        return;
      }

      pending.delete(uid);
      await ctx.reply('Fetching quote...');

      const isBuy = state.type === 'buy';
      const sellAmount = isBuy
        ? ethers.parseEther(amount).toString()
        : ethers.parseUnits(amount, 18).toString(); // adjust decimals per token if needed

      const quote = await getQuote({
        sellToken: isBuy ? 'ETH' : tokenAddress,
        buyToken: isBuy ? tokenAddress : 'ETH',
        sellAmount,
        taker: w.address,
      });

      await ctx.reply(
        `Quote:\nSell: ${amount} ${isBuy ? 'ETH' : 'tokens'}\nBuy: ~${quote.buyAmountFormatted} ${isBuy ? 'tokens' : 'ETH'}\n\nExecuting...`
      );

      const signer = new ethers.Wallet(w.privateKey, provider);
      const txResponse = await getSwapTx(signer, quote);
      await ctx.reply(`Tx sent: ${txResponse.hash}\nWaiting for confirmation...`);

      const receipt = await txResponse.wait();
      await ctx.reply(`✅ Confirmed in block ${receipt.blockNumber}`, mainMenu());
      return;
    }
  } catch (err) {
    console.error(err);
    pending.delete(uid);
    await ctx.reply(`❌ Error: ${err.message}`, mainMenu());
  }
});

bot.launch();
console.log('Panchi trading bot running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
