import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { isRateLimited } from '../ratelimit.js';
import { generateFlexCard } from '../pnl-card.js';
import { fmtUsd } from '../price.js';
import {
  hasAgreedTerms,
  setAgreedTerms,
  findUidByReferralCode,
  recordReferral,
  hasBeenReferred,
  getActiveWallet,
  getActiveChain,
  getStats,
} from '../storage.js';
import { CA_REGEX, TERMS_TEXT, HELP_TEXT, WELCOME_TEXT } from '../config.js';
import { stopAllViewRefreshes, pending } from '../state.js';
import { mainMenu, walletsMenu } from '../menus.js';

bot.start(async (ctx) => {
  const uid = ctx.from.id;
  const payload = ctx.startPayload;

  if (payload && payload.startsWith('ref_') && !hasBeenReferred(uid)) {
    const code = payload.slice(4);
    const referrerUid = findUidByReferralCode(code);
    if (referrerUid) recordReferral(referrerUid, uid);
  }

  if (!hasAgreedTerms(uid)) {
    return ctx.reply(TERMS_TEXT, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ I understand, continue', 'agree_terms')]]),
    });
  }
  ctx.reply(WELCOME_TEXT, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

bot.command('help', async (ctx) => {
  await ctx.reply(HELP_TEXT, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Main Menu', 'menu_main')]]),
  });
});

bot.command('flex', async (ctx) => {
  const uid = ctx.from.id;
  const arg = ctx.message.text.split(/\s+/)[1];

  if (!arg || !CA_REGEX.test(arg)) {
    return ctx.reply('Usage: `/flex <contract_address>` — paste a token CA to flex your position.', { parse_mode: 'Markdown' });
  }

  if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');

  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

  try {
    const chainKey = getActiveChain(uid);
    const cardBuffer = await generateFlexCard(uid, chainKey, arg);
    if (!cardBuffer) {
      return ctx.reply('No trade history on that token for your active wallet/chain — nothing to flex.', mainMenu());
    }
    await ctx.replyWithPhoto({ source: cardBuffer });
  } catch (err) {
    console.error('Flex card generation failed:', err.message);
    await ctx.reply('❌ Failed to generate flex card. Try again shortly.', mainMenu());
  }
});

bot.action('agree_terms', async (ctx) => {
  setAgreedTerms(ctx.from.id);
  await ctx.answerCbQuery('Thanks — happy trading');
  await ctx.editMessageText(WELCOME_TEXT, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

bot.command('admin_stats', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_CHAT_ID)) return;
  const s = getStats();
  const feeBps = Number(process.env.AFFILIATE_FEE_BPS || 0);
  const estFeesUsdc = (s.totalVolumeUsdc * feeBps) / 10000;
  const chainLines = s.volumeByChain
    .map((c) => `  ${c.chain}: ${fmtUsd(c.v)} (${c.c} trades)`)
    .join('\n');
  await ctx.reply(
    `📊 *Admin Stats*\n\n` +
    `Users: ${s.totalUsers}\n` +
    `Wallets: ${s.totalWallets}\n` +
    `Open positions: ${s.openPositions}\n` +
    `Total trades: ${s.totalTrades}\n` +
    `Total volume: ${fmtUsd(s.totalVolumeUsdc)}\n` +
    `Est. fees earned: ${fmtUsd(estFeesUsdc)}\n` +
    `Total referrals: ${s.totalReferrals}\n` +
    `Active TP/SL rules: ${s.activeAutoRules}\n` +
    `Open limit orders: ${s.openLimitOrders}\n\n` +
    `Volume by chain:\n${chainLines}\n\n` +
    `Last 24h:\n` +
    `Active users: ${s.activeUsers24h}\n` +
    `Volume: ${fmtUsd(s.volume24hUsdc)}`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('menu_main', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  await ctx.editMessageText('🌴 *RobinPanchi Trading Bot*', { parse_mode: 'Markdown', ...mainMenu() });
});

bot.action('menu_trade', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  pending.set(ctx.from.id, { type: 'awaiting_ca' });
  await ctx.editMessageText('Paste the token contract address (or Solana mint) to trade on your active chain:');
});

bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  await ctx.editMessageText(HELP_TEXT, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});
