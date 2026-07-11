import { Markup } from 'telegraf';
import { shortAddr } from './wallet.js';
import { getEthUsdPrice, getTokenMarketData, fmtUsd } from './price.js';
import { BRIDGE_DIRECTION } from './bridge.js';
import {
  getUser,
  getSettings,
  getActiveWallet,
  getPosition,
  getActiveAutoRuleForPosition,
} from './storage.js';
import { dualEthBalanceLines } from './format.js';

export function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Trade Token', 'menu_trade')],
    [Markup.button.callback('📊 Positions', 'menu_positions'), Markup.button.callback('📈 Portfolio', 'menu_portfolio')],
    [Markup.button.callback('💼 Wallets', 'menu_wallets'), Markup.button.callback('💰 Balance', 'menu_balance')],
    [Markup.button.callback('🌉 Bridge', 'menu_bridge'), Markup.button.callback('🎟 Rewards', 'menu_rewards')],
    [Markup.button.callback('❓ Help', 'menu_help'), Markup.button.callback('⚙️ Settings', 'menu_settings')],
    [Markup.button.url('🐦 X', 'https://x.com/robinpanchi'), Markup.button.url('🖼 OpenSea', 'https://opensea.io/collection/robinpanchi')],
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

export function settingsMenu(uid) {
  const s = getSettings(uid);
  return Markup.inlineKeyboard([
    [Markup.button.callback(`Buy presets: ${s.buyPresetsEth.join(', ')} ETH`, 'settings_buy')],
    [Markup.button.callback(`Sell presets: ${s.sellPresetsPct.join(', ')}%`, 'settings_sell')],
    [Markup.button.callback(`Slippage: ${(s.slippageBps / 100).toFixed(2)}%`, 'settings_slippage')],
    [Markup.button.callback(`Max buy size: ${s.maxBuyEth} ETH`, 'settings_maxbuy')],
    [Markup.button.callback(`Max bridge size: ${s.maxBridgeEth} ETH`, 'settings_maxbridge')],
    [Markup.button.callback(`Gas priority: ${s.gasTier} (tap to cycle)`, 'settings_gastier')],
    [Markup.button.callback(`Low balance alert: ${s.lowBalanceThresholdEth} ETH`, 'settings_lowbalance')],
    [Markup.button.callback(`Confirm before trade: ${s.confirmTrades ? 'ON ✅' : 'OFF ❌'}`, 'settings_toggle_confirm')],
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

export function tokenMenu(uid, tokenAddress, hasPosition) {
  const s = getSettings(uid);
  const user = getUser(uid);
  const rows = [
    s.buyPresetsEth.map((amt) => Markup.button.callback(`Buy ${amt} ETH`, `buy_${tokenAddress}_${amt}`)),
    [Markup.button.callback('✏️ Custom Buy (ETH or $)', `custombuy_${tokenAddress}`)],
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

// ---------- Token info + PnL rendering ----------

export async function renderTokenCard(uid, tokenAddress) {
  const w = getActiveWallet(uid);
  if (!w) return { text: 'No active wallet. Add one first.', markup: walletsMenu(uid) };

  const market = await getTokenMarketData(tokenAddress).catch(() => null);
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
    const ethUsd = await getEthUsdPrice().catch(() => null);
    const currentValueUsd = pos.tokenAmount * market.priceUsd;
    const costUsd = ethUsd ? pos.costEth * ethUsd : null;
    if (costUsd !== null) {
      const pnlUsd = currentValueUsd - costUsd;
      const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
      const emoji = pnlUsd >= 0 ? '🟢' : '🔴';
      pnlLine = `\n\n*Your position:*\n${pos.tokenAmount.toFixed(4)} ${market.symbol}\nCost: ${fmtUsd(costUsd)} | Value: ${fmtUsd(currentValueUsd)}\nPnL: ${emoji} ${fmtUsd(pnlUsd)} (${pnlPct.toFixed(1)}%)`;
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

  const text =
    `*${market.symbol}*\n\`${tokenAddress}\`\n\n` +
    `Price: $${market.priceUsd.toPrecision(4)}${changeLine}\n` +
    `Market Cap: ${fmtUsd(market.marketCap)}\n` +
    `Liquidity: ${fmtUsd(market.liquidityUsd)}\n` +
    `Your balance:\n${walletBalance}` +
    pnlLine;

  return { text, markup: tokenMenu(uid, tokenAddress, !!(pos && pos.tokenAmount > 0)) };
}
