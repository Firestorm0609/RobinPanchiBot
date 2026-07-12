import { Markup } from 'telegraf';
import { bot } from '../bot-instance.js';
import { createWallet, importWallet, shortAddr } from '../wallet.js';
import { getTokenMarketData, findTokenAcrossChains, fmtUsd } from '../price.js';
import { sendAdminAlert } from '../alerts.js';
import { isRateLimited } from '../ratelimit.js';
import { getChain, isSolanaChain } from '../chains.js';
import {
  getUser,
  addWallet,
  renameWallet,
  getWallet,
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
} from '../storage.js';
import {
  CA_REGEX, SOLANA_ADDRESS_REGEX, FALLBACK_GAS_LIMIT_BUY, FALLBACK_GAS_LIMIT_SELL,
  MAX_BATCH_FUND_NEW_WALLETS, TERMS_TEXT,
} from '../config.js';
import { pending, fundsInFlight, gasMultiplierFor, stopPositionsRefresh } from '../state.js';
import {
  gasEstimateLine, friendlyErrorMessage, parseUsdcAmountInput, parseMcapInput, mcapToPrice, getChainUsdcBalance,
} from '../format.js';
import {
  mainMenu, walletsMenu, batchSelectMenu, batchSellSelectMenu, confirmMenu, renderTokenCard,
} from '../menus.js';
import { executeBuy, executeSell, estimateTransferGasReserve, distributeUsdc } from '../trade-core.js';
import { scheduleCardAutoRefresh } from '../autorefresh.js';

/** True if `text` looks like an EVM address or a Solana mint. */
function isContractAddress(text) {
  return CA_REGEX.test(text) || SOLANA_ADDRESS_REGEX.test(text);
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

    // If the pasted address has no data on the user's currently active
    // chain, auto-detect which supported chain it DOES live on (by
    // liquidity) and switch the user there — this is what makes "just
    // paste a CA" work without making the user pick a chain first.
    const activeChain = getActiveChain(uid);
    const activeMarket = await getTokenMarketData(text, activeChain).catch(() => null);
    if (!activeMarket) {
      const matches = await findTokenAcrossChains(text);
      if (matches.length > 0 && matches[0].chainKey !== activeChain) {
        setActiveChain(uid, matches[0].chainKey);
        await ctx.reply(`ℹ️ No liquidity for that token on ${getChain(activeChain).name} — switched you to *${getChain(matches[0].chainKey).name}*, where it does.`, { parse_mode: 'Markdown' });
      }
    }

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

    if (state.type === 'import_name') {
      pending.set(uid, { type: 'import_key', name: text });
      await ctx.reply('Now send the private key for this wallet (EVM `0x...` key, or a Solana base58 secret key):');
      return;
    }

    if (state.type === 'import_key') {
      const { wallet: w, generatedSide } = importWallet(state.name, text);
      addWallet(uid, w);
      pending.delete(uid);
      const genNote = generatedSide === 'solana'
        ? `\n\n_A new Solana address was generated for this wallet — fund it separately to trade on Solana._`
        : `\n\n_A new EVM address was generated for this wallet — fund it separately to trade on EVM chains._`;
      await ctx.reply(
        `✅ Wallet *${state.name}* imported:\nEVM: \`${w.evmAddress}\`\nSolana: \`${w.solAddress}\`${genNote}`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
      ctx.deleteMessage(ctx.message.message_id).catch(() => {});
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

    if (state.type === 'batch_amount') {
      let amt;
      try {
        amt = parseUsdcAmountInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      pending.set(uid, { type: 'batch_select', tokenAddress: state.tokenAddress, usdcAmount: amt, selected: [] });
      await ctx.reply('Select wallets to buy on:', batchSelectMenu(uid, []));
      return;
    }

    if (state.type === 'batchsell_pct') {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0 || pct > 100) return ctx.reply('Send a valid percentage (1-100), e.g. `50`');

      const chainKey = getActiveChain(uid);
      const user = getUser(uid);
      const candidates = user.wallets.filter((w) => {
        const pos = getPosition(uid, w.id, chainKey, state.tokenAddress);
        return pos && pos.tokenAmount > 0;
      });

      if (candidates.length === 0) {
        pending.delete(uid);
        return ctx.reply('No wallets hold a position in this token on your active chain.', mainMenu());
      }

      pending.set(uid, { type: 'batchsell_select', tokenAddress: state.tokenAddress, pct, candidates, selected: [] });
      await ctx.reply('Select wallets to sell on:', batchSellSelectMenu(candidates, []));
      return;
    }

    if (state.type === 'batchfund_create_count') {
      const count = parseInt(text, 10);
      if (isNaN(count) || count <= 0 || count > MAX_BATCH_FUND_NEW_WALLETS) {
        return ctx.reply(`Send a valid whole number between 1 and ${MAX_BATCH_FUND_NEW_WALLETS}.`);
      }
      pending.set(uid, { type: 'batchfund_new_amount', sourceWalletId: state.sourceWalletId, count });
      await ctx.reply(`Send the USD amount to fund EACH of the ${count} new wallet(s) with, e.g. \`50\`:`, { parse_mode: 'Markdown' });
      return;
    }

    if (state.type === 'batchfund_new_amount') {
      let amt;
      try {
        amt = parseUsdcAmountInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      const source = getWallet(uid, state.sourceWalletId);
      if (!source) { pending.delete(uid); return ctx.reply('Source wallet not found.', walletsMenu(uid)); }
      const chainKey = getActiveChain(uid);

      const sourceUsdcBalance = await getChainUsdcBalance(source, chainKey).catch(() => 0);
      const gasReserve = await estimateTransferGasReserve(chainKey, source, state.count);
      const totalNeeded = amt * state.count + gasReserve;
      if (totalNeeded > sourceUsdcBalance) {
        pending.delete(uid);
        return ctx.reply(
          `❌ Need ~${fmtUsd(totalNeeded)} total (${fmtUsd(amt * state.count)} + ~${fmtUsd(gasReserve)} possible gas top-up) but *${source.name}* only has ${fmtUsd(sourceUsdcBalance)} on ${getChain(chainKey).name}.`,
          { parse_mode: 'Markdown', ...mainMenu() }
        );
      }

      if (fundsInFlight.has(uid)) return ctx.reply('⏳ A batch fund run is already in progress — please wait for it to finish.');
      if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
      fundsInFlight.add(uid);
      pending.delete(uid);

      await ctx.reply(`Creating ${state.count} new wallet(s) and funding each with ${fmtUsd(amt)} on ${getChain(chainKey).name}... this may take a moment.`);

      try {
        const newWallets = [];
        for (let i = 0; i < state.count; i++) {
          const existingCount = getUser(uid).wallets.length;
          const w = createWallet(`Wallet ${existingCount + 1}`);
          addWallet(uid, w);
          newWallets.push(w);
        }

        const results = await distributeUsdc(uid, chainKey, source, newWallets, amt);
        const lines = results.map((r) =>
          r.ok ? `✅ ${r.walletName}: funded (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
        );
        await ctx.reply(`📤 *Batch Fund Results* — ${fmtUsd(amt)} each\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...mainMenu() });
      } catch (err) {
        console.error(err);
        await ctx.reply(`❌ Batch fund failed: ${friendlyErrorMessage(err)}`, mainMenu());
        await sendAdminAlert(ctx.telegram, `Batch fund (new wallets) failed for user ${uid}: ${err.message}`);
      } finally {
        fundsInFlight.delete(uid);
      }
      return;
    }

    if (state.type === 'batchfund_amount') {
      let amt;
      try {
        amt = parseUsdcAmountInput(text);
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      const source = getWallet(uid, state.sourceWalletId);
      if (!source) { pending.delete(uid); return ctx.reply('Source wallet not found.', walletsMenu(uid)); }
      const chainKey = getActiveChain(uid);

      const sourceUsdcBalance = await getChainUsdcBalance(source, chainKey).catch(() => 0);
      const gasReserve = await estimateTransferGasReserve(chainKey, source, state.targets.length);
      const totalNeeded = amt * state.targets.length + gasReserve;
      if (totalNeeded > sourceUsdcBalance) {
        pending.delete(uid);
        return ctx.reply(
          `❌ Need ~${fmtUsd(totalNeeded)} total (${fmtUsd(amt * state.targets.length)} + ~${fmtUsd(gasReserve)} possible gas top-up) but *${source.name}* only has ${fmtUsd(sourceUsdcBalance)} on ${getChain(chainKey).name}.`,
          { parse_mode: 'Markdown', ...mainMenu() }
        );
      }

      if (fundsInFlight.has(uid)) return ctx.reply('⏳ A batch fund run is already in progress — please wait for it to finish.');
      if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
      fundsInFlight.add(uid);
      pending.delete(uid);

      await ctx.reply(`Funding ${state.targets.length} wallet(s) with ${fmtUsd(amt)} each from *${source.name}* on ${getChain(chainKey).name}... this may take a moment.`, { parse_mode: 'Markdown' });

      try {
        const results = await distributeUsdc(uid, chainKey, source, state.targets, amt);
        const lines = results.map((r) =>
          r.ok ? `✅ ${r.walletName}: funded (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
        );
        await ctx.reply(`📤 *Batch Fund Results* — ${fmtUsd(amt)} each\n\n${lines.join('\n')}`, { parse_mode: 'Markdown', ...mainMenu() });
      } catch (err) {
        console.error(err);
        await ctx.reply(`❌ Batch fund failed: ${friendlyErrorMessage(err)}`, mainMenu());
        await sendAdminAlert(ctx.telegram, `Batch fund failed for user ${uid}: ${err.message}`);
      } finally {
        fundsInFlight.delete(uid);
      }
      return;
    }
  } catch (err) {
    console.error(err);
    pending.delete(uid);
    await ctx.reply(`❌ Error: ${friendlyErrorMessage(err)}`, mainMenu());
  }
});
