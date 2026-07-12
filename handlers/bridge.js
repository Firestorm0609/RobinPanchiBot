import { ethers } from 'ethers';
import { bot } from '../bot-instance.js';
import { getEthUsdPrice } from '../price.js';
import { fmtUsd } from '../price.js';
import {
  getBridgeQuote, estimateBridgeGasEth, BRIDGE_DIRECTION, chainIdsForDirection, ETH_CHAIN_ID,
} from '../bridge.js';
import { pending, stopAllViewRefreshes, gasMultiplierFor } from '../state.js';
import { getActiveWallet, getSettings, getBridgeHistory } from '../storage.js';
import { provider, ethMainnetProvider, MIN_BRIDGE_ETH } from '../config.js';
import { friendlyErrorMessage, fmtEth, fmtAmountLabel, getBridgeBalances, fmtBridgeBalanceLine } from '../format.js';
import { walletsMenu, bridgeMenu, bridgeConfirmMenu, directionLabel } from '../menus.js';
import { isRateLimited } from '../ratelimit.js';
import { executeBridge } from '../bridge-actions.js';
import { Markup } from 'telegraf';
import { shortAddr } from '../wallet.js';

bot.action('menu_bridge', async (ctx) => {
  await ctx.answerCbQuery();
  stopAllViewRefreshes(ctx.from.id);
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));

  await ctx.editMessageText('🌉 *Bridge ETH*\n\nFetching your balances...', { parse_mode: 'Markdown' });

  const [balances, ethUsd] = await Promise.all([
    getBridgeBalances(w.address),
    getEthUsdPrice().catch(() => null),
  ]);

  const balanceLinesArr = [
    fmtBridgeBalanceLine('Ethereum — ETH', balances.ethMainnet, ethUsd),
    fmtBridgeBalanceLine('Robinhood — ETH', balances.ethRobinhood, ethUsd),
    fmtBridgeBalanceLine('Robinhood — USDG', balances.usdgRobinhood, balances.usdgRobinhood !== null ? 1 : null),
  ];

  await ctx.editMessageText(
    `🌉 *Bridge ETH*\n\n` +
    `Move ETH between Ethereum mainnet and Robinhood Chain.\n` +
    `Active wallet: *${w.name}* (\`${shortAddr(w.address)}\`)\n\n` +
    `*Your balances:*\n${balanceLinesArr.join('\n')}\n\n` +
    `You'll be able to enter the amount in USD or ETH, or use 💯 Bridge All to send your full balance minus gas.`,
    { parse_mode: 'Markdown', ...bridgeMenu() }
  );
});

bot.action(/^bridge_dir_(eth_to_robinhood|robinhood_to_eth)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const direction = ctx.match[1] === 'eth_to_robinhood' ? BRIDGE_DIRECTION.ETH_TO_ROBINHOOD : BRIDGE_DIRECTION.ROBINHOOD_TO_ETH;
  pending.set(ctx.from.id, { type: 'bridge_amount', direction });

  const w = getActiveWallet(ctx.from.id);
  let sourceBalanceLine = '';
  if (w) {
    const sourceProvider = direction === BRIDGE_DIRECTION.ETH_TO_ROBINHOOD ? ethMainnetProvider : provider;
    const bal = await sourceProvider.getBalance(w.address).then((b) => Number(ethers.formatEther(b))).catch(() => null);
    if (bal !== null) sourceBalanceLine = `\nAvailable: ${fmtEth(bal)} ETH\n`;
  }

  await ctx.editMessageText(
    `Send the amount to bridge (${directionLabel(direction)}) — USD like \`100\`, or ETH like \`0.05 eth\`:${sourceBalanceLine}`,
    { parse_mode: 'Markdown' }
  );
});

// ---------- Bridge All ----------
// Reads the wallet's live source-chain balance, gets a bridge quote to work
// out the actual gas cost, reserves gas (+20% buffer so a congestion-driven
// fee bump at send time doesn't push the tx over the reserved amount), caps
// at the user's maxBridgeEth if needed, then hands off to the SAME confirm
// screen / bridge_confirm_ handler as a manual amount — no new send path.
bot.action(/^bridgeall_(eth_to_robinhood|robinhood_to_eth)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const dirKey = ctx.match[1];
  const direction = dirKey === 'eth_to_robinhood' ? BRIDGE_DIRECTION.ETH_TO_ROBINHOOD : BRIDGE_DIRECTION.ROBINHOOD_TO_ETH;
  const uid = ctx.from.id;

  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(uid));

  await ctx.editMessageText(`🌉 *${directionLabel(direction)}* — Bridge All\n\nCalculating your full balance minus gas...`, { parse_mode: 'Markdown' });

  const { fromChain } = chainIdsForDirection(direction);
  const sourceProvider = fromChain === ETH_CHAIN_ID ? ethMainnetProvider : provider;

  const balanceWei = await sourceProvider.getBalance(w.address).catch(() => null);
  if (balanceWei === null) {
    return ctx.editMessageText('❌ Could not read your balance right now — try again shortly.', { parse_mode: 'Markdown', ...bridgeMenu() });
  }
  if (balanceWei <= 0n) {
    return ctx.editMessageText('You have no balance on the source chain to bridge.', { parse_mode: 'Markdown', ...bridgeMenu() });
  }

  const balanceEth = Number(ethers.formatEther(balanceWei));

  if (balanceEth < MIN_BRIDGE_ETH) {
    return ctx.editMessageText(
      `❌ Your balance (${fmtEth(balanceEth)} ETH) is below the minimum bridgeable amount (${MIN_BRIDGE_ETH} ETH), even before gas. Add more funds first.`,
      { parse_mode: 'Markdown', ...bridgeMenu() }
    );
  }

  // Get an initial quote against the FULL balance purely to obtain a
  // realistic gas estimate for this route (LI.FI's gas estimate for a
  // native-ETH bridge tx doesn't meaningfully change with amount).
  let probeQuote;
  try {
    probeQuote = await getBridgeQuote({ direction, amountEth: balanceEth, fromAddress: w.address });
  } catch (err) {
    return ctx.editMessageText(`❌ Couldn't get a bridge quote: ${friendlyErrorMessage(err)}`, { parse_mode: 'Markdown', ...bridgeMenu() });
  }

  const gasMultiplier = gasMultiplierFor(uid);
  const gasEth = await estimateBridgeGasEth(sourceProvider, probeQuote, gasMultiplier).catch(() => null);
  if (gasEth === null) {
    return ctx.editMessageText('❌ Could not estimate gas for this route right now — try a manual amount instead.', { parse_mode: 'Markdown', ...bridgeMenu() });
  }

  // 20% buffer on top of the estimate — sendBridgeTx can resubmit with
  // bumped fees if the network is congested, so leave room for that instead
  // of the tx failing from insufficient balance after "bridge all".
  const gasReserve = gasEth * 1.2;
  let sendAmount = balanceEth - gasReserve;

  if (sendAmount <= 0) {
    return ctx.editMessageText(
      `❌ Balance too low to cover gas.\nBalance: ${fmtEth(balanceEth)} ETH\nEst. gas reserve needed: ~${gasReserve.toFixed(6)} ETH`,
      { parse_mode: 'Markdown', ...bridgeMenu() }
    );
  }

  const { maxBridgeEth } = getSettings(uid);
  let cappedNote = '';
  if (sendAmount > maxBridgeEth) {
    sendAmount = maxBridgeEth;
    cappedNote = `\n_Capped at your max bridge size (${maxBridgeEth} ETH) — adjust in Settings if you want to send more._`;
  }

  sendAmount = Number(sendAmount.toFixed(6));
  if (sendAmount <= 0) {
    return ctx.editMessageText('❌ Nothing left to bridge after gas reserve and your max bridge size cap.', { parse_mode: 'Markdown', ...bridgeMenu() });
  }

  if (sendAmount < MIN_BRIDGE_ETH) {
    return ctx.editMessageText(
      `❌ After reserving gas, only ${sendAmount} ETH would be sent — below the minimum bridgeable amount (${MIN_BRIDGE_ETH} ETH). Add more funds first.`,
      { parse_mode: 'Markdown', ...bridgeMenu() }
    );
  }

  // Re-quote for the actual amount we're about to offer for confirmation.
  let finalQuote;
  try {
    finalQuote = await getBridgeQuote({ direction, amountEth: sendAmount, fromAddress: w.address });
  } catch (err) {
    return ctx.editMessageText(`❌ Couldn't get a bridge quote: ${friendlyErrorMessage(err)}`, { parse_mode: 'Markdown', ...bridgeMenu() });
  }

  const ethUsd = await getEthUsdPrice().catch(() => null);
  const sendLabel = fmtAmountLabel(sendAmount, ethUsd ? sendAmount * ethUsd : null);

  await ctx.editMessageText(
    `🌉 *${directionLabel(direction)}* — Bridge All\n\n` +
    `Balance: ${fmtEth(balanceEth)} ETH\n` +
    `Reserved for gas: ~${gasReserve.toFixed(6)} ETH\n` +
    `Send: ${sendLabel}\n` +
    `Receive (est.): ${Number(finalQuote.toAmountFormatted).toFixed(4)} ETH\n` +
    `Fees (est.): ${fmtUsd(finalQuote.feesUsd)}\n` +
    `Via: ${finalQuote.tool || 'best available route'}\n` +
    `ETA: ~${finalQuote.estimatedDurationSeconds ? Math.ceil(finalQuote.estimatedDurationSeconds / 60) + ' min' : 'a few minutes'}` +
    cappedNote +
    `\n\nConfirm?`,
    { parse_mode: 'Markdown', ...bridgeConfirmMenu(dirKey, sendAmount) }
  );
});

bot.action('bridge_history', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const history = getBridgeHistory(uid, 10);
  if (history.length === 0) {
    return ctx.editMessageText('No bridges yet.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_bridge')]]),
    });
  }
  const statusEmoji = { pending: '⏳', submitted: '⏳', done: '✅', failed: '❌' };
  const lines = history.map((b) =>
    `${statusEmoji[b.status] || '•'} ${directionLabel(b.direction)} — ${b.amount_eth} ETH (${b.status})`
  );
  await ctx.editMessageText(`🕘 *Recent Bridges*\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_bridge')]]),
  });
});

bot.action(/^bridge_confirm_(eth_to_robinhood|robinhood_to_eth)_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const direction = ctx.match[1] === 'eth_to_robinhood' ? BRIDGE_DIRECTION.ETH_TO_ROBINHOOD : BRIDGE_DIRECTION.ROBINHOOD_TO_ETH;
  await executeBridge(ctx, ctx.from.id, direction, Number(ctx.match[2]));
});
