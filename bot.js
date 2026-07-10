import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { ethers } from 'ethers';
import { getQuote, getSwapTx } from './swap.js';
import { ensureAllowance, getDecimals } from './erc20.js';
import { createWallet, importWallet, shortAddr } from './wallet.js';
import { getEthUsdPrice, getTokenMarketData, fmtUsd } from './price.js';
import { sendAdminAlert } from './alerts.js';
import { isRateLimited } from './ratelimit.js';
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
  getAllPositions,
  getSettings,
  updateSettings,
  createPendingTrade,
  markPendingTradeSubmitted,
  markPendingTradeDone,
  getStuckPendingTrades,
} from './storage.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, Number(process.env.CHAIN_ID));

const pending = new Map(); // uid -> { type, ...context }
const tradesInFlight = new Set(); // uid -> locked while a trade is executing (double-tap guard)
const CA_REGEX = /^0x[a-fA-F0-9]{40}$/;
const QUOTE_STALE_MS = 15_000; // re-quote if this much time passes before sending the tx

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

/** Re-fetches the quote if too much time has passed since it was first obtained. */
async function getFreshQuote(quoteParams, quote, fetchedAt) {
  if (Date.now() - fetchedAt < QUOTE_STALE_MS) return quote;
  return getQuote(quoteParams);
}

// ---------- Menus ----------

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Trade Token', 'menu_trade')],
    [Markup.button.callback('📊 Positions', 'menu_positions')],
    [Markup.button.callback('💼 Wallets', 'menu_wallets'), Markup.button.callback('💰 Balance', 'menu_balance')],
    [Markup.button.callback('⚙️ Settings', 'menu_settings')],
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

function settingsMenu(uid) {
  const s = getSettings(uid);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Buy presets: ${s.buyPresetsEth.join(', ')} ETH`, 'settings_buy')],
    [Markup.button.callback(`Sell presets: ${s.sellPresetsPct.join(', ')}%`, 'settings_sell')],
    [Markup.button.callback(`Slippage: ${(s.slippageBps / 100).toFixed(2)}%`, 'settings_slippage')],
    [Markup.button.callback(`Max buy size: ${s.maxBuyEth} ETH`, 'settings_maxbuy')],
    [Markup.button.callback(`Confirm before trade: ${s.confirmTrades ? 'ON ✅' : 'OFF ❌'}`, 'settings_toggle_confirm')],
    [Markup.button.callback('⬅️ Back', 'menu_main')],
  ]);
}

function tokenMenu(uid, tokenAddress, hasPosition) {
  const s = getSettings(uid);
  const rows = [
    s.buyPresetsEth.map((amt) => Markup.button.callback(`Buy ${amt} ETH`, `buy_${tokenAddress}_${amt}`)),
    [Markup.button.callback('✏️ Custom Buy', `custombuy_${tokenAddress}`)],
  ];
  if (hasPosition) {
    rows.push(s.sellPresetsPct.map((pct) => Markup.button.callback(`Sell ${pct}%`, `sell_${tokenAddress}_${pct}`)));
    rows.push([Markup.button.callback('✏️ Custom Sell', `customsell_${tokenAddress}`)]);
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
  const walletBalance = await balanceLines(w.address).catch(() => 'unavailable');

  const text =
    `*${market.symbol}*\n\`${tokenAddress}\`\n\n` +
    `Price: $${market.priceUsd.toPrecision(4)}${changeLine}\n` +
    `Market Cap: ${fmtUsd(market.marketCap)}\n` +
    `Liquidity: ${fmtUsd(market.liquidityUsd)}\n` +
    `Your balance: ${walletBalance}` +
    pnlLine;

  return { text, markup: tokenMenu(uid, tokenAddress, !!(pos && pos.tokenAmount > 0)) };
}

// ---------- Shared trade execution ----------

async function executeBuy(ctx, uid, tokenAddress, ethAmount) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

  const { maxBuyEth } = getSettings(uid);
  if (ethAmount > maxBuyEth) {
    return ctx.reply(`❌ ${ethAmount} ETH exceeds your max buy size (${maxBuyEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
  }

  if (tradesInFlight.has(uid)) {
    return ctx.reply('⏳ A trade is already in progress — please wait for it to finish.');
  }
  tradesInFlight.add(uid);

  let pendingTradeId;
  try {
    await ctx.reply(`Buying ${ethAmount} ETH worth... fetching quote.`);
    const sellAmount = ethers.parseEther(ethAmount.toString()).toString();
    const { slippageBps } = getSettings(uid);
    const quoteParams = { sellToken: 'ETH', buyToken: tokenAddress, sellAmount, taker: w.address, slippageBps };

    pendingTradeId = createPendingTrade({ uid, walletId: w.id, tokenAddress, side: 'buy', amount: ethAmount });

    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    const signer = new ethers.Wallet(w.privateKey, provider);
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txResponse = await getSwapTx(signer, quote);
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    await ctx.reply(`Tx sent: ${txResponse.hash}\nWaiting for confirmation...`);
    const receipt = await txResponse.wait();
    markPendingTradeDone(pendingTradeId, 'confirmed');
    recordTrade(uid, w.id, tokenAddress, 'buy', Number(quote.buyAmountFormatted), ethAmount);
    await ctx.reply(`✅ Confirmed in block ${receipt.blockNumber}`);
    const { text, markup } = await renderTokenCard(uid, tokenAddress);
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  } catch (err) {
    console.error(err);
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    await ctx.reply(`❌ Trade failed: ${err.message}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Buy failed for user ${uid} on ${tokenAddress}: ${err.message}`);
  } finally {
    tradesInFlight.delete(uid);
  }
}

async function executeSell(ctx, uid, tokenAddress, pct) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
  const pos = getPosition(uid, w.id, tokenAddress);
  if (!pos || pos.tokenAmount <= 0) return ctx.reply('No position to sell.', mainMenu());

  if (tradesInFlight.has(uid)) {
    return ctx.reply('⏳ A trade is already in progress — please wait for it to finish.');
  }
  tradesInFlight.add(uid);

  const tokenAmount = pos.tokenAmount * (pct / 100);
  let pendingTradeId;
  try {
    await ctx.reply(`Selling ${pct}%... fetching quote.`);

    // Fetch the token's real decimals — do not assume 18, many tokens differ.
    const decimals = await getDecimals(provider, tokenAddress).catch(() => 18);
    const sellAmount = ethers.parseUnits(tokenAmount.toFixed(Math.min(decimals, 18)), decimals).toString();

    const { slippageBps } = getSettings(uid);
    const signer = new ethers.Wallet(w.privateKey, provider);

    pendingTradeId = createPendingTrade({ uid, walletId: w.id, tokenAddress, side: 'sell', amount: tokenAmount });

    const approvalReceipt = await ensureAllowance(signer, tokenAddress, BigInt(sellAmount));
    if (approvalReceipt) await ctx.reply('Approved token for trading (one-time step). Continuing...');

    const quoteParams = { sellToken: tokenAddress, buyToken: 'ETH', sellAmount, taker: w.address, slippageBps };
    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    // Approval above can take a while to confirm — re-quote if price may have moved since.
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txResponse = await getSwapTx(signer, quote);
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    await ctx.reply(`Tx sent: ${txResponse.hash}\nWaiting for confirmation...`);
    const receipt = await txResponse.wait();
    markPendingTradeDone(pendingTradeId, 'confirmed');
    recordTrade(uid, w.id, tokenAddress, 'sell', tokenAmount, Number(quote.buyAmountFormatted));
    await ctx.reply(`✅ Confirmed in block ${receipt.blockNumber}`);
    const { text, markup } = await renderTokenCard(uid, tokenAddress);
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  } catch (err) {
    console.error(err);
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    await ctx.reply(`❌ Trade failed: ${err.message}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Sell failed for user ${uid} on ${tokenAddress}: ${err.message}`);
  } finally {
    tradesInFlight.delete(uid);
  }
}

function confirmMenu(kind, tokenAddress, value) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', `confirm_${kind}_${tokenAddress}_${value}`),
      Markup.button.callback('❌ Cancel', 'cancel_trade'),
    ],
  ]);
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

// ---------- Positions ----------

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(uid));

  const positions = getAllPositions(uid, w.id);
  if (positions.length === 0) {
    return ctx.editMessageText('📊 No positions yet. Trade a token to open one.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
    });
  }

  const ethUsd = await getEthUsdPrice().catch(() => null);
  const rows = [];
  let text = `📊 *Positions* — ${w.name}\n`;

  for (const pos of positions) {
    const market = await getTokenMarketData(pos.tokenAddress).catch(() => null);
    const symbol = market?.symbol ?? shortAddr(pos.tokenAddress);
    if (market && ethUsd) {
      const valueUsd = pos.tokenAmount * market.priceUsd;
      const costUsd = pos.costEth * ethUsd;
      const pnlUsd = valueUsd - costUsd;
      const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
      const emoji = pnlUsd >= 0 ? '🟢' : '🔴';
      text += `\n*${symbol}*: ${pos.tokenAmount.toFixed(4)} — ${fmtUsd(valueUsd)} (${emoji} ${pnlPct.toFixed(1)}%)`;
    } else {
      text += `\n*${symbol}*: ${pos.tokenAmount.toFixed(4)} — price unavailable`;
    }
    rows.push([Markup.button.callback(`View ${symbol}`, `refresh_${pos.tokenAddress}`)]);
  }

  rows.push([Markup.button.callback('⬅️ Back', 'menu_main')]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
});

// ---------- Settings ----------

bot.action('menu_settings', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

bot.action('settings_buy', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_buy' });
  await ctx.editMessageText('Send comma-separated ETH amounts, e.g. `0.01, 0.05, 0.2`', { parse_mode: 'Markdown' });
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
  await ctx.editMessageText('Send the max ETH allowed per single buy, e.g. `0.5`', { parse_mode: 'Markdown' });
});

bot.action('settings_toggle_confirm', async (ctx) => {
  const s = getSettings(ctx.from.id);
  updateSettings(ctx.from.id, { confirmTrades: !s.confirmTrades });
  await ctx.answerCbQuery(`Confirmation ${!s.confirmTrades ? 'enabled' : 'disabled'}`);
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

// ---------- Custom buy/sell prompts ----------

bot.action(/^custombuy_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_buy', tokenAddress: ctx.match[1] });
  await ctx.editMessageText('Send the ETH amount to spend, e.g. `0.03`');
});

bot.action(/^customsell_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_sell', tokenAddress: ctx.match[1] });
  await ctx.editMessageText('Send the percentage to sell, e.g. `40` for 40%');
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
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup }).catch((err) => {
    if (!err.description?.includes('message is not modified')) throw err;
  });
});

// ---------- Buy ----------

bot.action(/^buy_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const [, tokenAddress, ethAmountStr] = ctx.match;
  const uid = ctx.from.id;
  const { confirmTrades, maxBuyEth } = getSettings(uid);
  const ethAmount = Number(ethAmountStr);
  if (ethAmount > maxBuyEth) {
    return ctx.editMessageText(`❌ ${ethAmount} ETH exceeds your max buy size (${maxBuyEth} ETH).`, mainMenu());
  }
  if (confirmTrades) {
    await ctx.editMessageText(`Confirm: buy *${ethAmountStr} ETH* worth of this token?`, {
      parse_mode: 'Markdown',
      ...confirmMenu('buy', tokenAddress, ethAmountStr),
    });
  } else {
    await executeBuy(ctx, uid, tokenAddress, ethAmount);
  }
});

// ---------- Sell ----------

bot.action(/^sell_(0x[a-fA-F0-9]{40})_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const [, tokenAddress, pctStr] = ctx.match;
  const uid = ctx.from.id;
  const { confirmTrades } = getSettings(uid);
  if (confirmTrades) {
    await ctx.editMessageText(`Confirm: sell *${pctStr}%* of your position?`, {
      parse_mode: 'Markdown',
      ...confirmMenu('sell', tokenAddress, pctStr),
    });
  } else {
    await executeSell(ctx, uid, tokenAddress, Number(pctStr));
  }
});

bot.action(/^confirm_buy_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  await executeBuy(ctx, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

bot.action(/^confirm_sell_(0x[a-fA-F0-9]{40})_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  await executeSell(ctx, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

bot.action('cancel_trade', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('Trade cancelled.', mainMenu());
});

// ---------- Free-text handler (wallet setup + CA paste) ----------

bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  const text = ctx.message.text.trim();

  // CA paste is allowed any time, not just when explicitly prompted
  if (CA_REGEX.test(text)) {
    if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many lookups in the last minute.');
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

    if (state.type === 'settings_buy') {
      const amounts = text.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0);
      if (amounts.length === 0) return ctx.reply('Send valid numbers, e.g. `0.01, 0.05, 0.2`', { parse_mode: 'Markdown' });
      updateSettings(uid, { buyPresetsEth: amounts });
      pending.delete(uid);
      await ctx.reply(`✅ Buy presets updated: ${amounts.join(', ')} ETH`, mainMenu());
      return;
    }

    if (state.type === 'settings_sell') {
      const pcts = text.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0 && n <= 100);
      if (pcts.length === 0) return ctx.reply('Send valid percentages (1-100), e.g. `25, 50, 100`');
      updateSettings(uid, { sellPresetsPct: pcts });
      pending.delete(uid);
      await ctx.reply(`✅ Sell presets updated: ${pcts.join(', ')}%`, mainMenu());
      return;
    }

    if (state.type === 'settings_slippage') {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0 || pct > 50) return ctx.reply('Send a valid percentage between 0 and 50.');
      updateSettings(uid, { slippageBps: Math.round(pct * 100) });
      pending.delete(uid);
      await ctx.reply(`✅ Slippage set to ${pct}%`, mainMenu());
      return;
    }

    if (state.type === 'settings_maxbuy') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) return ctx.reply('Send a valid positive ETH amount, e.g. `0.5`');
      updateSettings(uid, { maxBuyEth: amt });
      pending.delete(uid);
      await ctx.reply(`✅ Max buy size set to ${amt} ETH`, mainMenu());
      return;
    }

    if (state.type === 'custom_buy' || state.type === 'custom_sell') {
      const isBuy = state.type === 'custom_buy';
      const val = parseFloat(text);
      if (isNaN(val) || val <= 0 || (!isBuy && val > 100)) return ctx.reply('Send a valid positive number' + (isBuy ? '.' : ' (max 100 for %).'));

      if (isBuy) {
        const { maxBuyEth } = getSettings(uid);
        if (val > maxBuyEth) {
          pending.delete(uid);
          return ctx.reply(`❌ ${val} ETH exceeds your max buy size (${maxBuyEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
        }
      }

      pending.delete(uid);

      const { confirmTrades } = getSettings(uid);
      if (confirmTrades) {
        const kind = isBuy ? 'buy' : 'sell';
        const label = isBuy ? `${val} ETH` : `${val}%`;
        await ctx.reply(`Confirm: ${isBuy ? 'buy' : 'sell'} *${label}*?`, {
          parse_mode: 'Markdown',
          ...confirmMenu(kind, state.tokenAddress, val),
        });
      } else if (isBuy) {
        await executeBuy(ctx, uid, state.tokenAddress, val);
      } else {
        await executeSell(ctx, uid, state.tokenAddress, val);
      }
      return;
    }
  } catch (err) {
    console.error(err);
    pending.delete(uid);
    await ctx.reply(`❌ Error: ${err.message}`, mainMenu());
  }
});

// ---------- Startup: crash recovery check ----------

async function checkStuckTrades() {
  const stuck = getStuckPendingTrades();
  if (stuck.length === 0) return;
  const lines = stuck.map((t) =>
    `• ${t.side} ${t.amount} on ${t.token_address} (user ${t.uid}, status: ${t.status}${t.tx_hash ? `, tx: ${t.tx_hash}` : ''})`
  );
  await sendAdminAlert(
    bot.telegram,
    `Bot restarted with ${stuck.length} unresolved trade(s) from before the crash — verify these manually:\n${lines.join('\n')}`
  );
  console.warn(`${stuck.length} pending trade(s) unresolved from before restart. See admin alert / pending_trades table.`);
}

bot.launch().then(checkStuckTrades);
console.log('Panchi trading bot running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
