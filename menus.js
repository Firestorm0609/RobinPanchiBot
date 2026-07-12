import { Markup } from 'telegraf';
import { shortAddr } from './wallet.js';
import { getEthUsdPrice, getTokenMarketData, fmtUsd, getCachedEthUsdPrice, fmtTokenAmount } from './price.js';
import { BRIDGE_DIRECTION } from './bridge.js';
import {
  getUser,
  getSettings,
  getActiveWallet,
  getPosition,
  getActiveAutoRuleForPosition,
} from './storage.js';
import { dualEthBalanceLines, gasEstimateLine } from './format.js';
import { FALLBACK_GAS_LIMIT_BUY } from './config.js';

export function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Trade Token', 'menu_trade')],
    [Markup.button.callback('📊 Positions', 'menu_positions'), Markup.button.callback('📈 Portfolio', 'menu_portfolio')],
    [Markup.button.callback('💼 Wallets', 'menu_wallets'), Markup.button.callback('💰 Balance', 'menu_balance')],
    [Markup.button.callback('🌉 Bridge', 'menu_bridge'), Markup.button.callback('⏰ Limit Orders', 'menu_limitorders')],
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
    [Markup.button.callback('⚠️ Yes, show my key', `wallet_export_confirm_${walletId}`)],
    [Markup.button.callback('❌ Cancel', 'menu_wallets')],
  ]);
}

/**
 * Settings amounts (buy presets, max buy, max bridge) are stored in ETH
 * internally, but displayed as USD (mimics FOMO-style UX). Uses the
 * short-lived cached price since this menu builder is synchronous; falls
 * back to a raw ETH label on the rare case there's no fresh cached price.
 */
function usdOrEthLabel(ethAmount) {
  const ethUsd = getCachedEthUsdPrice();
  return ethUsd ? fmtUsd(ethAmount * ethUsd) : `${ethAmount} ETH`;
}

export function settingsMenu(uid) {
  const s = getSettings(uid);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Buy presets: ${s.buyPresetsEth.map(usdOrEthLabel).join(', ')}`, 'settings_buy')],
    [Markup.button.callback(`Sell presets: ${s.sellPresetsPct.join(', ')}%`, 'settings_sell')],
    [Markup.button.callback(`Slippage: ${(s.slippageBps / 100).toFixed(2)}%`, 'settings_slippage')],
    [Markup.button.callback(`Max buy size: ${usdOrEthLabel(s.maxBuyEth)}`, 'settings_maxbuy')],
    [Markup.button.callback(`Max bridge size: ${usdOrEthLabel(s.maxBridgeEth)}`, 'settings_maxbridge')],
    [Markup.button.callback(`Gas priority: ${s.gasTier} (tap to cycle)`, 'settings_gastier')],
    [Markup.button.callback(`Low balance alert: ${s.lowBalanceThresholdEth} ETH`, 'settings_lowbalance')],
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

export function bridgeMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Ethereum ➜ Robinhood', 'bridge_dir_eth_to_robinhood')],
    [Markup.button.callback('Robinhood ➜ Ethereum', 'bridge_dir_robinhood_to_eth')],
    [
      Markup.button.callback('💯 Bridge All (Eth➜Robin)', 'bridgeall_eth_to_robinhood'),
      Markup.button.callback('💯 Bridge All (Robin➜Eth)', 'bridgeall_robinhood_to_eth'),
    ],
    [Markup.button.callback('🕘 Recent Bridges', 'bridge_history')],
    [Markup.button.callback('⬅️ Back', 'menu_main')],
  ]);
}

export function bridgeConfirmMenu(direction, amount) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', `bridge_confirm_${direction}_${amount}`),
      Markup.button.callback('❌ Cancel', 'menu_bridge'),
    ],
  ]);
}

export function directionLabel(direction) {
  return direction === BRIDGE_DIRECTION.ETH_TO_ROBINHOOD ? 'Ethereum ➜ Robinhood' : 'Robinhood ➜ Ethereum';
}

/**
 * `ethUsd` is passed in (fetched once by the caller, e.g. renderTokenCard)
 * so buy preset buttons can show USD amounts, e.g. "Buy $50", while the
 * underlying preset amount (and the buy_ callback payload) stays in ETH.
 */
export function tokenMenu(uid, tokenAddress, hasPosition, ethUsd) {
  const s = getSettings(uid);
  const user = getUser(uid);
  const buyLabel = (amt) => (ethUsd ? `Buy ${fmtUsd(amt * ethUsd)}` : `Buy ${amt} ETH`);
  const rows = [
    s.buyPresetsEth.map((amt) => Markup.button.callback(buyLabel(amt), `buy_${tokenAddress}_${amt}`)),
    [Markup.button.callback('✏️ Custom Buy (USD or ETH)', `custombuy_${tokenAddress}`)],
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

/** Multi-select wallet picker used by Batch Buy. */
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

/** Multi-select wallet picker used by Batch Sell — only wallets passed in `candidates`. */
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

/** Multi-select wallet picker used by Batch Fund — only wallets passed in `candidates` (source excluded). */
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

/** Multi-select wallet picker used by Batch Collect — sources feeding one chosen destination. */
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

/** "⬅️ Back" plus a "🔄 Refresh" button — used by Positions and Portfolio views. */
export function refreshBackMenu(refreshAction) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', refreshAction), Markup.button.callback('⬅️ Back', 'menu_main')],
  ]);
}

// ---------- Limit orders: list + cancel ----------

/**
 * Renders the user's open limit orders as text + one cancel button per
 * order. `market` is an optional Map<tokenAddress, marketData> the caller
 * can pre-fetch so symbols show up instead of raw addresses — falls back
 * to a shortened address if not supplied or lookup failed for that token.
 */
export function limitOrdersText(orders, marketByToken = new Map()) {
  if (orders.length === 0) {
    return '⏰ *Limit Orders*\n\nNo open limit orders.';
  }
  const lines = orders.map((o) => {
    const market = marketByToken.get(o.token_address);
    const label = market?.symbol ?? shortAddr(o.token_address);
    const mcapLabel = o.target_mcap != null
      ? fmtUsd(o.target_mcap)
      : `$${Number(o.trigger_price).toPrecision(4)} (price)`;
    const amountLabel = o.side === 'buy' ? `${o.amount} ETH` : `${fmtTokenAmount(Number(o.amount))} tokens`;
    const dir = o.side === 'buy' ? '≤' : '≥';
    return `*${label}* — ${o.side.toUpperCase()} ${amountLabel} @ mcap ${dir} ${mcapLabel}`;
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

export async function renderTokenCard(uid, tokenAddress) {
  const w = getActiveWallet(uid);
  if (!w) return { text: 'No active wallet. Add one first.', markup: walletsMenu(uid) };

  const market = await getTokenMarketData(tokenAddress).catch(() => null);
  const ethUsd = await getEthUsdPrice().catch(() => null);

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
    const currentValueUsd = pos.tokenAmount * market.priceUsd;
    const costUsd = ethUsd ? pos.costEth * ethUsd : null;
    if (costUsd !== null) {
      const pnlUsd = currentValueUsd - costUsd;
      const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
      const emoji = pnlUsd >= 0 ? '🟢' : '🔴';
      pnlLine = `\n\n*Your position:*\n${fmtTokenAmount(pos.tokenAmount)} ${market.symbol}\nCost: ${fmtUsd(costUsd)} | Value: ${fmtUsd(currentValueUsd)}\nPnL: ${emoji} ${fmtUsd(pnlUsd)} (${pnlPct.toFixed(1)}%)`;
    }
    if (pos.entryMcap != null) {
      pnlLine += `\nEntry mcap: ${fmtUsd(pos.entryMcap)}`;
      if (market.marketCap != null && pos.entryMcap > 0) {
        const mcapChangePct = ((market.marketCap - pos.entryMcap) / pos.entryMcap) * 100;
        const mcapEmoji = mcapChangePct >= 0 ? '🟢' : '🔴';
        pnlLine += ` → Now: ${fmtUsd(market.marketCap)} (${mcapEmoji} ${mcapChangePct >= 0 ? '+' : ''}${mcapChangePct.toFixed(1)}%)`;
      }
    }
    const rule = getActiveAutoRuleForPosition(uid, w.id, tokenAddress);
    if (rule) {
      const parts = [];
      if (rule.tp_pct != null) parts.push(`TP +${rule.tp_pct}%`);
      if (rule.sl_pct != null) parts.push(`SL -${rule.sl_pct}%`);
      pnlLine += `\n🎯 Active rule: ${parts.join(' / ')}`;
    }
  }

  const changeLine = market.priceChange24h !== null ? ` (${market.priceChange24h >= 0 ? '+' : ''}${market.priceChange24h.toFixed(1)}%)` : '';
  const walletBalance = await dualEthBalanceLines(w.address).catch(() => 'unavailable');
  // Est. network fee for a trade on this token — same estimate shown on the
  // buy/sell confirm screens, surfaced here too so it's visible before the
  // user even taps Buy/Sell.
  const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_BUY).catch(() => '');

  const text =
    `*${market.symbol}*\n\`${tokenAddress}\`\n\n` +
    `Price: $${market.priceUsd.toPrecision(4)}${changeLine}\n` +
    `Market Cap: ${fmtUsd(market.marketCap)}\n` +
    `Liquidity: ${fmtUsd(market.liquidityUsd)}\n` +
    `Your balance:\n${walletBalance}` +
    gasLine +
    pnlLine;

  return { text, markup: tokenMenu(uid, tokenAddress, !!(pos && pos.tokenAmount > 0), ethUsd) };
}

// ---------- Positions list + Portfolio summary rendering ----------
// Pulled out into standalone builders (rather than left inline in bot.js)
// so both the manual "🔄 Refresh" button and the 30s auto-refresh timer can
// call the exact same rendering logic and stay in sync.

export async function renderPositionsView(uid) {
  const w = getActiveWallet(uid);
  if (!w) return { text: 'No active wallet. Add one first.', markup: walletsMenu(uid) };

  const { getAllPositions } = await import('./storage.js');
  const positions = getAllPositions(uid, w.id);
  if (positions.length === 0) {
    return {
      text: '📊 No positions yet. Trade a token to open one.',
      markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
    };
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
      text += `\n*${symbol}*: ${fmtTokenAmount(pos.tokenAmount)} — ${fmtUsd(valueUsd)} (${emoji} ${pnlPct.toFixed(1)}%)`;
      if (pos.entryMcap != null) {
        text += `\n  Entry mcap: ${fmtUsd(pos.entryMcap)}`;
      }
    } else {
      text += `\n*${symbol}*: ${fmtTokenAmount(pos.tokenAmount)} — price unavailable`;
    }
    rows.push([Markup.button.callback(`View ${symbol}`, `refresh_${pos.tokenAddress}`)]);
  }

  rows.push([Markup.button.callback('🔄 Refresh', 'menu_positions_refresh'), Markup.button.callback('⬅️ Back', 'menu_main')]);
  return { text, markup: Markup.inlineKeyboard(rows) };
}

export async function renderPortfolioView(uid) {
  const { getAllPositionsForUser } = await import('./storage.js');
  const positions = getAllPositionsForUser(uid);

  if (positions.length === 0) {
    return {
      text: '📈 No open positions across any wallet yet.',
      markup: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
    };
  }

  const ethUsd = await getEthUsdPrice().catch(() => null);
  const lines = [];
  let totalValueUsd = 0;
  let totalCostUsd = 0;
  let anyPriceUnavailable = false;

  for (const pos of positions) {
    const market = await getTokenMarketData(pos.tokenAddress).catch(() => null);
    const symbol = market?.symbol ?? shortAddr(pos.tokenAddress);
    if (market && ethUsd) {
      const valueUsd = pos.tokenAmount * market.priceUsd;
      const costUsd = pos.costEth * ethUsd;
      totalValueUsd += valueUsd;
      totalCostUsd += costUsd;
      const pnlUsd = valueUsd - costUsd;
      const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
      const emoji = pnlUsd >= 0 ? '🟢' : '🔴';
      let line = `*${symbol}* (${pos.walletName}): ${fmtUsd(valueUsd)} (${emoji} ${pnlPct.toFixed(1)}%)`;
      if (pos.entryMcap != null) line += `\n  Entry mcap: ${fmtUsd(pos.entryMcap)}`;
      lines.push(line);
    } else {
      anyPriceUnavailable = true;
      lines.push(`*${symbol}* (${pos.walletName}): price unavailable`);
    }
  }

  const totalPnlUsd = totalValueUsd - totalCostUsd;
  const totalPnlPct = totalCostUsd > 0 ? (totalPnlUsd / totalCostUsd) * 100 : 0;
  const totalEmoji = totalPnlUsd >= 0 ? '🟢' : '🔴';
  const disclaimer = anyPriceUnavailable ? '\n_Totals exclude positions with unavailable pricing._' : '';

  const text =
    `📈 *Portfolio Summary* — all wallets\n\n` +
    `Total value: ${fmtUsd(totalValueUsd)}\n` +
    `Total cost: ${fmtUsd(totalCostUsd)}\n` +
    `Total PnL: ${totalEmoji} ${fmtUsd(totalPnlUsd)} (${totalPnlPct.toFixed(1)}%)${disclaimer}\n\n` +
    `*Positions:*\n${lines.join('\n')}`;

  return { text, markup: refreshBackMenu('menu_portfolio_refresh') };
}
