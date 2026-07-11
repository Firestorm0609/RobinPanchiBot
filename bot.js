import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { ethers } from 'ethers';
import { getQuote, buildSwapTx, sendSwapWithGasBump } from './swap.js';
import { ensureAllowance, getDecimals } from './erc20.js';
import { createWallet, importWallet, shortAddr } from './wallet.js';
import { getEthUsdPrice, getTokenMarketData, fmtUsd } from './price.js';
import {
  getBridgeQuote,
  sendBridgeTx,
  checkBridgeStatusOnce,
  estimateBridgeGasEth,
  BRIDGE_DIRECTION,
  chainIdsForDirection,
  ETH_CHAIN_ID,
} from './bridge.js';
import { sendAdminAlert } from './alerts.js';
import { isRateLimited } from './ratelimit.js';
import {
  getUser,
  addWallet,
  removeWallet,
  renameWallet,
  setActiveWallet,
  getActiveWallet,
  getWallet,
  getAllActiveWallets,
  recordTrade,
  getPosition,
  getAllPositions,
  getAllPositionsForUser,
  getSettings,
  updateSettings,
  createPendingTrade,
  markPendingTradeSubmitted,
  markPendingTradeDone,
  getStuckPendingTrades,
  getStats,
  hasAgreedTerms,
  setAgreedTerms,
  getOrCreateReferralCode,
  findUidByReferralCode,
  recordReferral,
  getTicketCount,
  hasBeenReferred,
  createPendingBridge,
  markPendingBridgeSubmitted,
  markPendingBridgeDone,
  getInFlightBridges,
  getBridgeHistory,
} from './storage.js';

// ---------- Startup env validation ----------
// Fail fast and loudly instead of silently falling back to defaults that are
// unsafe in production (e.g. a public RPC endpoint) or that quietly break a
// feature (e.g. missing tx explorer links).
const REQUIRED_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'RPC_URL',
  'CHAIN_ID',
  'ZEROX_API_KEY',
  'AFFILIATE_ADDRESS',
  'AFFILIATE_FEE_BPS',
  'MASTER_KEY',
];
// Required specifically for the bridge feature to be safe/complete in production.
// Bridging still works without these (via fallback), but ETH_RPC_URL's fallback
// (a public endpoint) is not reliable enough for real trading volume, and
// without EXPLORER_BASE_URL users get no tx link for Robinhood-side transactions.
const REQUIRED_FOR_BRIDGE = ['ETH_RPC_URL', 'EXPLORER_BASE_URL'];

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }
  const missingBridge = REQUIRED_FOR_BRIDGE.filter((k) => !process.env[k]);
  if (missingBridge.length > 0) {
    console.warn(
      `⚠️  Missing bridge-related env var(s): ${missingBridge.join(', ')}. ` +
      `Bridging will still run but ETH_RPC_URL falls back to a public endpoint ` +
      `(unreliable at volume) and/or Robinhood-side tx links will be omitted. ` +
      `See .env.example.`
    );
  }
}
validateEnv();

const TERMS_TEXT =
  '⚠️ *Before you trade*\n\n' +
  'This bot lets you swap tokens — including low-cap memecoins — directly with your own funds. ' +
  'By using it you accept that:\n\n' +
  '• Memecoins carry high rug-pull and total-loss risk\n' +
  '• Trades are final once confirmed on-chain\n' +
  '• You are solely responsible for funds in wallets you create or import here\n' +
  '• This is not financial advice, and there are no guarantees of any kind\n\n' +
  'Tap below to confirm you understand and wish to continue.';

const HELP_TEXT =
  '❓ *Help & FAQ*\n\n' +
  '*How do I use this bot?*\n' +
  'Create or import a wallet under 💼 Wallets, fund it with ETH, then paste any token contract address to pull up its price and trade it.\n\n' +
  '*Where\'s my referral link?*\n' +
  'Open 🎟 Rewards from the main menu.\n\n' +
  '*What are the fees?*\n' +
  `A ${(Number(process.env.AFFILIATE_FEE_BPS || 0) / 100).toFixed(2)}% fee applies on swaps, taken from the trade itself. No subscription, no feature is paywalled.\n\n` +
  '*Security tips*\n' +
  '• This bot never DMs you first — if you receive an unsolicited message claiming to be us, it\'s a scammer\n' +
  '• We will never ask you to "verify" your wallet by sending funds or signing a message elsewhere\n' +
  '• Only use the official bot link — search results and copycat bots are common\n' +
  '• Anyone who private-messages you offering "support" and asks for your private key or seed phrase is trying to steal your funds\n\n' +
  '*Common trade failures*\n' +
  '• *Slippage exceeded* — raise your slippage tolerance in Settings, or trade a smaller size\n' +
  '• *Insufficient balance* — you need enough ETH to cover both the trade and gas; add funds or reduce the amount\n' +
  '• *Timed out* — the network was congested; the bot automatically resubmits with higher gas, but if it still fails, try again in a moment\n\n' +
  '*Why does my PnL look off?*\n' +
  'PnL is based on your running average cost basis and the live price, so it can shift with volatility between refreshes. Gas costs are not factored into the displayed cost basis — check the transaction on your block explorer for the exact net amount.\n\n' +
  '*Bridging ETH*\n' +
  'Use 🌉 Bridge to move ETH between Ethereum mainnet and Robinhood Chain. You can enter either an ETH amount (e.g. `0.05`) or a USD amount (e.g. `$100`) — we\'ll convert it for you. Bridges can take a few minutes to settle on the destination side — the bot will DM you once it lands.\n\n' +
  '*Gas priority*\n' +
  'Settings lets you pick slow/normal/fast gas priority, which scales the fee offered on every trade and bridge. Faster = more likely to land quickly during congestion, at a higher cost.\n\n' +
  '*Portfolio summary*\n' +
  'Use 📈 Portfolio from the main menu for a combined PnL view across every wallet you own, not just the active one.\n\n' +
  '*Low balance alerts*\n' +
  'The bot will DM you once if your active wallet\'s ETH balance drops below the threshold set in Settings (default 0.01 ETH). Set it to 0 to disable.\n\n' +
  '*Still stuck?*\n' +
  'Contact support: panchi.eth@gmail.com';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, Number(process.env.CHAIN_ID));

// USDG (Paxos-issued stablecoin) — the canonical stablecoin on Robinhood Chain,
// per official docs: https://docs.robinhood.com/chain/contracts
// Not the same as USDC/USDT — those have no contract on Robinhood Chain.
const USDG_ROBINHOOD_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ERC20_BALANCE_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// Hoisted once at startup (was previously re-created on every single bridge
// call inside executeBridge, opening a fresh RPC connection per trade).
// Used whenever the bridge's source chain is Ethereum mainnet, since RPC_URL
// above points at Robinhood Chain.
const ethMainnetProvider = new ethers.JsonRpcProvider(
  process.env.ETH_RPC_URL || 'https://cloudflare-eth.com',
  ETH_CHAIN_ID
);

let BOT_USERNAME = null;
bot.telegram.getMe()
  .then((me) => { BOT_USERNAME = me.username; })
  .catch((err) => console.error('Failed to fetch bot username:', err.message));

const pending = new Map(); // uid -> { type, ...context }
const tradesInFlight = new Set(); // uid -> locked while a trade is executing (double-tap guard)
const bridgesInFlight = new Set(); // uid -> locked while a bridge tx is being submitted
const CA_REGEX = /^0x[a-fA-F0-9]{40}$/;
const QUOTE_STALE_MS = 15_000; // re-quote if this much time passes before sending the tx
const BRIDGE_POLL_INTERVAL_MS = 30_000;
const LOW_BALANCE_POLL_INTERVAL_MS = 5 * 60_000; // check every 5 min

// ---------- Gas priority tiers ----------
// Multiplies the network's suggested maxFeePerGas/maxPriorityFeePerGas before
// the tx is sent. Applied in swap.js/bridge.js via the gasMultiplier option,
// and mirrored here (fallback-gas-limit based) for pre-confirm estimates.
const GAS_TIERS = ['slow', 'normal', 'fast'];
const GAS_TIER_MULTIPLIERS = { slow: 0.85, normal: 1, fast: 1.35 };
const FALLBACK_GAS_LIMIT_BUY = 300_000n;
const FALLBACK_GAS_LIMIT_SELL = 280_000n;

function gasMultiplierFor(uid) {
  const { gasTier } = getSettings(uid);
  return GAS_TIER_MULTIPLIERS[gasTier] ?? 1;
}

// ---------- Low-balance alert state ----------
// In-memory "already warned" set, same pattern as ratelimit.js — resets on
// restart, which is fine since this is a convenience nudge, not a security
// boundary. Keyed by uid so a user is only DMed once per dip below threshold,
// and can be re-warned after balance recovers and drops again.
const lowBalanceWarned = new Set();

// ---------- Formatting ----------

function fmtEth(n) {
  return Number(n).toFixed(4);
}

function explorerTxUrl(hash) {
  const base = (process.env.EXPLORER_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/tx/${hash}` : null;
}

// Mainnet ETH txs need etherscan; Robinhood Chain txs use the configured explorer.
function explorerTxUrlForChain(hash, chainId) {
  if (chainId === ETH_CHAIN_ID) return `https://etherscan.io/tx/${hash}`;
  return explorerTxUrl(hash);
}

function referralLink(code) {
  return `https://t.me/${BOT_USERNAME || 'your_bot'}?start=ref_${code}`;
}

async function balanceLines(address) {
  const bal = await provider.getBalance(address);
  const ethAmount = Number(ethers.formatEther(bal));
  let usdLine = '';
  try {
    const ethUsd = await getEthUsdPrice();
    usdLine = ` (${fmtUsd(ethAmount * ethUsd)})`;
  } catch {
    // price feed hiccup, still show ETH
  }
  return `${fmtEth(ethAmount)} ETH${usdLine}`;
}

/**
 * Fetches balances relevant to bridging, for display when the user opens the
 * Bridge menu: ETH on both Ethereum mainnet and Robinhood Chain, plus USDG
 * on Robinhood Chain (its canonical stablecoin — see USDG_ROBINHOOD_ADDRESS).
 * Each fetch is independently caught so one RPC hiccup doesn't blank the rest.
 */
async function getBridgeBalances(address) {
  const [ethMainnet, ethRobinhood, usdgRobinhood] = await Promise.all([
    ethMainnetProvider.getBalance(address).then((b) => Number(ethers.formatEther(b))).catch(() => null),
    provider.getBalance(address).then((b) => Number(ethers.formatEther(b))).catch(() => null),
    (async () => {
      const token = new ethers.Contract(USDG_ROBINHOOD_ADDRESS, ERC20_BALANCE_ABI, provider);
      const [raw, decimals] = await Promise.all([token.balanceOf(address), token.decimals()]);
      return Number(ethers.formatUnits(raw, decimals));
    })().catch(() => null),
  ]);
  return { ethMainnet, ethRobinhood, usdgRobinhood };
}

function fmtBridgeBalanceLine(label, amount, ethUsd) {
  if (amount === null) return `${label}: unavailable`;
  const usdLine = ethUsd !== null ? ` (${fmtUsd(amount * ethUsd)})` : '';
  return `${label}: ${amount.toFixed(4)}${usdLine}`;
}

/**
 * Rough pre-confirm gas estimate for buy/sell, shown on the confirm screen
 * before the user commits. Uses a fixed fallback gas limit (not a real 0x
 * quote) so this is cheap — no extra API round-trip — at the cost of some
 * precision. The user's configured gas priority tier (Settings) is applied
 * so the number shown roughly matches what sendSwapWithGasBump will pay.
 */
async function gasEstimateLine(uid, fallbackGasLimit) {
  try {
    const mult = gasMultiplierFor(uid);
    const feeData = await provider.getFeeData();
    const baseFee = feeData.maxFeePerGas ?? ethers.parseUnits('30', 'gwei');
    const maxFee = (baseFee * BigInt(Math.round(mult * 1000))) / 1000n;
    const gasEth = Number(ethers.formatEther(fallbackGasLimit * maxFee));
    const ethUsd = await getEthUsdPrice().catch(() => null);
    return `\nEst. gas: ~${gasEth.toFixed(5)} ETH${ethUsd !== null ? ` (${fmtUsd(gasEth * ethUsd)})` : ''}`;
  } catch {
    return ''; // fee data unavailable — skip the line rather than block the confirm screen
  }
}

/**
 * Translates a raw ethers/RPC/LI.FI error into a short, user-facing message.
 * Raw errors (especially from ethers v6) can be enormous JSON blobs — this
 * keeps DMs clean instead of dumping that at the user.
 */
function friendlyErrorMessage(err) {
  const code = err?.code;
  const raw = `${err?.message || ''} ${err?.shortMessage || ''} ${err?.reason || ''}`.toLowerCase();

  if (code === 'INSUFFICIENT_FUNDS' || raw.includes('insufficient funds')) {
    return 'Insufficient balance to cover this trade plus gas. Add more ETH to your wallet and try again.';
  }
  if (raw.includes('gas required exceeds allowance') || raw.includes('out of gas') || raw.includes('intrinsic gas too low')) {
    return 'Not enough ETH to cover network gas fees. Add a bit more ETH and try again.';
  }
  if (code === 'ACTION_REJECTED' || raw.includes('user rejected')) {
    return 'Transaction was rejected.';
  }
  if (code === 'TIMEOUT' || raw.includes('timeout')) {
    return 'The network was too slow to confirm this in time. It may still land — check 🕘 Recent Bridges or your position, or try again in a moment.';
  }
  if (raw.includes('slippage') || raw.includes('price impact')) {
    return 'Price moved too much before this could confirm (slippage). Try again, or raise your slippage tolerance in Settings.';
  }
  if (raw.includes('nonce')) {
    return 'A transaction is already pending for this wallet. Wait a moment and try again.';
  }
  if (code === 'CALL_EXCEPTION' || raw.includes('execution reverted')) {
    return 'The transaction was rejected by the network. This can happen with low-liquidity tokens or expired quotes — try again.';
  }
  // Fallback: keep it short even for unrecognized errors, no raw payloads.
  const short = (err?.shortMessage || err?.message || 'Unknown error').slice(0, 140);
  return short;
}

/** Re-fetches the quote if too much time has passed since it was first obtained. */
async function getFreshQuote(quoteParams, quote, fetchedAt) {
  if (Date.now() - fetchedAt < QUOTE_STALE_MS) return quote;
  return getQuote(quoteParams);
}

/**
 * Parses a user-entered amount, accepting either a plain ETH figure
 * (e.g. "0.05") or a USD figure prefixed with "$" (e.g. "$100"). Returns
 * { amountEth, usdInput } or throws with a user-facing message on bad input.
 * usdInput is the raw USD number if the user entered USD, otherwise null —
 * useful for showing "≈ $100 worth" back to the user for confirmation.
 * Shared by bridge amount entry and custom buy amount entry.
 */
async function parseEthOrUsdInput(text) {
  const trimmed = text.trim();
  const isUsd = trimmed.startsWith('$');

  if (isUsd) {
    const usd = parseFloat(trimmed.slice(1).replace(/,/g, ''));
    if (isNaN(usd) || usd <= 0) {
      throw new Error('Send a valid positive USD amount, e.g. `$100`');
    }
    let ethUsd;
    try {
      ethUsd = await getEthUsdPrice();
    } catch {
      throw new Error('Price feed is down right now — send an ETH amount instead, e.g. `0.05`');
    }
    return { amountEth: usd / ethUsd, usdInput: usd };
  }

  const amt = parseFloat(trimmed);
  if (isNaN(amt) || amt <= 0) {
    throw new Error('Send a valid positive ETH amount (e.g. `0.05`) or USD amount (e.g. `$100`)');
  }
  return { amountEth: amt, usdInput: null };
}

// Kept as an alias for the bridge flow's original name, same function.
const parseBridgeAmountInput = parseEthOrUsdInput;

// ---------- Menus ----------

const WELCOME_TEXT =
  '🌴 *RobinPanchi Trading Bot*\n' +
  'The first NFT trading bot on Robinhood 🍃\n\n' +
  'Paste a token contract address to trade it.\n\n' +
  '_Support: panchi.eth@gmail.com_';

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Trade Token', 'menu_trade')],
    [Markup.button.callback('📊 Positions', 'menu_positions'), Markup.button.callback('📈 Portfolio', 'menu_portfolio')],
    [Markup.button.callback('💼 Wallets', 'menu_wallets'), Markup.button.callback('💰 Balance', 'menu_balance')],
    [Markup.button.callback('🌉 Bridge', 'menu_bridge'), Markup.button.callback('🎟 Rewards', 'menu_rewards')],
    [Markup.button.callback('❓ Help', 'menu_help'), Markup.button.callback('⚙️ Settings', 'menu_settings')],
    [Markup.button.url('🐦 X', 'https://x.com/robinpanchi'), Markup.button.url('🖼 OpenSea', 'https://opensea.io/collection/robinpanchi')],
  ]);
}

function walletsMenu(uid) {
  const user = getUser(uid);
  const rows = user.wallets.map((w) => {
    const active = w.id === user.activeWalletId ? '✅ ' : '';
    return [Markup.button.callback(`${active}${w.name} (${shortAddr(w.address)})`, `wallet_${w.id}`)];
  });
  rows.push([
    Markup.button.callback('➕ Create New', 'wallet_create'),
    Markup.button.callback('📥 Import', 'wallet_import'),
  ]);
  rows.push([Markup.button.callback('⬅️ Back', 'menu_main')]);
  return Markup.inlineKeyboard(rows);
}

function walletDetailMenu(walletId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Set Active', `wallet_activate_${walletId}`)],
    [Markup.button.callback('✏️ Rename', `wallet_rename_${walletId}`)],
    [Markup.button.callback('🔑 Export Key', `wallet_export_${walletId}`)],
    [Markup.button.callback('🗑 Remove', `wallet_remove_${walletId}`)],
    [Markup.button.callback('⬅️ Back', 'menu_wallets')],
  ]);
}

function exportConfirmMenu(walletId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚠️ Yes, show my key', `wallet_export_confirm_${walletId}`)],
    [Markup.button.callback('❌ Cancel', 'menu_wallets')],
  ]);
}

function settingsMenu(uid) {
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

function rewardsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Get My Referral Link', 'rewards_link')],
    [Markup.button.callback('⬅️ Back', 'menu_main')],
  ]);
}

function bridgeMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Ethereum ➜ Robinhood', 'bridge_dir_eth_to_robinhood')],
    [Markup.button.callback('Robinhood ➜ Ethereum', 'bridge_dir_robinhood_to_eth')],
    [Markup.button.callback('🕘 Recent Bridges', 'bridge_history')],
    [Markup.button.callback('⬅️ Back', 'menu_main')],
  ]);
}

function bridgeConfirmMenu(direction, amount) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', `bridge_confirm_${direction}_${amount}`),
      Markup.button.callback('❌ Cancel', 'menu_bridge'),
    ],
  ]);
}

function directionLabel(direction) {
  return direction === BRIDGE_DIRECTION.ETH_TO_ROBINHOOD ? 'Ethereum ➜ Robinhood' : 'Robinhood ➜ Ethereum';
}

function tokenMenu(uid, tokenAddress, hasPosition) {
  const s = getSettings(uid);
  const rows = [
    s.buyPresetsEth.map((amt) => Markup.button.callback(`Buy ${amt} ETH`, `buy_${tokenAddress}_${amt}`)),
    // Label clarifies ETH-or-USD support up front, so users don't have to
    // tap through to discover it (previously only revealed in the prompt
    // shown after tapping this button).
    [Markup.button.callback('✏️ Custom Buy (ETH or $)', `custombuy_${tokenAddress}`)],
  ];
  if (hasPosition) {
    rows.push(s.sellPresetsPct.map((pct) => Markup.button.callback(`Sell ${pct}%`, `sell_${tokenAddress}_${pct}`)));
    rows.push([Markup.button.callback('✏️ Custom Sell', `customsell_${tokenAddress}`)]);
  }
  rows.push([
    Markup.button.callback('🔄 Refresh', `refresh_${tokenAddress}`),
    Markup.button.callback('⬅️ Back', 'menu_main'),
  ]);
  return Markup.inlineKeyboard(rows);
}

// ---------- Token info + PnL rendering ----------

async function renderTokenCard(uid, tokenAddress) {
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
  }

  const changeLine = market.priceChange24h !== null ? ` (${market.priceChange24h >= 0 ? '+' : ''}${market.priceChange24h.toFixed(1)}%)` : '';
  const walletBalance = await balanceLines(w.address).catch(() => 'unavailable');

  const text =
    `*${market.symbol}*\n\`${tokenAddress}\`\n\n` +
    `Price: $${market.priceUsd.toPrecision(4)}${changeLine}\n` +
    `Market Cap: ${fmtUsd(market.marketCap)}\n` +
    `Liquidity: ${fmtUsd(market.liquidityUsd)}\n` +
    `Your balance: ${walletBalance}` +
    pnlLine;

  return { text, markup: tokenMenu(uid, tokenAddress, !!(pos && pos.tokenAmount > 0)) };
}

// ---------- Shared trade execution ----------

async function executeBuy(ctx, uid, tokenAddress, ethAmount) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

  const { maxBuyEth } = getSettings(uid);
  if (ethAmount > maxBuyEth) {
    return ctx.reply(`❌ ${ethAmount} ETH exceeds your max buy size (${maxBuyEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
  }

  if (tradesInFlight.has(uid)) {
    return ctx.reply('⏳ A trade is already in progress — please wait for it to finish.');
  }
  tradesInFlight.add(uid);

  let pendingTradeId;
  try {
    await ctx.reply(`Buying ${ethAmount} ETH worth... fetching quote.`);
    const sellAmount = ethers.parseEther(ethAmount.toString()).toString();
    const { slippageBps } = getSettings(uid);
    const quoteParams = { sellToken: 'ETH', buyToken: tokenAddress, sellAmount, taker: w.address, slippageBps };

    pendingTradeId = createPendingTrade({ uid, walletId: w.id, tokenAddress, side: 'buy', amount: ethAmount });

    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    const signer = new ethers.Wallet(w.privateKey, provider);
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse, receipt, bumped } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    const txLink = explorerTxUrl(txResponse.hash);
    if (bumped) await ctx.reply('⛽ Network was congested — resubmitted with higher gas.');
    markPendingTradeDone(pendingTradeId, 'confirmed');
    recordTrade(uid, w.id, tokenAddress, 'buy', Number(quote.buyAmountFormatted), ethAmount);
    await ctx.reply(
      txLink ? `✅ Confirmed — [view transaction](${txLink})` : `✅ Confirmed in block ${receipt.blockNumber}`,
      { parse_mode: 'Markdown' }
    );
    const { text, markup } = await renderTokenCard(uid, tokenAddress);
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  } catch (err) {
    console.error(err);
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    await ctx.reply(`❌ Trade failed: ${friendlyErrorMessage(err)}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Buy failed for user ${uid} on ${tokenAddress}: ${err.message}`);
  } finally {
    tradesInFlight.delete(uid);
  }
}

async function executeSell(ctx, uid, tokenAddress, pct) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));
  const pos = getPosition(uid, w.id, tokenAddress);
  if (!pos || pos.tokenAmount <= 0) return ctx.reply('No position to sell.', mainMenu());

  if (tradesInFlight.has(uid)) {
    return ctx.reply('⏳ A trade is already in progress — please wait for it to finish.');
  }
  tradesInFlight.add(uid);

  const tokenAmount = pos.tokenAmount * (pct / 100);
  let pendingTradeId;
  try {
    await ctx.reply(`Selling ${pct}%... fetching quote.`);

    // Fetch the token's real decimals — do not assume 18, many tokens differ.
    const decimals = await getDecimals(provider, tokenAddress).catch(() => 18);
    const sellAmount = ethers.parseUnits(tokenAmount.toFixed(Math.min(decimals, 18)), decimals).toString();

    const { slippageBps } = getSettings(uid);
    const signer = new ethers.Wallet(w.privateKey, provider);

    pendingTradeId = createPendingTrade({ uid, walletId: w.id, tokenAddress, side: 'sell', amount: tokenAmount });

    const approvalReceipt = await ensureAllowance(signer, tokenAddress, BigInt(sellAmount));
    if (approvalReceipt) await ctx.reply('Approved token for trading (one-time step). Continuing...');

    const quoteParams = { sellToken: tokenAddress, buyToken: 'ETH', sellAmount, taker: w.address, slippageBps };
    let quote = await getQuote(quoteParams);
    const fetchedAt = Date.now();
    // Approval above can take a while to confirm — re-quote if price may have moved since.
    quote = await getFreshQuote(quoteParams, quote, fetchedAt);

    const txRequest = await buildSwapTx(signer, quote);
    const { txResponse, receipt, bumped } = await sendSwapWithGasBump(signer, txRequest, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingTradeSubmitted(pendingTradeId, txResponse.hash);
    const txLink = explorerTxUrl(txResponse.hash);
    if (bumped) await ctx.reply('⛽ Network was congested — resubmitted with higher gas.');
    markPendingTradeDone(pendingTradeId, 'confirmed');
    recordTrade(uid, w.id, tokenAddress, 'sell', tokenAmount, Number(quote.buyAmountFormatted));
    await ctx.reply(
      txLink ? `✅ Confirmed — [view transaction](${txLink})` : `✅ Confirmed in block ${receipt.blockNumber}`,
      { parse_mode: 'Markdown' }
    );
    const { text, markup } = await renderTokenCard(uid, tokenAddress);
    await ctx.reply(text, { parse_mode: 'Markdown', ...markup });
  } catch (err) {
    console.error(err);
    if (pendingTradeId) markPendingTradeDone(pendingTradeId, 'failed');
    await ctx.reply(`❌ Trade failed: ${friendlyErrorMessage(err)}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Sell failed for user ${uid} on ${tokenAddress}: ${err.message}`);
  } finally {
    tradesInFlight.delete(uid);
  }
}

function confirmMenu(kind, tokenAddress, value) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', `confirm_${kind}_${tokenAddress}_${value}`),
      Markup.button.callback('❌ Cancel', 'cancel_trade'),
    ],
  ]);
}

// ---------- Shared bridge execution ----------

async function executeBridge(ctx, uid, direction, amountEth) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

  // Same guard shape as executeBuy's maxBuyEth check — belt-and-suspenders in
  // case this got here via a route that skipped the earlier bridge_amount check.
  const { maxBridgeEth } = getSettings(uid);
  if (amountEth > maxBridgeEth) {
    return ctx.reply(`❌ ${amountEth} ETH exceeds your max bridge size (${maxBridgeEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
  }

  if (bridgesInFlight.has(uid)) {
    return ctx.reply('⏳ A bridge is already in progress — please wait for it to finish.');
  }
  bridgesInFlight.add(uid);

  let pendingBridgeId;
  try {
    await ctx.reply(`Bridging ${amountEth} ETH (${directionLabel(direction)})... fetching quote.`);
    const { fromChain, toChain } = chainIdsForDirection(direction);
    const quote = await getBridgeQuote({ direction, amountEth, fromAddress: w.address });

    pendingBridgeId = createPendingBridge({
      uid, walletId: w.id, direction, amountEth, fromChain, toChain, bridgeTool: quote.tool,
    });

    // Bridges can originate on either chain — use a provider pointed at the source chain
    // for ETH_TO_ROBINHOOD; the configured RPC_URL provider is Robinhood Chain, so for
    // that direction we use the shared mainnet provider created once at startup.
    const sourceProvider = fromChain === ETH_CHAIN_ID ? ethMainnetProvider : provider;
    const sourceSigner = new ethers.Wallet(w.privateKey, sourceProvider);

    const { txResponse, bumped } = await sendBridgeTx(sourceSigner, quote, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingBridgeSubmitted(pendingBridgeId, txResponse.hash);

    if (bumped) await ctx.reply('⛽ Network was congested — resubmitted with higher gas.');

    const txLink = explorerTxUrlForChain(txResponse.hash, fromChain);
    await ctx.reply(
      `✅ Bridge submitted${txLink ? ` — [view transaction](${txLink})` : ''}.\n\n` +
      `Estimated arrival: ~${quote.estimatedDurationSeconds ? Math.ceil(quote.estimatedDurationSeconds / 60) + ' min' : 'a few minutes'}.\n` +
      `I'll message you here once it lands on the destination chain.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error(err);
    if (pendingBridgeId) markPendingBridgeDone(pendingBridgeId, 'failed');
    await ctx.reply(`❌ Bridge failed: ${friendlyErrorMessage(err)}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Bridge failed for user ${uid} (${direction}, ${amountEth} ETH): ${err.message}`);
  } finally {
    bridgesInFlight.delete(uid);
  }
}

// ---------- Start / Main menu ----------

bot.start(async (ctx) => {
  const uid = ctx.from.id;
  const payload = ctx.startPayload; // telegraf parses "/start ref_XXXX" into this

  // Attribute referral on a user's very first /start, before the terms gate,
  // so it works even for people who never finish onboarding.
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

bot.action('agree_terms', async (ctx) => {
  setAgreedTerms(ctx.from.id);
  await ctx.answerCbQuery('Thanks — happy trading');
  await ctx.editMessageText(WELCOME_TEXT, {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

// Admin-only: usage and volume snapshot
bot.command('admin_stats', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_CHAT_ID)) return; // silently ignore non-admins
  const s = getStats();
  const feeBps = Number(process.env.AFFILIATE_FEE_BPS || 0);
  const estFeesEth = (s.totalVolumeEth * feeBps) / 10000;
  await ctx.reply(
    `📊 *Admin Stats*\n\n` +
    `Users: ${s.totalUsers}\n` +
    `Wallets: ${s.totalWallets}\n` +
    `Open positions: ${s.openPositions}\n` +
    `Total trades: ${s.totalTrades}\n` +
    `Total volume: ${s.totalVolumeEth.toFixed(4)} ETH\n` +
    `Est. fees earned: ${estFeesEth.toFixed(4)} ETH\n` +
    `Total referrals: ${s.totalReferrals}\n` +
    `Total bridges: ${s.totalBridges} (completed volume: ${s.totalBridgeVolumeEth.toFixed(4)} ETH)\n\n` +
    `Last 24h:\n` +
    `Active users: ${s.activeUsers24h}\n` +
    `Volume: ${s.volume24hEth.toFixed(4)} ETH`,
    { parse_mode: 'Markdown' }
  );
});

// Admin-only: inspect bridges stuck in pending/submitted and force an
// immediate LI.FI status recheck on each. Exists because the background
// poller fails silently into console.error — this surfaces the same check
// with its actual result/error visible in Telegram, and updates storage +
// admin stats if it turns out to have actually completed.
bot.command('admin_bridges', async (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_CHAT_ID)) return; // silently ignore non-admins

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
  await ctx.editMessageText('🌴 *RobinPanchi Trading Bot*', { parse_mode: 'Markdown', ...mainMenu() });
});

bot.action('menu_trade', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'awaiting_ca' });
  await ctx.editMessageText('Paste the token contract address:');
});

bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(HELP_TEXT, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});

// ---------- Wallets ----------

bot.action('menu_wallets', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const user = getUser(uid);
  const header = user.wallets.length === 0
    ? 'No wallets yet. Create or import one to get started.'
    : '💼 *Your Wallets*\n✅ = active wallet for trading';
  await ctx.editMessageText(header, { parse_mode: 'Markdown', ...walletsMenu(uid) });
});

bot.action('wallet_create', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'create_name' });
  await ctx.editMessageText('Send a name for this new wallet (e.g. "Main"):');
});

bot.action('wallet_import', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'import_name' });
  await ctx.editMessageText('Send a name for the imported wallet (e.g. "Cold Wallet"):');
});

bot.action(/^wallet_activate_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Active wallet updated');
  setActiveWallet(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText('💼 *Your Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ctx.from.id) });
});

bot.action(/^wallet_rename_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'rename', walletId: ctx.match[1] });
  await ctx.editMessageText('Send the new name for this wallet:');
});

bot.action(/^wallet_remove_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Wallet removed');
  removeWallet(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText('💼 *Your Wallets*', { parse_mode: 'Markdown', ...walletsMenu(ctx.from.id) });
});

// Extra friction on top of the button tap: the user must type the wallet's
// exact name before the key is shown. A compromised/left-open Telegram
// session can tap a button by accident; typing the name is much less likely
// to happen without the account owner actually meaning it.
bot.action(/^wallet_export_confirm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  pending.set(ctx.from.id, { type: 'export_type_confirm', walletId: w.id, walletName: w.name });
  await ctx.editMessageText(
    `⚠️ Type the wallet's name exactly (*${w.name}*) to confirm you want to reveal its private key:`,
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^wallet_export_(?!confirm)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  await ctx.editMessageText(
    `⚠️ This will display the raw private key for *${w.name}* in this chat.\n\nAnyone who sees it can take everything in this wallet. Continue?`,
    { parse_mode: 'Markdown', ...exportConfirmMenu(w.id) }
  );
});

bot.action(/^wallet_(?!create|import|activate|rename|remove|export)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const w = getWallet(ctx.from.id, ctx.match[1]);
  if (!w) return ctx.editMessageText('Wallet not found.', walletsMenu(ctx.from.id));
  const bal = await balanceLines(w.address).catch(() => 'unavailable');
  await ctx.editMessageText(`*${w.name}*\n\`${w.address}\`\n\nBalance: ${bal}`, {
    parse_mode: 'Markdown',
    ...walletDetailMenu(w.id),
  });
});

// ---------- Positions ----------

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const w = getActiveWallet(uid);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(uid));

  const positions = getAllPositions(uid, w.id);
  if (positions.length === 0) {
    return ctx.editMessageText('📊 No positions yet. Trade a token to open one.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
    });
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
      text += `\n*${symbol}*: ${pos.tokenAmount.toFixed(4)} — ${fmtUsd(valueUsd)} (${emoji} ${pnlPct.toFixed(1)}%)`;
    } else {
      text += `\n*${symbol}*: ${pos.tokenAmount.toFixed(4)} — price unavailable`;
    }
    rows.push([Markup.button.callback(`View ${symbol}`, `refresh_${pos.tokenAddress}`)]);
  }

  rows.push([Markup.button.callback('⬅️ Back', 'menu_main')]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
});

// ---------- Portfolio-wide PnL summary ----------
// Same math as menu_positions but aggregated across EVERY wallet the user
// owns, not just the active one — gives a single "how am I doing overall" view.

bot.action('menu_portfolio', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const positions = getAllPositionsForUser(uid);

  if (positions.length === 0) {
    return ctx.editMessageText('📈 No open positions across any wallet yet.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
    });
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
      lines.push(`*${symbol}* (${pos.walletName}): ${fmtUsd(valueUsd)} (${emoji} ${pnlPct.toFixed(1)}%)`);
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

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});

// ---------- Settings ----------

bot.action('menu_settings', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

bot.action('settings_buy', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_buy' });
  await ctx.editMessageText('Send comma-separated ETH amounts, e.g. `0.01, 0.05, 0.2`', { parse_mode: 'Markdown' });
});

bot.action('settings_sell', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_sell' });
  await ctx.editMessageText('Send comma-separated sell percentages, e.g. `25, 50, 75, 100`', { parse_mode: 'Markdown' });
});

bot.action('settings_slippage', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_slippage' });
  await ctx.editMessageText('Send slippage tolerance as a percentage, e.g. `1` for 1%', { parse_mode: 'Markdown' });
});

bot.action('settings_maxbuy', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_maxbuy' });
  await ctx.editMessageText('Send the max ETH allowed per single buy, e.g. `0.5`', { parse_mode: 'Markdown' });
});

bot.action('settings_maxbridge', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_maxbridge' });
  await ctx.editMessageText('Send the max ETH allowed per single bridge, e.g. `0.5`', { parse_mode: 'Markdown' });
});

// Cycles slow -> normal -> fast -> slow. A tap-to-cycle button avoids yet
// another free-text prompt for a 3-value setting.
bot.action('settings_gastier', async (ctx) => {
  const s = getSettings(ctx.from.id);
  const idx = GAS_TIERS.indexOf(s.gasTier);
  const next = GAS_TIERS[(idx + 1) % GAS_TIERS.length];
  updateSettings(ctx.from.id, { gasTier: next });
  await ctx.answerCbQuery(`Gas priority set to ${next}`);
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

bot.action('settings_lowbalance', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'settings_lowbalance' });
  await ctx.editMessageText(
    'Send the ETH balance threshold to alert on, e.g. `0.01`. Send `0` to disable low-balance alerts.',
    { parse_mode: 'Markdown' }
  );
});

bot.action('settings_toggle_confirm', async (ctx) => {
  const s = getSettings(ctx.from.id);
  updateSettings(ctx.from.id, { confirmTrades: !s.confirmTrades });
  await ctx.answerCbQuery(`Confirmation ${!s.confirmTrades ? 'enabled' : 'disabled'}`);
  await ctx.editMessageText('⚙️ *Settings*', { parse_mode: 'Markdown', ...settingsMenu(ctx.from.id) });
});

// ---------- Rewards ----------

bot.action('menu_rewards', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const tickets = getTicketCount(uid);
  await ctx.editMessageText(
    `🎟 *Rewards*\n\n` +
    `Refer friends to earn raffle tickets for a chance to win a Panchi NFT.\n` +
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

// ---------- Bridge ----------

bot.action('menu_bridge', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));

  await ctx.editMessageText('🌉 *Bridge ETH*\n\nFetching your balances...', { parse_mode: 'Markdown' });

  const [balances, ethUsd] = await Promise.all([
    getBridgeBalances(w.address),
    getEthUsdPrice().catch(() => null),
  ]);

  const balanceLines = [
    fmtBridgeBalanceLine('Ethereum — ETH', balances.ethMainnet, ethUsd),
    fmtBridgeBalanceLine('Robinhood — ETH', balances.ethRobinhood, ethUsd),
    // USDG is a dollar-pegged stablecoin, so its own amount is ~its USD value — no ethUsd conversion needed.
    fmtBridgeBalanceLine('Robinhood — USDG', balances.usdgRobinhood, balances.usdgRobinhood !== null ? 1 : null),
  ];

  await ctx.editMessageText(
    `🌉 *Bridge ETH*\n\n` +
    `Move ETH between Ethereum mainnet and Robinhood Chain.\n` +
    `Active wallet: *${w.name}* (\`${shortAddr(w.address)}\`)\n\n` +
    `*Your balances:*\n${balanceLines.join('\n')}\n\n` +
    `You'll be able to enter the amount in ETH or USD.`,
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
    `Send the amount to bridge (${directionLabel(direction)}) — ETH like \`0.05\`, or USD like \`$100\`:${sourceBalanceLine}`,
    { parse_mode: 'Markdown' }
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

// ---------- Custom buy/sell prompts ----------

bot.action(/^custombuy_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_buy', tokenAddress: ctx.match[1] });
  await ctx.editMessageText(
    'Send the amount to spend — ETH like `0.03`, or USD like `$100`:',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^customsell_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { type: 'custom_sell', tokenAddress: ctx.match[1] });
  await ctx.editMessageText('Send the percentage to sell, e.g. `40` for 40%');
});

// ---------- Balance ----------

bot.action('menu_balance', async (ctx) => {
  await ctx.answerCbQuery();
  const w = getActiveWallet(ctx.from.id);
  if (!w) return ctx.editMessageText('No active wallet. Add one first.', walletsMenu(ctx.from.id));
  const bal = await balanceLines(w.address);
  await ctx.editMessageText(`💰 *${w.name}*\n\`${w.address}\`\n\nBalance: ${bal}`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_main')]]),
  });
});

// ---------- Token card: refresh ----------

bot.action(/^refresh_(0x[a-fA-F0-9]{40})$/, async (ctx) => {
  await ctx.answerCbQuery('Refreshed');
  const { text, markup } = await renderTokenCard(ctx.from.id, ctx.match[1]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...markup }).catch((err) => {
    if (!err.description?.includes('message is not modified')) throw err;
  });
});

// ---------- Buy ----------

bot.action(/^buy_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const [, tokenAddress, ethAmountStr] = ctx.match;
  const uid = ctx.from.id;
  const { confirmTrades, maxBuyEth } = getSettings(uid);
  const ethAmount = Number(ethAmountStr);
  if (ethAmount > maxBuyEth) {
    return ctx.editMessageText(`❌ ${ethAmount} ETH exceeds your max buy size (${maxBuyEth} ETH).`, mainMenu());
  }
  if (confirmTrades) {
    const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_BUY);
    await ctx.editMessageText(`Confirm: buy *${ethAmountStr} ETH* worth of this token?${gasLine}`, {
      parse_mode: 'Markdown',
      ...confirmMenu('buy', tokenAddress, ethAmountStr),
    });
  } else {
    await executeBuy(ctx, uid, tokenAddress, ethAmount);
  }
});

// ---------- Sell ----------

bot.action(/^sell_(0x[a-fA-F0-9]{40})_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const [, tokenAddress, pctStr] = ctx.match;
  const uid = ctx.from.id;
  const { confirmTrades } = getSettings(uid);
  if (confirmTrades) {
    const gasLine = await gasEstimateLine(uid, FALLBACK_GAS_LIMIT_SELL);
    await ctx.editMessageText(`Confirm: sell *${pctStr}%* of your position?${gasLine}`, {
      parse_mode: 'Markdown',
      ...confirmMenu('sell', tokenAddress, pctStr),
    });
  } else {
    await executeSell(ctx, uid, tokenAddress, Number(pctStr));
  }
});

bot.action(/^confirm_buy_(0x[a-fA-F0-9]{40})_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  await executeBuy(ctx, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

bot.action(/^confirm_sell_(0x[a-fA-F0-9]{40})_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  await executeSell(ctx, ctx.from.id, ctx.match[1], Number(ctx.match[2]));
});

// ---------- Bridge confirm ----------

bot.action(/^bridge_confirm_(eth_to_robinhood|robinhood_to_eth)_([\d.]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (isRateLimited(ctx.from.id)) return ctx.reply('⏳ Slow down a bit — too many actions in the last minute.');
  const direction = ctx.match[1] === 'eth_to_robinhood' ? BRIDGE_DIRECTION.ETH_TO_ROBINHOOD : BRIDGE_DIRECTION.ROBINHOOD_TO_ETH;
  await executeBridge(ctx, ctx.from.id, direction, Number(ctx.match[2]));
});

bot.action('cancel_trade', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('Trade cancelled.', mainMenu());
});

// ---------- Free-text handler (wallet setup + CA paste + bridge amount) ----------

bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const state = pending.get(uid);
  const text = ctx.message.text.trim();

  // CA paste is allowed any time, not just when explicitly prompted
  if (CA_REGEX.test(text)) {
    if (!hasAgreedTerms(uid)) {
      return ctx.reply(TERMS_TEXT, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ I understand, continue', 'agree_terms')]]),
      });
    }
    if (isRateLimited(uid)) return ctx.reply('⏳ Slow down a bit — too many lookups in the last minute.');
    pending.delete(uid);
    const { text: cardText, markup } = await renderTokenCard(uid, text);
    await ctx.reply(cardText, { parse_mode: 'Markdown', ...markup });
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
      const amounts = text.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n) && n > 0);
      if (amounts.length === 0) return ctx.reply('Send valid numbers, e.g. `0.01, 0.05, 0.2`', { parse_mode: 'Markdown' });
      updateSettings(uid, { buyPresetsEth: amounts });
      pending.delete(uid);
      await ctx.reply(`✅ Buy presets updated: ${amounts.join(', ')} ETH`, mainMenu());
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
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) return ctx.reply('Send a valid positive ETH amount, e.g. `0.5`');
      updateSettings(uid, { maxBuyEth: amt });
      pending.delete(uid);
      await ctx.reply(`✅ Max buy size set to ${amt} ETH`, mainMenu());
      return;
    }

    if (state.type === 'settings_maxbridge') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) return ctx.reply('Send a valid positive ETH amount, e.g. `0.5`');
      updateSettings(uid, { maxBridgeEth: amt });
      pending.delete(uid);
      await ctx.reply(`✅ Max bridge size set to ${amt} ETH`, mainMenu());
      return;
    }

    if (state.type === 'settings_lowbalance') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt < 0) return ctx.reply('Send a valid non-negative ETH amount, e.g. `0.01`, or `0` to disable.');
      updateSettings(uid, { lowBalanceThresholdEth: amt });
      lowBalanceWarned.delete(String(uid)); // threshold changed — allow a fresh check against the new value
      pending.delete(uid);
      await ctx.reply(
        amt === 0 ? '✅ Low balance alerts disabled.' : `✅ Low balance alert threshold set to ${amt} ETH`,
        mainMenu()
      );
      return;
    }

    if (state.type === 'custom_buy') {
      // Accepts either a plain ETH figure ("0.03") or a USD figure ("$100"),
      // same parser used by the bridge amount flow.
      let val, usdInput;
      try {
        ({ amountEth: val, usdInput } = await parseEthOrUsdInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      // Round to 6 decimals: keeps callback_data short enough for Telegram's
      // 64-byte limit (a raw USD/price division can produce 15+ decimal
      // digits, which overflows it and causes BUTTON_DATA_INVALID).
      val = Number(val.toFixed(6));

      const { maxBuyEth } = getSettings(uid);
      if (val > maxBuyEth) {
        pending.delete(uid);
        return ctx.reply(`❌ ${val} ETH exceeds your max buy size (${maxBuyEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
      }

      pending.delete(uid);

      const { confirmTrades } = getSettings(uid);
      const label = usdInput !== null ? `≈ ${val} ETH (${fmtUsd(usdInput)})` : `${val} ETH`;
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

    if (state.type === 'bridge_amount') {
      // Accepts either a plain ETH figure ("0.05") or a USD figure ("$100"),
      // converting USD -> ETH via the live ETH/USD price feed.
      let amt, usdInput;
      try {
        ({ amountEth: amt, usdInput } = await parseBridgeAmountInput(text));
      } catch (err) {
        return ctx.reply(err.message, { parse_mode: 'Markdown' });
      }

      // Round to 6 decimals: keeps callback_data short enough for Telegram's
      // 64-byte limit (a raw USD/price division can produce 15+ decimal
      // digits, which overflows it and causes BUTTON_DATA_INVALID).
      amt = Number(amt.toFixed(6));

      // Guard bridge amount against the configured cap, same as buy amounts —
      // previously this check only existed on the buy path, so a bridge could
      // go straight to a quote (and eventual raw signer error) for any size.
      const { maxBridgeEth } = getSettings(uid);
      if (amt > maxBridgeEth) {
        pending.delete(uid);
        return ctx.reply(`❌ ${amt.toFixed(6)} ETH exceeds your max bridge size (${maxBridgeEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
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

      const sendLine = usdInput !== null
        ? `Send: ≈ ${amt.toFixed(6)} ETH (${fmtUsd(usdInput)})`
        : `Send: ${amt} ETH`;

      // Gas estimate uses the real quote's gas limit (LI.FI supplies one) on
      // the actual source-chain provider, so this is more precise than the
      // fallback-based estimate used for buy/sell.
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

// ---------- Startup: crash recovery check ----------

async function checkStuckTrades() {
  const stuck = getStuckPendingTrades();
  if (stuck.length === 0) return;
  const lines = stuck.map((t) =>
    `• ${t.side} ${t.amount} on ${t.token_address} (user ${t.uid}, status: ${t.status}${t.tx_hash ? `, tx: ${t.tx_hash}` : ''})`
  );
  await sendAdminAlert(
    bot.telegram,
    `Bot restarted with ${stuck.length} unresolved trade(s) from before the crash — verify these manually:\n${lines.join('\n')}`
  );
  console.warn(`${stuck.length} pending trade(s) unresolved from before restart. See admin alert / pending_trades table.`);
}

// Bridges left "pending"/"submitted" after a restart split into two buckets:
// - resumable: has a source_tx_hash, so the poller can keep checking LI.FI's
//   status for it automatically.
// - needs manual review: no source_tx_hash, meaning the process crashed
//   before we know whether the source-chain tx was ever sent. The poller
//   cannot recover these on its own (there's nothing to poll), so they are
//   called out separately and explicitly so they don't get mistaken for
//   something that will resolve itself.
async function checkStuckBridges() {
  const stuck = getInFlightBridges();
  if (stuck.length === 0) return;

  const resumable = stuck.filter((b) => b.source_tx_hash);
  const needsManualReview = stuck.filter((b) => !b.source_tx_hash);

  if (resumable.length > 0) {
    await sendAdminAlert(
      bot.telegram,
      `Bot restarted with ${resumable.length} in-flight bridge(s) — the poller will resume tracking them automatically.`
    );
    console.warn(`${resumable.length} in-flight bridge(s) resuming after restart.`);
  }

  if (needsManualReview.length > 0) {
    const lines = needsManualReview.map((b) =>
      `• ${b.direction} — ${b.amount_eth} ETH (user ${b.uid}, id ${b.id}, status: ${b.status})`
    );
    await sendAdminAlert(
      bot.telegram,
      `⚠️ Bot restarted with ${needsManualReview.length} bridge(s) that have NO source tx hash — ` +
      `unknown whether the source-chain transaction was ever sent. These CANNOT be auto-recovered ` +
      `by the poller and need manual verification (check the user's wallet/chain explorer):\n${lines.join('\n')}`
    );
    console.warn(`${needsManualReview.length} bridge(s) with no source_tx_hash need manual review after restart.`);
  }
}

// Periodically checks LI.FI status for every bridge still pending/submitted and
// notifies the user + updates storage once it resolves. This is what lets a
// bridge started before a restart, or one whose status simply took a while,
// still get tracked to completion without the user re-checking manually.
function startBridgePoller() {
  setInterval(async () => {
    let inFlight;
    try {
      inFlight = getInFlightBridges();
    } catch (err) {
      console.error('Bridge poller: failed to read in-flight bridges:', err.message);
      return;
    }

    for (const b of inFlight) {
      if (!b.source_tx_hash) continue; // not submitted yet, nothing to poll
      try {
        const result = await checkBridgeStatusOnce({
          txHash: b.source_tx_hash,
          fromChain: b.from_chain,
          toChain: b.to_chain,
          bridgeTool: b.bridge_tool,
        });

        if (result.status === 'DONE') {
          markPendingBridgeDone(b.id, 'done', result.destTxHash);
          const destLink = result.destTxHash ? explorerTxUrlForChain(result.destTxHash, b.to_chain) : null;
          await bot.telegram.sendMessage(
            b.uid,
            `✅ Your bridge (${directionLabel(b.direction)}, ${b.amount_eth} ETH) has landed!` +
            (destLink ? `\n[View transaction](${destLink})` : ''),
            { parse_mode: 'Markdown' }
          ).catch((err) => console.error(`Failed to notify uid ${b.uid} of bridge completion:`, err.message));
        } else if (result.status === 'FAILED') {
          markPendingBridgeDone(b.id, 'failed', null);
          await bot.telegram.sendMessage(
            b.uid,
            `❌ Your bridge (${directionLabel(b.direction)}, ${b.amount_eth} ETH) failed on the destination side. Contact support if funds don't show up: panchi.eth@gmail.com`
          ).catch((err) => console.error(`Failed to notify uid ${b.uid} of bridge failure:`, err.message));
          await sendAdminAlert(bot.telegram, `Bridge FAILED for user ${b.uid}: ${b.direction}, ${b.amount_eth} ETH, tx ${b.source_tx_hash}`);
        }
        // PENDING: leave as-is, will be re-checked next tick.
      } catch (err) {
        console.error(`Bridge poller: status check failed for bridge ${b.id}:`, err.message);
      }
    }
  }, BRIDGE_POLL_INTERVAL_MS);
}

// Periodically checks every user's active wallet ETH balance and DMs a
// one-time warning when it drops below their configured threshold (default
// 0.01 ETH, 0 = disabled). Re-arms once the balance recovers above the
// threshold, so a user can be warned again on a future dip. Runs on active
// wallets only (getAllActiveWallets), not every wallet ever created, to keep
// this cheap as the user base grows.
function startLowBalancePoller() {
  setInterval(async () => {
    let wallets;
    try {
      wallets = getAllActiveWallets();
    } catch (err) {
      console.error('Low-balance poller: failed to read active wallets:', err.message);
      return;
    }

    for (const w of wallets) {
      try {
        const { lowBalanceThresholdEth } = getSettings(w.uid);
        if (!lowBalanceThresholdEth || lowBalanceThresholdEth <= 0) continue;

        const bal = await provider.getBalance(w.address).then((b) => Number(ethers.formatEther(b)));
        const key = String(w.uid);

        if (bal < lowBalanceThresholdEth) {
          if (!lowBalanceWarned.has(key)) {
            lowBalanceWarned.add(key);
            await bot.telegram.sendMessage(
              w.uid,
              `⚠️ Low balance: *${w.name}* has ${bal.toFixed(4)} ETH, below your alert threshold of ${lowBalanceThresholdEth} ETH.\n` +
              `Add funds to keep trading smoothly. Adjust this threshold anytime in ⚙️ Settings.`,
              { parse_mode: 'Markdown' }
            ).catch((err) => console.error(`Failed to send low-balance alert to uid ${w.uid}:`, err.message));
          }
        } else {
          lowBalanceWarned.delete(key); // recovered — allow a future re-alert if it drops again
        }
      } catch (err) {
        console.error(`Low-balance poller: check failed for uid ${w.uid}:`, err.message);
      }
    }
  }, LOW_BALANCE_POLL_INTERVAL_MS);
}

// Surface crashes to the admin instead of the process dying with no record anywhere.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  sendAdminAlert(bot.telegram, `🚨 Unhandled rejection: ${err?.message || err}`).catch(() => {});
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  sendAdminAlert(bot.telegram, `🚨 Uncaught exception (process will exit): ${err.message}`)
    .catch(() => {})
    .finally(() => process.exit(1)); // an uncaught exception means state may be inconsistent — let pm2/systemd restart clean
});

bot.launch()
  .then(checkStuckTrades)
  .then(checkStuckBridges)
  .then(startBridgePoller)
  .then(startLowBalancePoller)
  .then(() => sendAdminAlert(bot.telegram, '✅ Bot started.'))
  .catch((err) => {
    console.error('Failed to launch bot:', err);
    process.exit(1);
  });

console.log('Panchi trading bot running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
