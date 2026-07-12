import { Markup } from 'telegraf';
import { shortAddr } from './wallet.js';
import { getTokenMarketData, fmtUsd, fmtTokenAmount } from './price.js';
import { getChain, ALL_CHAIN_KEYS } from './chains.js';
import {
  getUser,
  getSettings,
  getActiveWallet,
  getActiveChain,
  getPosition,
  getActiveAutoRuleForPosition,
  getAllPositionsForUser,
} from './storage.js';
import { chainBalanceLines, allChainsBalanceSummary, gasEstimateLine, getUnifiedUsdBalance } from './format.js';
import { FALLBACK_GAS_LIMIT_BUY } from './config.js';

export function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Trade Token', 'menu_trade')],
    [Markup.button.callback('📊 Positions', 'menu_positions')],
    [Markup.button.callback('💼 Wallets', 'menu_wallets'), Markup.button.callback('💰 Balance', 'menu_balance')],
    [Markup.button.callback('🔗 Chain', 'menu_chain'), Markup.button.callback('⏰ Limit Orders', 'menu_limitorders')],
    [Markup.button.callback('🎟 Rewards', 'menu_rewards'), Markup.button.callback('⚙️ Settings', 'menu_settings')],
    [Markup.button.callback('❓ Help', 'menu_help')],
    [Markup.button.url('🐦 X', 'https://x.com/robinpanchi')],
  ]);
}

export function walletsMenu(uid) {
  const user = getUser(uid);
  const rows = user.wallets.map((w) => {
    const active = w.id === user.activeWalletId ? '✅ ' : '';
    return [Markup.button.callback(`${active}${w.name} (${shortAddr(w.address)})`, `wallet_${w.id}`)];
  });
  rows.push([
    Markup.button.callback('➕ Create New', 'wallet_create'),
    Markup.button.callback('📥 Import', 'wallet_import'),
  ]);
  rows.push([Markup.button.callback('📤 Batch Fund', 'batchfund_start')]);
  rows.push([Markup.button.callback('📥 Batch Collect', 'collect_start')]);
  rows.push([Markup.button.callback('⬅️ Back', 'menu_main')]);
  return Markup.inlineKeyboard(rows);
}

export function walletDetailMenu(walletId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Set Active', `wallet_activate_${walletId}`)],
    [Markup.button.callback('✏️ Rename', `wallet_rename_${walletId}`)],
    [Markup.button.callback('🔑 Export Key', `wallet_export_${walletId}`)],
    [Markup.button.callback('🗑 Remove', `wallet_remove_${walletId}`)],
    [Markup.button.callback('⬅️ Back', 'menu_wallets')],
  ]);
}

export function exportConfirmMenu(walletId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚠️ Yes, show my keys', `wallet_export_confirm_${walletId}`)],
    [Markup.button.callback('❌ Cancel', 'menu_wallets')],
  ]);
}

// ---------- Chain picker ----------
// This is the core of the "trade any chain in USDC, no bridging" feature:
// the user picks an active chain here, and every trade/balance/position
// call downstream reads it via getActiveChain(uid).

export function chainMenu(uid) {
  const active = getActiveChain(uid);
  const rows = ALL_CHAIN_KEYS.map((key) => {
    const chain = getChain(key);
    const check = key === active ? '✅ ' : '';
    return [Markup.button.callback(`${check}${chain.name}`, `chain_select_${key}`)];
  });
  rows.push([Markup.button.callback('⬅️ Back', 'menu_main')]);
  return Markup.inlineKeyboard(rows);
}

export function settingsMenu(uid) {
  const s = getSettings(uid);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Buy presets: ${s.buyPresetsUsdc.map(fmtUsd).join(', ')}`, 'settings_buy')],
    [Markup.button.callback(`Sell presets: ${s.sellPresetsPct.join(', ')}%`, 'settings_sell')],
    [Markup.button.callback(`Slippage: ${(s.slippageBps / 100).toFixed(2)}%`, 'settings_slippage')],
    [Markup.button.callback(`Max buy size: ${fmtUsd(s.maxBuyUsdc)}`, 'settings_maxbuy')],
    [Markup.button.callback(`Gas priority: ${s.gasTier} (tap to cycle)`, 'settings_gastier')],
    [Markup.button.callback(`Low balance alert: ${s.lowBalanceThresholdEth} (native token)`, 'settings_lowbalance')],
    [Markup.button.callback(`Confirm before trade: ${s.confirmTrades ? 'ON ✅' : 'OFF ❌'}`, 'settings_toggle_confirm')],
    [Markup.button.callback(`Flex card PnL: ${s.flexPnlMode.toUpperCase()} (tap to cycle)`, 'settings_flexpnl')],
    [Markup.button.callback('⬅️ Back', 'menu_main')],
  ]);
}

export function rewardsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Get My Referral Link', 'rewards_link')],
    [Markup.button.callback('⬅️ Back', 'menu_main')],
  ]);
}

/**
 * Trades are USDC-denominated directly on whichever chain is active — no
 * price-feed conversion needed. Buy/sell/limit/TP-SL callbacks don't encode
 * the chain; every handler resolves it via getActiveChain(uid) at the
 * moment it executes, same pattern as getActiveWallet(uid).
 */
export function tokenMenu(uid, tokenAddress, hasPosition) {
  const s = getSettings(uid);
  const user = getUser(uid);
  const buyLabel = (amt) => `Buy ${fmtUsd(amt)}`;
  const rows = [
    s.buyPresetsUsdc.map((amt) => Markup.button.callback(buyLabel(amt), `buy_${tokenAddress}_${amt}`)),
    [Markup.button.callback('✏️ Custom Buy (USD)', `custombuy_${tokenAddress}`)],
  ];
  if (hasPosition) {
    rows.push(s.sellPresetsPct.map((pct) => Markup.button.callback(`Sell ${pct}%`, `sell_${tokenAddress}_${pct}`)));
    rows.push([Markup.button.callback('✏️ Custom Sell', `customsell_${tokenAddress}`)]);
    rows.push([
      Markup.button.callback('🎯 Set TP/SL', `tpsl_${tokenAddress}`),
      Markup.button.callback('⏰ Limit Sell', `limitsell_${tokenAddress}`),
    ]);
  }
  const bottomRow = [Markup.button.callback('⏰ Limit Buy', `limitbuy_${tokenAddress}`)];
  if (user.wallets.length > 1) bottomRow.push(Markup.button.callback('📦 Batch Buy', `batchbuy_${tokenAddress}`));
  rows.push(bottomRow);
  if (hasPosition && user.wallets.length > 1) {
    rows.push([Markup.button.callback('📦 Batch Sell', `batchsell_${tokenAddress}`)]);
  }
  rows.push([
    Markup.button.callback('🔄 Refresh', `refresh_${tokenAddress}`),
    Markup.button.callback('⬅️ Back', 'menu_main'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function batchSelectMenu(uid, selected) {
  const user = getUser(uid);
  const rows = user.wallets.map((w) => {
    const checked = selected.includes(w.id) ? '☑️ ' : '⬜ ';
    return [Markup.button.callback(`${checked}${w.name} (${shortAddr(w.address)})`, `batchtoggle_${w.id}`)];
  });
  rows.push([
    Markup.button.callback(`✅ Confirm (${selected.length} selected)`, 'batchconfirm'),
    Markup.button.callback('❌ Cancel', 'menu_main'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function batchSellSelectMenu(candidates, selected) {
  const rows = candidates.map((w) => {
    const checked = selected.includes(w.id) ? '☑️ ' : '⬜ ';
    return [Markup.button.callback(`${checked}${w.name} (${shortAddr(w.address)})`, `bselltoggle_${w.id}`)];
  });
  rows.push([
    Markup.button.callback(`✅ Confirm (${selected.length} selected)`, 'batchsellconfirm'),
    Markup.button.callback('❌ Cancel', 'menu_main'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function batchFundSelectMenu(candidates, selected) {
  const rows = candidates.map((w) => {
    const checked = selected.includes(w.id) ? '☑️ ' : '⬜ ';
    return [Markup.button.callback(`${checked}${w.name} (${shortAddr(w.address)})`, `bfundtoggle_${w.id}`)];
  });
  rows.push([
    Markup.button.callback(`✅ Confirm (${selected.length} selected)`, 'bfundconfirm'),
    Markup.button.callback('❌ Cancel', 'menu_main'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function collectSelectMenu(candidates, selected) {
  const rows = candidates.map((w) => {
    const checked = selected.includes(w.id) ? '☑️ ' : '⬜ ';
    return [Markup.button.callback(`${checked}${w.name} (${shortAddr(w.address)})`, `collecttoggle_${w.id}`)];
  });
  rows.push([
    Markup.button.callback(`✅ Confirm (${selected.length} selected)`, 'collectconfirm'),
    Markup.button.callback('❌ Cancel', 'menu_main'),
  ]);
  return Markup.inlineKeyboard(rows);
}

export function confirmMenu(kind, tokenAddress, value) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', `confirm_${kind}_${tokenAddress}_${value}`),
      Markup.button.callback('❌ Cancel', 'cancel_trade'),
    ],
  ]);
}

export function refreshBackMenu(refreshAction) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', refreshAction), Markup.button.callback('⬅️ Back', 'menu_main')],
  ]);
}

// ---------- Limit orders: list + cancel ----------

export function limitOrdersText(orders, marketByKey = new Map()) {
  if (orders.length === 0) {
    return '⏰ *Limit Orders*\n\nNo open limit orders.';
  }
  const lines = orders.map((o) => {
    const market = marketByKey.get(`${o.chain}:${o.token_address}`);
    const label = market?.symbol ?? shortAddr(o.token_address);
    const chainName = getChain(o.chain).name;
    const mcapLabel = o.target_mcap != null
      ? fmtUsd(o.target_mcap)
      : `$${Number(o.trigger_price).toPrecision(4)} (price)`;
    const amountLabel = o.side === 'buy' ? fmtUsd(o.amount) : `${fmtTokenAmount(Number(o.amount))} tokens`;
    const dir = o.side === 'buy' ? '≤' : '≥';
    return `*${label}* _(${chainName})_ — ${o.side.toUpperCase()} ${amountLabel} @ mcap ${dir} ${mcapLabel}`;
  });
  return `⏰ *Limit Orders*\n\n${lines.join('\n')}`;
}

export function limitOrdersMenu(orders) {
  const rows = orders.map((o) => {
    const market = o._symbol || shortAddr(o.token_address);
    return [Markup.button.callback(`❌ Cancel ${o.side.toUpperCase()} ${market}`, `limitordercancel_${o.id}`)];
  });
  rows.push([Markup.button.callback('⬅️ Back', 'menu_main')]);
  return Markup.inlineKeyboard(rows);
}

// ---------- Token info + PnL rendering ----------
// Always operates on the user's currently active chain (getActiveChain).

export async function renderTokenCard(uid, tokenAddress) {
  const w = getActiveWallet(uid);
  if (!w) return { text: 'No active wallet. Add one first.', markup: walletsMenu(uid) };

  const chainKey = getActiveChain(uid);
  const chain = getChain(chainKey);
  const market = await getTokenMarketData(tokenAddress, chainKey).catch(() => null);

  if (!market) {
    return {
      text: `No market data found on *${chain.name}* for:\n\`${tokenAddress}\`\n\nPool may not exist on this chain yet, or DexScreener hasn't indexed it. Try a different chain under 🔗 Chain.`,
      markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', `refresh_${tokenAddress}`)],
        [Markup.button.callback('🔗 Switch Chain', 'menu_chain')],
        [Markup.button.callback('⬅️ Back', 'menu_main')],
      ]),
    };
  }

  const pos = getPosition(uid, w.id, chainKey, tokenAddress);
  let pnlLine = '';
  if (pos && pos.tokenAmount > 0) {
    const currentValueUsd = pos.tokenAmount * market.priceUsd;
    const costUsd = pos.costUsdc;
    const pnlUsd = currentValueUsd - costUsd;
    const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
    const emoji = pnlUsd >= 0 ? '🟢' : '🔴';
    pnlLine = `\n\n*Your position:*\n${fmtTokenAmount(pos.tokenAmount)} ${market.symbol}\nCost: ${fmtUsd(costUsd)} | Value: ${fmtUsd(currentValueUsd)}\nPnL: ${emoji} ${fmtUsd(pnlUsd)} (${pnlPct.toFixed(1)}%)`;
    if (pos.entryMcap != null) {
      pnlLine += `\nEntry mcap: ${fmtUsd(pos.entryMcap)}`;
      if (market.marketCap != null && pos.entryMcap > 0) {
        const mcapChangePct = ((market.marketCap - pos.entryMcap) / pos.entryMcap) * 100;
        const mcapEmoji = mcapChangePct >= 0 ? '🟢' : '🔴';
        pnlLine += ` → Now: ${fmtUsd(market.marketCap)} (${mcapEmoji} ${mcapChangePct >= 0 ? '+' : ''}${mcapChangePct.toFixed(1)}%)`;
      }
    }
    const rule = getActiveAutoRuleForPosition(uid, w.id, chainKey, tokenAddress);
    if (rule) {
      const parts = [];
      if (rule.tp_pct != null) parts.push(`TP +${rule.tp_pct}%`);
      if (rule.sl_pct != null) parts.push(`SL -${rule.sl_pct}%`);
      pnlLine += `\n🎯 Active rule: ${parts.join(' / ')}`;
    }
  }

  const changeLine = market.priceChange24h !== null ? ` (${market.priceChange24h >= 0 ? '+' : ''}${market.priceChange24h.toFixed(1)}%)` : '';
  const walletBalance = await chainBalanceLines(w, chainKey).catch(() => 'unavailable');
  const gasLine = await gasEstimateLine(chainKey, uid, FALLBACK_GAS_LIMIT_BUY).catch(() => '');

  // Unified total across every chain — best-effort, single extra line so the
  // user can see at a glance whether they have funds sitting on a different
  // chain than the one they're about to trade on (before Phase 4 wires up
  // actually bridging that shortfall automatically). Never blocks the card
  // on failure — falls back to omitting the line entirely.
  const unifiedLine = await getUnifiedUsdBalance(w)
    .then((u) => `\nUnified balance (all chains): ${fmtUsd(u.totalUsd)}${u.anyUnavailable ? ' _(partial)_' : ''}`)
    .catch(() => '');

  const text =
    `*${market.symbol}* _(${chain.name})_\n\`${tokenAddress}\`\n\n` +
    `Price: $${market.priceUsd.toPrecision(4)}${changeLine}\n` +
    `Market Cap: ${fmtUsd(market.marketCap)}\n` +
    `Liquidity: ${fmtUsd(market.liquidityUsd)}\n` +
    `Your balance on ${chain.name}:\n${walletBalance}` +
    gasLine +
    unifiedLine +
    pnlLine;

  return { text, markup: tokenMenu(uid, tokenAddress, !!(pos && pos.tokenAmount > 0)) };
}

// ---------- Positions list rendering ----------
// Covers every open position across ALL wallets AND ALL chains.

export async function renderPositionsView(uid) {
  const positions = getAllPositionsForUser(uid);
  if (positions.length === 0) {
    return {
      text: '📊 No positions yet. Trade a token to open one.',
      markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
    };
  }

  const lines = [];
  let totalValueUsd = 0;
  let totalCostUsd = 0;
  let anyPriceUnavailable = false;

  for (const pos of positions) {
    const market = await getTokenMarketData(pos.tokenAddress, pos.chain).catch(() => null);
    const symbol = market?.symbol ?? shortAddr(pos.tokenAddress);
    const chainName = getChain(pos.chain).name;
    if (market) {
      const valueUsd = pos.tokenAmount * market.priceUsd;
      const costUsd = pos.costUsdc;
      totalValueUsd += valueUsd;
      totalCostUsd += costUsd;
      const pnlUsd = valueUsd - costUsd;
      const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
      const emoji = pnlUsd >= 0 ? '🟢' : '🔴';
      let line = `*${symbol}* (${pos.walletName} — ${chainName}): ${fmtTokenAmount(pos.tokenAmount)} — ${fmtUsd(valueUsd)} (${emoji} ${pnlPct.toFixed(1)}%)`;
      if (pos.entryMcap != null) line += `\n  Entry mcap: ${fmtUsd(pos.entryMcap)}`;
      lines.push(line);
    } else {
      anyPriceUnavailable = true;
      lines.push(`*${symbol}* (${pos.walletName} — ${chainName}): ${fmtTokenAmount(pos.tokenAmount)} — price unavailable`);
    }
  }

  const totalPnlUsd = totalValueUsd - totalCostUsd;
  const totalPnlPct = totalCostUsd > 0 ? (totalPnlUsd / totalCostUsd) * 100 : 0;
  const totalEmoji = totalPnlUsd >= 0 ? '🟢' : '🔴';
  const disclaimer = anyPriceUnavailable ? '\n_Totals exclude positions with unavailable pricing._' : '';

  const text =
    `📊 *Positions* — all wallets, all chains\n\n` +
    `Total value: ${fmtUsd(totalValueUsd)}\n` +
    `Total cost: ${fmtUsd(totalCostUsd)}\n` +
    `Total PnL: ${totalEmoji} ${fmtUsd(totalPnlUsd)} (${totalPnlPct.toFixed(1)}%)${disclaimer}\n\n` +
    lines.join('\n');

  return { text, markup: refreshBackMenu('menu_positions_refresh') };
}
