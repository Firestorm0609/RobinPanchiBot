import { Markup } from 'telegraf';
import { ethers } from 'ethers';
import { bot } from '../bot-instance.js';
import { createWallet, importWallet } from '../wallet.js';
import { getEthUsdPrice, getTokenMarketData, fmtUsd } from '../price.js';
import { getBridgeQuote, estimateBridgeGasEth, BRIDGE_DIRECTION, chainIdsForDirection, ETH_CHAIN_ID } from '../bridge.js';
import { sendAdminAlert } from '../alerts.js';
import { isRateLimited } from '../ratelimit.js';
import {
  getUser,
  addWallet,
  renameWallet,
  getWallet,
  getActiveWallet,
  getPosition,
  getSettings,
  updateSettings,
  hasAgreedTerms,
  createAutoRule,
  cancelAutoRule,
  getActiveAutoRuleForPosition,
  createLimitOrder,
  createMomentumTrigger,
} from '../storage.js';
import {
  provider, ethMainnetProvider, CA_REGEX, FALLBACK_GAS_LIMIT_BUY, FALLBACK_GAS_LIMIT_SELL,
  MAX_BATCH_FUND_NEW_WALLETS, MIN_BRIDGE_ETH, TERMS_TEXT,
} from '../config.js';
import { pending, fundsInFlight, lowBalanceWarned, gasMultiplierFor, stopPositionsRefresh } from '../state.js';
import {
  dualEthBalanceLines, gasEstimateLine, friendlyErrorMessage, parseEthOrUsdInput, parseBridgeAmountInput,
  parseMcapInput, mcapToPrice, fmtAmountLabel,
} from '../format.js';
import {
  mainMenu, walletsMenu, bridgeConfirmMenu, directionLabel, batchSelectMenu, batchSellSelectMenu, confirmMenu,
  renderTokenCard,
} from '../menus.js';
import { executeBuy, executeSell, estimateTransferGasReserve, distributeEth } from '../trade-core.js';
import { scheduleCardAutoRefresh } from '../autorefresh.js';

bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  const text = ctx.message.text.trim();

  // ---- Momentum Trigger: Alpha/Beta CA capture ----
  // These two steps intercept BEFORE the generic CA_REGEX branch below,
  // because that branch unconditionally treats any pasted address as "look
  // up this token's card" — without this bypass, pasting the Alpha or Beta
  // address here would just render a token card instead of advancing the
  // trigger setup.
  if (state?.type === 'momentum_alpha') {
    if (!CA_REGEX.test(text)) {
      return ctx.reply('That doesn\'t look like a valid contract address. Paste the Alpha token\'s 0x... address.');
    }
    const market = await getTokenMarketData(text).catch(() => null);
    if (!market || !market.priceUsd) {
      return ctx.reply('Could not fetch a live price for that token right now — try again in a moment.');
    }
    pending.set(uid, { type: 'momentum_beta', alphaToken: text, baselinePrice: market.priceUsd });
    await ctx.reply(
      `Baseline price locked: $${market.priceUsd.toPrecision(4)}\n\n` +
      'Now paste the *Beta* token contract address — the one that gets auto-bought once Alpha moves:',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (state?.type === 'momentum_beta') {
    if (!CA_REGEX.test(text)) {
      return ctx.reply('That doesn\'t look like a valid contract address. Paste the Beta token\'s 0x... address.');
    }
    if (text.toLowerCase() === state.alphaToken.toLowerCase()) {
      return ctx.reply('Beta token must be different from Alpha. Paste a different address.');
    }
    pending.set(uid, { type: 'momentum_pct', alphaToken: state.alphaToken, baselinePrice: state.baselinePrice, betaToken: text });
    await ctx.reply(
      'Send the trigger percentage — once Alpha is up this much from the baseline price, Beta gets bought. e.g. `20` for +20%:',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (CA_REGEX.test(text)) {
    if (!hasAgreedTerms(uid)) {
      return ctx.reply(TERMS_TEXT, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ I understand, continue', 'agree_terms')]]),
      });
    }
    if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many lookups in the last minute.');
    pending.delete(uid);
    stopPositionsRefresh(uid);
    const { text: cardText, markup } = await renderTokenCard(uid, text);
    const sent = await ctx.reply(cardText, { parse_mode: 'Markdown', ...markup });
    scheduleCardAutoRefresh(uid, text, sent.chat.id, sent.message_id);
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

    if (state.type === 'export_type_confirm') {
      pending.delete(uid);
      if (text !== state.walletName) {
        await ctx.reply('❌ Name didn\'t match — export cancelled.', mainMenu());
        return;
      }
      const w = getWallet(uid, state.walletId);
      if (!w) return ctx.reply('Wallet not found.', walletsMenu(uid));
      await ctx.reply(
        `🔑 *${w.name}* private key:\n\`${w.privateKey}\`\n\n` +
        'Save this somewhere safe, then delete this message. Anyone with this key can drain the wallet.',
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
      const usdAmounts = text.split(',').map((s) => parseFloat(s.trim().replace(/^\$/, ''))).filter((n) => !isNaN(n) && n > 0);
      if (usdAmounts.length === 0) return ctx.reply('Send valid USD numbers, e.g. `10, 50, 200`');
      let ethUsd;
      try {
        ethUsd = await getEthUsdPrice();
      } catch {
        return ctx.reply('Price feed is down right now — try again shortly.');
      }
      const amounts = usdAmounts.map((usd) => Number((usd / ethUsd).toFixed(6)));
      updateSettings(uid, { buyPresetsEth: amounts });
      pending.delete(uid);
      await ctx.reply(`✅ Buy presets updated: ${usdAmounts.map((u) => fmtUsd(u)).join(', ')}`, mainMenu());
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
      let ethUsd;
      try {
        ethUsd = await getEthUsdPrice();
      } catch {
        return ctx.reply('Price feed is down right now — try again shortly.');
      }
      const amt = Number((usd / ethUsd).toFixed(6));
      updateSettings(uid, { maxBuyEth: amt });
      pending.delete(uid);
      await ctx.reply(`✅ Max buy size set to ${fmtUsd(usd)}`, mainMenu());
      return;
    }

    if (state.type === 'settings_maxbridge') {
      const usd = parseFloat(text.replace(/^\$/, ''));
      if (isNaN(usd) || usd <= 0) return ctx.reply('Send a valid positive USD amount, e.g. `500`');
      let ethUsd;
      try {
        ethUsd = await getEthUsdPrice();
      } catch {
        return ctx.reply('Price feed is down right now — try again shortly.');
      }
      const amt = Number((usd / ethUsd).toFixed(6));
      updateSettings(uid, { maxBridgeEth: amt });
      pending.delete(uid);
      await ctx.reply(`✅ Max bridge size set to ${fmtUsd(usd)}`, mainMenu());
      return;
    }

    if (state.type === 'settings_lowbalance') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt < 0) return ctx.reply('Send a valid non-negative ETH amount, e.g. `0.01`, or `0` to disable.');
      updateSettings(uid, { lowBalanceThresholdEth: amt });
      lowBalanceWarned.delete(String(uid));
      pending.delete(uid);
      await ctx.reply(
        amt === 0 ? '✅ Low balance alerts disabled.' : `✅ Low balance alert threshold set to ${amt} ETH`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'custom_buy') {
      let val, usdInput;
      try {
        ({ amountEth: val, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      val = Number(val.toFixed(6));

      const { maxBuyEth } = getSettings(uid);
      if (val > maxBuyEth) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtAmountLabel(val, usdInput)} exceeds your max buy size. Adjust it in Settings if this was intentional.`, mainMenu());
      }

      pending.delete(uid);

      const { confirmTrades } = getSettings(uid);
      const label = fmtAmountLabel(val, usdInput);
      if (confirmTrades) {
        const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_BUY);
        await ctx.reply(`Confirm: buy *${label}*?${gasLine}`, {
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
        const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_SELL);
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
      const pos = getPosition(uid, w.id, state.tokenAddress);
      if (!pos || pos.tokenAmount <= 0) {
        pending.delete(uid);
        return ctx.reply('No open position on this token to set a rule for.', mainMenu());
      }

      pending.delete(uid);

      const existing = getActiveAutoRuleForPosition(uid, w.id, state.tokenAddress);
      if (existing) cancelAutoRule(uid, existing.id);

      createAutoRule({ uid, walletId: w.id, tokenAddress: state.tokenAddress, tpPct, slPct });
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

      const market = await getTokenMarketData(state.tokenAddress).catch(() => null);
      const triggerPrice = mcapToPrice(targetMcap, market);
      if (triggerPrice === null) {
        return ctx.reply('Could not fetch live market data for this token right now — try again in a moment.');
      }

      pending.set(uid, { type: 'limitbuy_amount', tokenAddress: state.tokenAddress, triggerPrice, targetMcap });
      await ctx.reply(
        'Send the amount to spend when triggered — USD like `100`, or ETH like `0.05 eth`:',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.type === 'limitbuy_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));

      const { maxBuyEth } = getSettings(uid);
      if (amt > maxBuyEth) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtAmountLabel(amt, usdInput)} exceeds your max buy size (${maxBuyEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
      }

      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
      pending.delete(uid);
      createLimitOrder({ uid, walletId: w.id, tokenAddress: state.tokenAddress, side: 'buy', triggerPrice: state.triggerPrice, amount: amt, targetMcap: state.targetMcap });
      await ctx.reply(
        `✅ Limit buy queued: ${fmtAmountLabel(amt, usdInput)} when mcap ≤ ${fmtUsd(state.targetMcap)}. I'll DM you when it fills.`,
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
      const pos = getPosition(uid, w.id, state.tokenAddress);
      if (!pos || pos.tokenAmount <= 0) {
        pending.delete(uid);
        return ctx.reply('No open position on this token to sell.', mainMenu());
      }

      const market = await getTokenMarketData(state.tokenAddress).catch(() => null);
      const triggerPrice = mcapToPrice(targetMcap, market);
      if (triggerPrice === null) {
        return ctx.reply('Could not fetch live market data for this token right now — try again in a moment.');
      }

      pending.set(uid, { type: 'limitsell_amount', tokenAddress: state.tokenAddress, triggerPrice, targetMcap, maxAmount: pos.tokenAmount });
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
      createLimitOrder({ uid, walletId: w.id, tokenAddress: state.tokenAddress, side: 'sell', triggerPrice: state.triggerPrice, amount: clamped, targetMcap: state.targetMcap });
      await ctx.reply(
        `✅ Limit sell queued: ${clamped.toFixed(4)} tokens when mcap ≥ ${fmtUsd(state.targetMcap)}. I'll DM you when it fills.`,
        mainMenu()
      );
      return;
    }

    // ---- Momentum Trigger: % then amount, then create ----
    if (state.type === 'momentum_pct') {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0) return ctx.reply('Send a valid positive percentage, e.g. `20`');
      pending.set(uid, { ...state, type: 'momentum_amount', triggerPct: pct });
      await ctx.reply(
        'Send the amount to auto-buy of Beta when triggered — USD like `50`, or ETH like `0.02 eth`:',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.type === 'momentum_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));

      const w = getActiveWallet(uid);
      if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

      pending.delete(uid);
      createMomentumTrigger({
        uid,
        walletId: w.id,
        alphaToken: state.alphaToken,
        betaToken: state.betaToken,
        triggerPct: state.triggerPct,
        baselinePrice: state.baselinePrice,
        buyAmountEth: amt,
      });
      await ctx.reply(
        `✅ Momentum Trigger set on *${w.name}*:\n` +
        `Alpha \`${state.alphaToken}\` +${state.triggerPct}% → auto-buy ${fmtAmountLabel(amt, usdInput)} of Beta \`${state.betaToken}\`\n\n` +
        `I'll DM you when it fires.`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
      return;
    }

    if (state.type === 'batch_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));
      pending.set(uid, { type: 'batch_select', tokenAddress: state.tokenAddress, ethAmount: amt, usdInput, selected: [] });
      await ctx.reply('Select wallets to buy on:', batchSelectMenu(uid, []));
      return;
    }

    if (state.type === 'batchsell_pct') {
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0 || pct > 100) return ctx.reply('Send a valid percentage (1-100), e.g. `50`');

      const user = getUser(uid);
      const candidates = user.wallets.filter((w) => {
        const pos = getPosition(uid, w.id, state.tokenAddress);
        return pos && pos.tokenAmount > 0;
      });

      if (candidates.length === 0) {
        pending.delete(uid);
        return ctx.reply('No wallets hold a position in this token.', mainMenu());
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
      await ctx.reply(
        `Send the amount to fund EACH of the ${count} new wallet(s) with — USD like \`50\`, or ETH like \`0.02 eth\`:`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (state.type === 'batchfund_new_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));

      const source = getWallet(uid, state.sourceWalletId);
      if (!source) { pending.delete(uid); return ctx.reply('Source wallet not found.', walletsMenu(uid)); }

      const sourceBalance = await provider.getBalance(source.address).then((b) => Number(ethers.formatEther(b))).catch(() => 0);
      const gasReserve = await estimateTransferGasReserve(uid, state.count);
      const totalNeeded = amt * state.count + gasReserve;
      if (totalNeeded > sourceBalance) {
        pending.delete(uid);
        return ctx.reply(
          `❌ Need ~${totalNeeded.toFixed(6)} ETH total (${(amt * state.count).toFixed(6)} + ~${gasReserve.toFixed(6)} est. gas) but *${source.name}* only has ${sourceBalance.toFixed(6)} ETH.`,
          { parse_mode: 'Markdown', ...mainMenu() }
        );
      }

      if (fundsInFlight.has(uid)) return ctx.reply('⏳ A batch fund run is already in progress — please wait for it to finish.');
      if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
      fundsInFlight.add(uid);
      pending.delete(uid);

      const label = fmtAmountLabel(amt, usdInput);
      await ctx.reply(`Creating ${state.count} new wallet(s) and funding each with ${label}... this may take a moment.`);

      try {
        const newWallets = [];
        for (let i = 0; i < state.count; i++) {
          const existingCount = getUser(uid).wallets.length;
          const w = createWallet(`Wallet ${existingCount + 1}`);
          addWallet(uid, w);
          newWallets.push(w);
        }

        const results = await distributeEth(uid, source, newWallets, amt);
        const lines = results.map((r) =>
          r.ok ? `✅ ${r.walletName}: funded (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
        );
        await ctx.reply(`📤 *Batch Fund Results* — ${label} each\n\n${lines.join('\n')}`, {
          parse_mode: 'Markdown',
          ...mainMenu(),
        });
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
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }
      amt = Number(amt.toFixed(6));

      const source = getWallet(uid, state.sourceWalletId);
      if (!source) { pending.delete(uid); return ctx.reply('Source wallet not found.', walletsMenu(uid)); }

      const sourceBalance = await provider.getBalance(source.address).then((b) => Number(ethers.formatEther(b))).catch(() => 0);
      const gasReserve = await estimateTransferGasReserve(uid, state.targets.length);
      const totalNeeded = amt * state.targets.length + gasReserve;
      if (totalNeeded > sourceBalance) {
        pending.delete(uid);
        return ctx.reply(
          `❌ Need ~${totalNeeded.toFixed(6)} ETH total (${(amt * state.targets.length).toFixed(6)} + ~${gasReserve.toFixed(6)} est. gas) but *${source.name}* only has ${sourceBalance.toFixed(6)} ETH.`,
          { parse_mode: 'Markdown', ...mainMenu() }
        );
      }

      if (fundsInFlight.has(uid)) return ctx.reply('⏳ A batch fund run is already in progress — please wait for it to finish.');
      if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
      fundsInFlight.add(uid);
      pending.delete(uid);

      const label = fmtAmountLabel(amt, usdInput);
      await ctx.reply(`Funding ${state.targets.length} wallet(s) with ${label} each from *${source.name}*... this may take a moment.`, { parse_mode: 'Markdown' });

      try {
        const results = await distributeEth(uid, source, state.targets, amt);
        const lines = results.map((r) =>
          r.ok ? `✅ ${r.walletName}: funded (tx \`${r.txHash.slice(0, 12)}...\`)` : `❌ ${r.walletName}: ${r.error}`
        );
        await ctx.reply(`📤 *Batch Fund Results* — ${label} each\n\n${lines.join('\n')}`, {
          parse_mode: 'Markdown',
          ...mainMenu(),
        });
      } catch (err) {
        console.error(err);
        await ctx.reply(`❌ Batch fund failed: ${friendlyErrorMessage(err)}`, mainMenu());
        await sendAdminAlert(ctx.telegram, `Batch fund failed for user ${uid}: ${err.message}`);
      } finally {
        fundsInFlight.delete(uid);
      }
      return;
    }

    if (state.type === 'bridge_amount') {
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseBridgeAmountInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      amt = Number(amt.toFixed(6));

      if (amt < MIN_BRIDGE_ETH) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtAmountLabel(amt, usdInput)} is below the minimum bridgeable amount (${MIN_BRIDGE_ETH} ETH). Bridges below that typically have no valid route since fees exceed the amount.`, mainMenu());
      }

      const { maxBridgeEth } = getSettings(uid);
      if (amt > maxBridgeEth) {
        pending.delete(uid);
        return ctx.reply(`❌ ${fmtAmountLabel(amt, usdInput)} exceeds your max bridge size. Adjust it in Settings if this was intentional.`, mainMenu());
      }

      pending.delete(uid);

      let quote;
      try {
        const w = getActiveWallet(uid);
        if (!w) return ctx.reply('No active wallet. Add one first.', walletsMenu(uid));
        quote = await getBridgeQuote({ direction: state.direction, amountEth: amt, fromAddress: w.address });
      } catch (err) {
        return ctx.reply(`❌ Couldn't get a bridge quote: ${friendlyErrorMessage(err)}`, mainMenu());
      }

      const sendLine = `Send: ${fmtAmountLabel(amt, usdInput)}`;

      const { fromChain } = chainIdsForDirection(state.direction);
      const sourceProviderForEstimate = fromChain === ETH_CHAIN_ID ? ethMainnetProvider : provider;
      const gasEth = await estimateBridgeGasEth(sourceProviderForEstimate, quote, gasMultiplierFor(uid)).catch(() => null);
      const ethUsdForGas = await getEthUsdPrice().catch(() => null);
      const gasLine = gasEth !== null
        ? `\nEst. gas: ~${gasEth.toFixed(5)} ETH${ethUsdForGas !== null ? ` (${fmtUsd(gasEth * ethUsdForGas)})` : ''}`
        : '';

      await ctx.reply(
        `🌉 *${directionLabel(state.direction)}*\n\n` +
        `${sendLine}\n` +
        `Receive (est.): ${Number(quote.toAmountFormatted).toFixed(4)} ETH\n` +
        `Fees (est.): ${fmtUsd(quote.feesUsd)}${gasLine}\n` +
        `Via: ${quote.tool || 'best available route'}\n` +
        `ETA: ~${quote.estimatedDurationSeconds ? Math.ceil(quote.estimatedDurationSeconds / 60) + ' min' : 'a few minutes'}\n\n` +
        `Confirm?`,
        { parse_mode: 'Markdown', ...bridgeConfirmMenu(state.direction === BRIDGE_DIRECTION.ETH_TO_ROBINHOOD ? 'eth_to_robinhood' : 'robinhood_to_eth', amt) }
      );
      return;
    }
  } catch (err) {
    console.error(err);
    pending.delete(uid);
    await ctx.reply(`❌ Error: ${friendlyErrorMessage(err)}`, mainMenu());
  }
});
