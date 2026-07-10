import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { ethers } from 'ethers';
import { getQuote, getSwapTx } from './swap.js';
import { createWallet, importWallet, shortAddr } from './wallet.js';
import { getEthUsdPrice, getTokenMarketData, fmtUsd } from './price.js';
import {
  getUser,
  addWallet,
  removeWallet,
  renameWallet,
  setActiveWallet,
  getActiveWallet,
  getWallet,
  recordTrade,
  getPosition,
} from './storage.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, Number(process.env.CHAIN_ID));

const pending = new Map(); // uid -> { type, ...context }
const CA_REGEX = /^0x[a-fA-F0-9]{40}$/;
const BUY_PRESETS = [0.01, 0.05, 0.1]; // ETH

// ---------- Formatting ----------

function fmtEth(n) {
  return Number(n).toFixed(4);
}

async function balanceLines(address) {
  const bal = await provider.getBalance(address);
  const ethAmount = Number(ethers.formatEther(bal));
  let usdLine = '';
  try {
    const ethUsd = await getEthUsdPrice();
    usdLine = ` (${fmtUsd(ethAmount * ethUsd)})`;
  } catch {
    // price feed hiccup, still show ETH
  }
  return `${fmtEth(ethAmount)} ETH${usdLine}`;
}

// ---------- Menus ----------

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Trade Token', 'menu_trade')],
    [Markup.button.callback('💼 Wallets', 'menu_wallets'), Markup.button.callback('💰 Balance', 'menu_balance')],
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

function tokenMenu(tokenAddress, hasPosition) {
  const rows = [
    BUY_PRESETS.map((amt) => Markup.button.callback(`Buy ${amt} ETH`, `buy_${tokenAddress}_${amt}`)),
  ];
  if (hasPosition) {
    rows.push([
      Markup.button.callback('Sell 25%', `sell_${tokenAddress}_25`),
      Markup.button.callback('Sell 50%', `sell_${tokenAddress}_50`),
      Markup.button.callback('Sell 100%', `sell_${tokenAddress}_100`),
    ]);
  }
  rows.push([
    Markup.button.callback('🔄 Refresh', `refresh_${tokenAddress}`),
    Markup.button.callback('⬅️ Back', 'menu_main'),
  ]);
  return Markup.inlineKeyboard(rows);
}

// ---------- Token info + PnL rendering ----------

async function renderTokenCard(uid, tokenAddress) {
  const w = getActiveWallet(uid);
  if (!w) return { text: 'No active wallet. Add one first.', markup: walletsMenu(uid) };

  const market = await getTokenMarketData(tokenAddress).catch(() => null);
  if (!market) {
    return {
      text: `No market data found for:\n\`${tokenAddress}\`\n\nPool may not exist yet, or DexScreener hasn't indexed it.`,
      markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', `refresh_${tokenAddress}`)],
        [Markup.button.callback('⬅️ Back', 'menu_main')],
      ]),
    };
  }

  const pos = getPosition(uid, w.id, tokenAddress);
  let pnlLine = '';
  if (pos && pos.tokenAmount > 0) {
    const ethUsd = await getEthUsdPrice().catch(() => null);
    const currentValueUsd = pos.tokenAmount * market.priceUsd;
    const costUsd = ethUsd ? pos.costEth * ethUsd : null;
    if (costUsd !== null) {
      const pnlUsd = currentValueUsd - costUsd;
      const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
      const emoji = pnlUsd >= 0 ? '🟢' : '🔴';
      pnlLine = `\n\n*Your position:*\n${pos.tokenAmount.toFixed(4)} ${market.symbol}\nCost: ${fmtUsd(costUsd)} | Value: ${fmtUsd(currentValueUsd)}\nPnL: ${emoji} ${fmtUsd(pnlUsd)} (${pnlPct.toFixed(1)}%)`;
    }
  }

  const changeLine = market.priceChange24h !== null ? ` (${market.priceChange24h >= 0 ? '+' : ''}${market.priceChange24h.toFixed(1)}%)` : '';

  const text =
    `*${market.symbol}*\n\`${tokenAddress}\`\n\n` +
    `Price: $${market.priceUsd.toPrecision(4)}${changeLine}\n` +
    `Market Cap: ${fmtUsd(market.marketCap)}\n` +
    `Liquidity: ${fmtUsd(market.liquidityUsd)}` +
    pnlLine;

  return { text, markup: tokenMenu(tokenAddress, !!(pos && pos.tokenAmount > 0)) };
}

// ---------- Start / Main menu ----------

bot.start((ctx) => {
  ctx.reply('🐒 *Panchi Trading Bot*\n\nPaste a token contract address to trade it.', {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

bot.action('menu_main', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🐒 *Panchi Trading Bot*', { parse_mode: 'Markdown', ...mainMenu() });
});

bot.action('menu_trade', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'awaiting_ca' });
  await ctx.editMessageText('Paste the token contract address:');
});

// ---------- Wallets ----------

bot.action('menu_wallets', async (ctx) => {
  await ctx.answerCbQuery();
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

bot.action(/^wallet_(?!create|import|activate|rename|remove)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  const bal = await balanceLines(w.address).catch(() => 'unavailable');
  await ctx.editMessageText(`*${w.name}*\n\`${w.address}\`\n\nBalance: ${bal}`, {
    parse_mode: 'Markdown',
    ...walletDetailMenu(w.id),
  });
});

// ---------- Balance ----------

bot.action('menu_balance', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));
  const bal = await balanceLines(w.address);
  await ctx.editMessageText(`💰 *${w.name}*\n\`${w.address}\`\n\nBalance: ${bal}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});

// ---------- Token card: refresh ----------

bot.action(/^refresh_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Refreshed');
  const { text, markup } = await renderTokenCard(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup });
});

// ---------- Buy ----------

bot.action(/^buy_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const [, tokenAddress, ethAmountStr] = ctx.match;
  const uid = ctx.from.id;
  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet.', walletsMenu(uid));

  try {
    await ctx.editMessageText(`Buying ${ethAmountStr} ETH worth... fetching quote.`);
    const sellAmount = ethers.parseEther(ethAmountStr).toString();
    const quote = await getQuote({ sellToken: 'ETH', buyToken: tokenAddress, sellAmount, taker: w.address });

    const signer = new ethers.Wallet(w.privateKey, provider);
    const txResponse = await getSwapTx(signer, quote);
    await ctx.reply(`Tx sent: ${txResponse.hash}\nWaiting for confirmation...`);
    const receipt = await txResponse.wait();

    const tokenAmount = Number(quote.buyAmountFormatted);
    recordTrade(uid, w.id, tokenAddress, 'buy', tokenAmount, Number(ethAmountStr));

    const { text, markup } = await renderTokenCard(uid, tokenAddress);
    await ctx.reply(`✅ Confirmed in block ${receipt.blockNumber}`);
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ Trade failed: ${err.message}`, mainMenu());
  }
});

// ---------- Sell ----------

bot.action(/^sell_(0x[a-fA-F0-9]{40})_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const [, tokenAddress, pctStr] = ctx.match;
  const uid = ctx.from.id;
  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet.', walletsMenu(uid));

  const pos = getPosition(uid, w.id, tokenAddress);
  if (!pos || pos.tokenAmount <= 0) return ctx.editMessageText('No position to sell.', mainMenu());

  const pct = Number(pctStr) / 100;
  const tokenAmount = pos.tokenAmount * pct;

  try {
    await ctx.editMessageText(`Selling ${pctStr}%... fetching quote.`);
    const sellAmount = ethers.parseUnits(tokenAmount.toFixed(18), 18).toString(); // adjust decimals per token if needed
    const quote = await getQuote({ sellToken: tokenAddress, buyToken: 'ETH', sellAmount, taker: w.address });

    const signer = new ethers.Wallet(w.privateKey, provider);
    const txResponse = await getSwapTx(signer, quote);
    await ctx.reply(`Tx sent: ${txResponse.hash}\nWaiting for confirmation...`);
    const receipt = await txResponse.wait();

    recordTrade(uid, w.id, tokenAddress, 'sell', tokenAmount, Number(quote.buyAmountFormatted));

    const { text, markup } = await renderTokenCard(uid, tokenAddress);
    await ctx.reply(`✅ Confirmed in block ${receipt.blockNumber}`);
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ Trade failed: ${err.message}`, mainMenu());
  }
});

// ---------- Free-text handler (wallet setup + CA paste) ----------

bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  const text = ctx.message.text.trim();

  // CA paste is allowed any time, not just when explicitly prompted
  if (CA_REGEX.test(text)) {
    pending.delete(uid);
    const { text: cardText, markup } = await renderTokenCard(uid, text);
    await ctx.reply(cardText, { parse_mode: 'Markdown', ...markup });
    return;
  }

  if (!state) return;

  try {
    if (state.type === 'awaiting_ca') {
      await ctx.reply('That doesn\'t look like a valid contract address. Paste a valid 0x... address.');
      return;
    }

    if (state.type === 'create_name') {
      const w = createWallet(text);
      addWallet(uid, w);
      pending.delete(uid);
      await ctx.reply(`✅ Wallet *${text}* created:\n\`${w.address}\`\n\nFund it with ETH on Robinhood Chain to trade.`, {
        parse_mode: 'Markdown',
        ...mainMenu(),
      });
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
      await ctx.reply(`✅ Wallet *${state.name}* imported:\n\`${w.address}\``, { parse_mode: 'Markdown', ...mainMenu() });
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      return;
    }

    if (state.type === 'rename') {
      renameWallet(uid, state.walletId, text);
      pending.delete(uid);
      await ctx.reply(`✅ Renamed to *${text}*`, { parse_mode: 'Markdown', ...mainMenu() });
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
