import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';
import { getQuote, getSwapTx } from './swap.js';
import { loadWallet, createWallet } from './wallet.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, Number(process.env.CHAIN_ID));

// In-memory session store: telegram user id -> wallet
// NOTE: swap for persistent encrypted storage before real users touch this.
const sessions = new Map();

bot.start((ctx) => {
  ctx.reply(
    'Panchi Trading Bot 🐒\n\n' +
    '/wallet - view or create your trading wallet\n' +
    '/buy <token_address> <eth_amount> - buy a token\n' +
    '/sell <token_address> <token_amount> - sell a token\n' +
    '/balance - check ETH balance'
  );
});

bot.command('wallet', async (ctx) => {
  const uid = ctx.from.id;
  let w = sessions.get(uid);
  if (!w) {
    w = createWallet();
    sessions.set(uid, w);
    ctx.reply(
      `New wallet created:\n\`${w.address}\`\n\n` +
      `⚠️ Fund this address with ETH on Robinhood Chain to start trading.\n` +
      `Private key is held in bot memory only — for production, use encrypted storage per user.`,
      { parse_mode: 'Markdown' }
    );
  } else {
    ctx.reply(`Your wallet:\n\`${w.address}\``, { parse_mode: 'Markdown' });
  }
});

bot.command('balance', async (ctx) => {
  const uid = ctx.from.id;
  const w = sessions.get(uid);
  if (!w) return ctx.reply('No wallet yet. Run /wallet first.');
  const bal = await provider.getBalance(w.address);
  ctx.reply(`Balance: ${ethers.formatEther(bal)} ETH`);
});

bot.command('buy', async (ctx) => {
  const uid = ctx.from.id;
  const w = sessions.get(uid);
  if (!w) return ctx.reply('No wallet yet. Run /wallet first.');

  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length !== 3) return ctx.reply('Usage: /buy <token_address> <eth_amount>');
  const [, tokenAddress, ethAmount] = parts;

  try {
    ctx.reply('Fetching quote...');
    const sellAmount = ethers.parseEther(ethAmount).toString();
    const quote = await getQuote({
      sellToken: 'ETH',
      buyToken: tokenAddress,
      sellAmount,
      taker: w.address,
    });

    ctx.reply(
      `Quote:\nSell: ${ethAmount} ETH\nBuy: ~${quote.buyAmountFormatted} tokens\n` +
      `Price impact: ${quote.estimatedPriceImpact ?? 'n/a'}%\n\nExecuting...`
    );

    const signer = new ethers.Wallet(w.privateKey, provider);
    const txResponse = await getSwapTx(signer, quote);
    ctx.reply(`Tx sent: ${txResponse.hash}\nWaiting for confirmation...`);

    const receipt = await txResponse.wait();
    ctx.reply(`✅ Confirmed in block ${receipt.blockNumber}`);
  } catch (err) {
    console.error(err);
    ctx.reply(`❌ Trade failed: ${err.message}`);
  }
});

bot.command('sell', async (ctx) => {
  const uid = ctx.from.id;
  const w = sessions.get(uid);
  if (!w) return ctx.reply('No wallet yet. Run /wallet first.');

  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length !== 3) return ctx.reply('Usage: /sell <token_address> <token_amount>');
  const [, tokenAddress, tokenAmount] = parts;

  try {
    ctx.reply('Fetching quote...');
    const sellAmount = ethers.parseUnits(tokenAmount, 18).toString(); // adjust decimals as needed
    const quote = await getQuote({
      sellToken: tokenAddress,
      buyToken: 'ETH',
      sellAmount,
      taker: w.address,
    });

    ctx.reply(`Quote:\nSell: ${tokenAmount} tokens\nBuy: ~${quote.buyAmountFormatted} ETH\n\nExecuting...`);

    const signer = new ethers.Wallet(w.privateKey, provider);
    const txResponse = await getSwapTx(signer, quote);
    ctx.reply(`Tx sent: ${txResponse.hash}\nWaiting for confirmation...`);

    const receipt = await txResponse.wait();
    ctx.reply(`✅ Confirmed in block ${receipt.blockNumber}`);
  } catch (err) {
    console.error(err);
    ctx.reply(`❌ Trade failed: ${err.message}`);
  }
});

bot.launch();
console.log('Panchi trading bot running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
