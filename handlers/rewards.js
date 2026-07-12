import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { stopAllViewRefreshes } from '../state.js';
import { getTicketCount, getOrCreateReferralCode } from '../storage.js';
import { rewardsMenu } from '../menus.js';
import { referralLink } from '../format.js';

bot.action('menu_rewards', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const uid = ctx.from.id;
  const tickets = getTicketCount(uid);
  await ctx.editMessageText(
    `🎟 *Rewards*\n\n` +
    `Refer friends to earn raffle tickets for a chance to win a prize.\n` +
    `1 successful referral = 1 ticket. No limit.\n\n` +
    `Your tickets: *${tickets}*`,
    { parse_mode: 'Markdown', ...rewardsMenu() }
  );
});

bot.action('rewards_link', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const code = getOrCreateReferralCode(uid);
  const link = referralLink(code);
  await ctx.editMessageText(
    `🔗 *Your referral link:*\n\`${link}\`\n\n` +
    `Share it — when someone starts the bot through it, you get a raffle ticket.`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_rewards')]]) }
  );
});
