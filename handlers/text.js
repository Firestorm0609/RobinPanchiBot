import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { createWallet } from '../wallet.js';
import { getTokenMarketData, findTokenAcrossChains, fmtUsd } from '../price.js';
import { isRateLimited } from '../ratelimit.js';
import { getChain } from '../chains.js';
import {
  getWallet,
  renameWallet,
  getActiveWallet,
  getActiveChain,
  setActiveChain,
  getPosition,
  getSettings,
  updateSettings,
  hasAgreedTerms,
  createAutoRule,
  cancelAutoRule,
  getActiveAutoRuleForPosition,
  createLimitOrder,
  addWallet,
} from '../storage.js';
import { CA_REGEX, SOLANA_ADDRESS_REGEX, FALLBACK_GAS_LIMIT_BUY, FALLBACK_GAS_LIMIT_SELL, TERMS_TEXT } from '../config.js';
import { pending, stopPositionsRefresh } from '../state.js';
import { gasEstimateLine, friendlyErrorMessage, parseUsdcAmountInput, parseMcapInput, mcapToPrice } from '../format.js';
import { mainMenu, walletsMenu, confirmMenu, renderTokenCard } from '../menus.js';
import { executeBuy, executeSell } from '../trade-core.js';
import { scheduleCardAutoRefresh } from '../autorefresh.js';

/** True if `text` looks like an EVM address or a Solana mint. */
function isContractAddress(text) {
  return CA_REGEX.test(text) || SOLANA_ADDRESS_REGEX.test(text);
}

/**
 * Resolves which chain a pasted CA should be traded on.
 *
 * Always checks liquidity across EVERY supported chain first and picks the
 * highest-liquidity match — this matters because the same 0x... address
 * string can be a completely unrelated token on two different EVM chains,
 * so "does it have data on my currently active chain" is not a safe check
 * to run first: it can silently show/trade the wrong token if the active
 * chain happens to have some (irrelevant) liquidity at that address.
 *
 * This is the ONLY place a user's active chain changes now — there's no
 * manual chain picker anymore, so every trade is on whichever chain this
 * function decides has the best liquidity for the token just pasted.
 *
 * Returns { chainKey, switched } where chainKey is the chain to render/trade
 * on, and switched is true if we moved the user off their active chain.
 * chainKey is null if the token has no data on any supported chain.
 */
async function resolveChainForCA(uid, tokenAddress) {
  const activeChain = getActiveChain(uid);
  const matches = await findTokenAcrossChains(tokenAddress).catch(() => []);

  if (matches.length > 0) {
    const best = matches[0].chainKey;
    if (best !== activeChain) {
      setActiveChain(uid, best);
      return { chainKey: best, switched: true, from: activeChain };
    }
    return { chainKey: best, switched: false };
  }

  // findTokenAcrossChains found nothing (API hiccup, or DexScreener hasn't
  // indexed this pair yet) — fall back to a direct check on the active
  // chain so a real, just-unindexed-by-search token can still be traded.
  const activeMarket = await getTokenMarketData(tokenAddress, activeChain).catch(() => null);
  if (activeMarket) return { chainKey: activeChain, switched: false };

  return { chainKey: null, switched: false };
}

bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  const text = ctx.message.text.trim();

  if (isContractAddress(text)) {
    if (!hasAgreedTerms(uid)) {
      return ctx.reply(TERMS_TEXT, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ I understand, continue', 'agree_terms')]]),
      });
    }
    if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many lookups in the last minute.');
    pending.delete(uid);
    stopPositionsRefresh(uid);

    // Resolves + switches the active chain to wherever this token has the
    // best liquidity, silently (no chat notification on switch — the user
    // just wants the token card).
    const { chainKey } = await resolveChainForCA(uid, text);

    const { text: cardText, markup } = await renderTokenCard(uid, text);
    const sent = await ctx.reply(cardText, { parse_mode: 'Markdown', ...markup });
    scheduleCardAutoRefresh(uid, text, sent.chat.id, sent.message_id);
    return;
  }

  if (!state) return;

  try {
    if (state.type === 'awaiting_ca') {
      await ctx.reply('That doesn\'t look like a valid address. Paste a valid EVM (0x...) address or a Solana mint.');
      return;
    }

    if (state.type === 'create_name') {
      const w = createWallet(text);
      addWallet(uid, w);
      pending.delete(uid);
      await ctx.reply(
        `✅ Wallet *${text}* created:\nEVM: \`${w.evmAddress}\`\nSolana: \`${w.solAddress}\`\n\nDeposit native USDC on any supported chain to trade there — no bridging needed.`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
      return;
    }

    if (state.type === 'export_type_confirm') {
      pending.delete(uid);
      if (text !== state.walletName) {
        await ctx.reply('❌ Name didn\'t match — export cancelled.', mainMenu());
        return;
      }
      const w = getWallet(uid, state.walletId);
      if (!w) return ctx.reply('Wallet not found.', walletsMenu(uid));
      await ctx.reply(
        `🔑 *${w.name}* private keys:\nEVM: \`${w.privateKey}\`\nSolana: \`${w.solPrivateKey}\`\n\n` +
        'Save these somewhere safe, then delete this message. Anyone with these keys can drain the wallet.',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_wallets')]]) }
      );
      return;
    }

    if (state.type === 'rename') {
      renameWallet(uid, state.walletId, text);
      pending.delete(uid);
      await ctx.reply(`✅ Renamed to *${text}*`, { parse_mode: 'Markdown', ...mainMenu() });
      return;
    }

    if (state.type === 'settings_buy') {
      const amounts = text.split(',').map((s) => parseFloat(s.trim().replace(/^\$/, ''))).filter((n) => !isNaN(n) && n > 0);
      if (amounts.length === 0) return ctx.reply('Send valid USD numbers, e.g. `10, 50, 200`');
      updateSettings(uid, { buyPresetsUsdc: amounts });
      pending.delete(uid);
      await ctx.reply(`✅ Buy presets updated: ${amounts.map(fmtUsd).join(', ')}`, mainMenu());
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
      const usd = parseFloat(text.replace(/^\$/, ''));
      if (isNaN(usd) || usd <= 0) return ctx.reply('Send a valid positive USD amount, e.g. `500`');
      updateSettings(uid, { maxBuyUsdc: usd });
      pending.delete(uid);
      await ctx.reply(`✅ Max buy size set to ${fmtUsd(usd)}`, mainMenu());
      return;
    }

    if (state.type === 'settings_lowbalance') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt < 0) return ctx.reply('Send a valid non-negative amount (native gas token), e.g. `0.01`, or `0` to disable.');
      updateSettings(uid, { lowBalanceThresholdEth: amt });
      pending.delete(uid);
      await ctx.reply(
        amt === 0 ? '✅ Low balance alerts disabled.' : `✅ Low balance alert threshold set to ${amt} (native token)`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'custom_buy') {
      let val;
      try {
        val = parseUsdcAmountInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      const { maxBuyUsdc } = getSettings(uid);
      if (val > maxBuyUsdc) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtUsd(val)} exceeds your max buy size. Adjust it in Settings if this was intentional.`, mainMenu());
      }

      pending.delete(uid);

      const { confirmTrades } = getSettings(uid);
      if (confirmTrades) {
        const chainKey = getActiveChain(uid);
        const gasLine = await gasEstimateLine(chainKey, uid, FALLBACK_GAS_LIMIT_BUY);
        await ctx.reply(`Confirm: buy *${fmtUsd(val)}* on ${getChain(chainKey).name}?${gasLine}`, {
          parse_mode: 'Markdown',
          ...confirmMenu('buy', state.tokenAddress, val),
        });
      } else {
        await executeBuy(ctx, uid, state.tokenAddress, val);
      }
      return;
    }

    if (state.type === 'custom_sell') {
      const val = parseFloat(text);
      if (isNaN(val) || val <= 0 || val > 100) return ctx.reply('Send a valid positive number (max 100 for %).');

      pending.delete(uid);

      const { confirmTrades } = getSettings(uid);
      if (confirmTrades) {
        const chainKey = getActiveChain(uid);
        const gasLine = await gasEstimateLine(chainKey, uid, FALLBACK_GAS_LIMIT_SELL);
        await ctx.reply(`Confirm: sell *${val}%*?${gasLine}`, {
          parse_mode: 'Markdown',
          ...confirmMenu('sell', state.tokenAddress, val),
        });
      } else {
        await executeSell(ctx, uid, state.tokenAddress, val);
      }
      return;
    }

    if (state.type === 'tpsl_input') {
      const parts = text.split(',').map((s) => parseFloat(s.trim()));
      if (parts.length !== 2 || parts.some((n) => isNaN(n) || n < 0)) {
        return ctx.reply('Send two non-negative numbers separated by a comma, e.g. `50,20`');
      }
      const [tpRaw, slRaw] = parts;
      const tpPct = tpRaw > 0 ? tpRaw : null;
      const slPct = slRaw > 0 ? slRaw : null;
      if (tpPct === null && slPct === null) return ctx.reply('At least one of TP or SL must be non-zero.');

      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      const chainKey = getActiveChain(uid);
      const pos = getPosition(uid, w.id, chainKey, state.tokenAddress);
      if (!pos || pos.tokenAmount <= 0) {
        pending.delete(uid);
        return ctx.reply('No open position on this token to set a rule for.', mainMenu());
      }

      pending.delete(uid);

      const existing = getActiveAutoRuleForPosition(uid, w.id, chainKey, state.tokenAddress);
      if (existing) cancelAutoRule(uid, existing.id);

      createAutoRule({ uid, walletId: w.id, chain: chainKey, tokenAddress: state.tokenAddress, tpPct, slPct });
      const parts2 = [];
      if (tpPct !== null) parts2.push(`TP +${tpPct}%`);
      if (slPct !== null) parts2.push(`SL -${slPct}%`);
      await ctx.reply(
        `✅ Auto-sell rule set: ${parts2.join(' / ')}. I'll sell 100% of this position automatically and DM you when it fires.`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'limitbuy_mcap') {
      let targetMcap;
      try {
        targetMcap = parseMcapInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      const chainKey = getActiveChain(uid);
      const market = await getTokenMarketData(state.tokenAddress, chainKey).catch(() => null);
      const triggerPrice = mcapToPrice(targetMcap, market);
      if (triggerPrice === null) {
        return ctx.reply('Could not fetch live market data for this token right now — try again in a moment.');
      }

      pending.set(uid, { type: 'limitbuy_amount', tokenAddress: state.tokenAddress, chain: chainKey, triggerPrice, targetMcap });
      await ctx.reply('Send the USD amount to spend when triggered, e.g. `100`:', { parse_mode: 'Markdown' });
      return;
    }

    if (state.type === 'limitbuy_amount') {
      let amt;
      try {
        amt = parseUsdcAmountInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      const { maxBuyUsdc } = getSettings(uid);
      if (amt > maxBuyUsdc) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtUsd(amt)} exceeds your max buy size (${fmtUsd(maxBuyUsdc)}). Adjust it in Settings if this was intentional.`, mainMenu());
      }

      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      pending.delete(uid);
      createLimitOrder({ uid, walletId: w.id, chain: state.chain, tokenAddress: state.tokenAddress, side: 'buy', triggerPrice: state.triggerPrice, amount: amt, targetMcap: state.targetMcap });
      await ctx.reply(
        `✅ Limit buy queued on ${getChain(state.chain).name}: ${fmtUsd(amt)} when mcap ≤ ${fmtUsd(state.targetMcap)}. I'll DM you when it fills.`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'limitsell_mcap') {
      let targetMcap;
      try {
        targetMcap = parseMcapInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      const chainKey = getActiveChain(uid);
      const pos = getPosition(uid, w.id, chainKey, state.tokenAddress);
      if (!pos || pos.tokenAmount <= 0) {
        pending.delete(uid);
        return ctx.reply('No open position on this token to sell.', mainMenu());
      }

      const market = await getTokenMarketData(state.tokenAddress, chainKey).catch(() => null);
      const triggerPrice = mcapToPrice(targetMcap, market);
      if (triggerPrice === null) {
        return ctx.reply('Could not fetch live market data for this token right now — try again in a moment.');
      }

      pending.set(uid, { type: 'limitsell_amount', tokenAddress: state.tokenAddress, chain: chainKey, triggerPrice, targetMcap, maxAmount: pos.tokenAmount });
      await ctx.reply(`Send the token amount to sell when triggered (you hold ${pos.tokenAmount.toFixed(4)}):`);
      return;
    }

    if (state.type === 'limitsell_amount') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) return ctx.reply('Send a valid positive token amount.');
      pending.delete(uid);
      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      const clamped = Math.min(amt, state.maxAmount);
      createLimitOrder({ uid, walletId: w.id, chain: state.chain, tokenAddress: state.tokenAddress, side: 'sell', triggerPrice: state.triggerPrice, amount: clamped, targetMcap: state.targetMcap });
      await ctx.reply(
        `✅ Limit sell queued on ${getChain(state.chain).name}: ${clamped.toFixed(4)} tokens when mcap ≥ ${fmtUsd(state.targetMcap)}. I'll DM you when it fills.`,
        mainMenu()
      );
      return;
    }
  } catch (err) {
    console.error(err);
    pending.delete(uid);
    await ctx.reply(`❌ Error: ${friendlyErrorMessage(err)}`, mainMenu());
  }
});
