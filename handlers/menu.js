import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { sendAdminAlert } from '../alerts.js';
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
  getStats,
  getInFlightBridges,
  markPendingBridgeDone,
} from '../storage.js';
import { CA_REGEX, TERMS_TEXT, HELP_TEXT, WELCOME_TEXT } from '../config.js';
import { stopAllViewRefreshes, pending } from '../state.js';
import { friendlyErrorMessage } from '../format.js';
import { mainMenu, walletsMenu, directionLabel } from '../menus.js';
import { checkBridgeStatusOnce } from '../bridge.js';

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
    // generateFlexCard handles both an open position (live unrealized PnL)
    // and a closed one (realized PnL from trade history) — it returns null
    // only if there's no trade history at all for this token on this wallet,
    // or market data is unavailable.
    const cardBuffer = await generateFlexCard(uid, arg);
    if (!cardBuffer) {
      return ctx.reply('No trade history on that token for your active wallet — nothing to flex.', mainMenu());
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
  await ctx.reply(
    `📊 *Admin Stats*\n\n` +
    `Users: ${s.totalUsers}\n` +
    `Wallets: ${s.totalWallets}\n` +
    `Open positions: ${s.openPositions}\n` +
    `Total trades: ${s.totalTrades}\n` +
    `Total volume: ${fmtUsd(s.totalVolumeUsdc)}\n` +
    `Est. fees earned: ${fmtUsd(estFeesUsdc)}\n` +
    `Total referrals: ${s.totalReferrals}\n` +
    `Total bridges: ${s.totalBridges} (completed volume: ${s.totalBridgeVolumeEth.toFixed(4)} ETH)\n` +
    `Active TP/SL rules: ${s.activeAutoRules}\n` +
    `Open limit orders: ${s.openLimitOrders}\n\n` +
    `Last 24h:\n` +
    `Active users: ${s.activeUsers24h}\n` +
    `Volume: ${fmtUsd(s.volume24hUsdc)}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('admin_bridges', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_CHAT_ID)) return;

  const stuck = getInFlightBridges();
  if (stuck.length === 0) {
    await ctx.reply('No bridges currently pending/submitted.');
    return;
  }

  await ctx.reply(`Checking ${stuck.length} in-flight bridge(s)...`);

  for (const b of stuck) {
    const header = `*${b.id}* — ${directionLabel(b.direction)} — ${b.amount_eth} ETH (user ${b.uid})`;
    if (!b.source_tx_hash) {
      await ctx.reply(`${header}\nStatus: no source tx hash recorded — cannot recheck, needs manual verification.`, { parse_mode: 'Markdown' });
      continue;
    }
    try {
      const result = await checkBridgeStatusOnce({
        txHash: b.source_tx_hash,
        fromChain: b.from_chain,
        toChain: b.to_chain,
        bridgeTool: b.bridge_tool,
      });
      if (result.status === 'DONE') {
        markPendingBridgeDone(b.id, 'done', result.destTxHash);
        await ctx.reply(`${header}\n✅ LI.FI reports DONE — marked as completed.`, { parse_mode: 'Markdown' });
      } else if (result.status === 'FAILED') {
        markPendingBridgeDone(b.id, 'failed', null);
        await ctx.reply(`${header}\n❌ LI.FI reports FAILED — marked as failed.`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(`${header}\n⏳ LI.FI still reports PENDING. Source tx: \`${b.source_tx_hash}\``, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      await ctx.reply(`${header}\n⚠️ Status check errored: ${friendlyErrorMessage(err)}\nSource tx: \`${b.source_tx_hash}\``, { parse_mode: 'Markdown' });
    }
  }
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
  await ctx.editMessageText('Paste the token contract address:');
});

bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  await ctx.editMessageText(HELP_TEXT, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});
