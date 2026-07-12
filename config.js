import { validateChainEnv } from './chains.js';

export const REQUIRED_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'ZEROX_API_KEY',
  'AFFILIATE_ADDRESS',
  'AFFILIATE_FEE_BPS',
  'MASTER_KEY',
];

export function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }
  const chainProblems = validateChainEnv();
  if (chainProblems.length > 0) {
    console.error(`Chain config problems: ${chainProblems.join('; ')}. See .env.example.`);
    process.exit(1);
  }
  const optionalRpcs = ['ETH_RPC_URL', 'BASE_RPC_URL', 'ARBITRUM_RPC_URL', 'BSC_RPC_URL', 'SOLANA_RPC_URL'];
  const missingOptional = optionalRpcs.filter((k) => !process.env[k]);
  if (missingOptional.length > 0) {
    console.warn(
      `⚠️  Missing optional chain RPC(s): ${missingOptional.join(', ')}. ` +
      `Those chains will fall back to public endpoints (unreliable at volume) until you set a dedicated RPC in .env.`
    );
  }
}

export const CA_REGEX = /^0x[a-fA-F0-9]{40}$/;
// Solana mint addresses are base58, 32-44 chars, no 0/O/I/l — this is a loose
// sanity filter, not full base58 validation (full validation happens at the
// point of actually decoding it, e.g. via PublicKey()).
export const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const QUOTE_STALE_MS = 15_000;
export const AUTO_TRADE_POLL_INTERVAL_MS = 30_000;
export const LIMIT_ORDER_POLL_INTERVAL_MS = 30_000;
export const LOW_BALANCE_POLL_INTERVAL_MS = 5 * 60_000;

export const MAX_BATCH_FUND_NEW_WALLETS = 20;

export const GAS_TIERS = ['slow', 'normal', 'fast'];
export const GAS_TIER_MULTIPLIERS = { slow: 0.85, normal: 1, fast: 1.35 };
export const FALLBACK_GAS_LIMIT_BUY = 300_000n;
export const FALLBACK_GAS_LIMIT_SELL = 280_000n;
export const FALLBACK_GAS_LIMIT_TRANSFER = 21_000n;

// ---------------------------------------------------------------------------
// Gas abstraction (EVM only — Solana's "gas" is a near-zero flat fee paid in
// SOL, cheap enough that a light rent-exempt SOL balance covers thousands of
// swaps, so no auto-top-up mechanism is needed on that side).
// ---------------------------------------------------------------------------
export const MIN_GAS_ETH_RESERVE = 0.003;
export const GAS_TOPUP_USDC_AMOUNT = 5;
export const MIN_SOL_GAS_RESERVE = 0.01; // ~enough for dozens of swaps + rent-exempt token accounts

export const TERMS_TEXT =
  '⚠️ *Before you trade*\n\n' +
  'This bot lets you swap tokens — including low-cap memecoins — directly with your own funds, on any supported chain, entirely in USDC. ' +
  'By using it you accept that:\n\n' +
  '• Memecoins carry high rug-pull and total-loss risk\n' +
  '• Trades are final once confirmed on-chain\n' +
  '• You are solely responsible for funds in wallets you create or import here\n' +
  '• This is not financial advice, and there are no guarantees of any kind\n\n' +
  'Tap below to confirm you understand and wish to continue.';

export const HELP_TEXT =
  '❓ *Help & FAQ*\n\n' +
  '*How do I use this bot?*\n' +
  'Create or import a wallet under 💼 Wallets, pick a chain under 🔗 Chain, deposit USDC on that chain, then paste any token contract address (or Solana mint) to pull up its price and trade it.\n\n' +
  '*Do I need to bridge?*\n' +
  'No. Your wallet works on every supported chain already (same address on all EVM chains; a separate Solana address for Solana). Just deposit USDC directly on whichever chain you want to trade on — no bridging step, ever.\n\n' +
  '*Which chains are supported?*\n' +
  'Ethereum, Base, Arbitrum, BNB Chain, Robinhood Chain, and Solana — all trading directly in native USDC on that chain.\n\n' +
  '*Where\'s my referral link?*\n' +
  'Open 🎟 Rewards from the main menu.\n\n' +
  '*What are the fees?*\n' +
  `A ${(Number(process.env.AFFILIATE_FEE_BPS || 0) / 100).toFixed(2)}% fee applies on swaps, taken from the trade itself. No subscription, no feature is paywalled.\n\n` +
  '*Do I need to hold the native gas token?*\n' +
  'On EVM chains, no — the bot automatically converts a small amount of your USDC into the native gas token behind the scenes. On Solana, you\'ll want a small SOL balance (a few cents worth) since gas there is a flat, tiny fee.\n\n' +
  '*Security tips*\n' +
  '• This bot never DMs you first — if you receive an unsolicited message claiming to be us, it\'s a scammer\n' +
  '• We will never ask you to "verify" your wallet by sending funds or signing a message elsewhere\n' +
  '• Only use the official bot link — search results and copycat bots are common\n' +
  '• Anyone who private-messages you offering "support" and asks for your private key or seed phrase is trying to steal your funds\n\n' +
  '*Common trade failures*\n' +
  '• *Slippage exceeded* — raise your slippage tolerance in Settings, or trade a smaller size\n' +
  '• *Insufficient balance* — you need enough USDC to cover the trade; add funds or reduce the amount\n' +
  '• *Timed out* — the network was congested; the bot automatically resubmits with higher gas (EVM) or resends (Solana), but if it still fails, try again in a moment\n\n' +
  '*Why does my PnL look off?*\n' +
  'PnL is based on your running average USDC cost basis and the live price, so it can shift with volatility between refreshes.\n\n' +
  '*Auto TP/SL*\n' +
  'On any open position, tap 🎯 Set TP/SL to have the bot automatically sell 100% of that position once it hits your target gain (take-profit) or loss (stop-loss). One active rule per position — setting a new one replaces the old.\n\n' +
  '*Limit orders*\n' +
  'Tap ⏰ Limit Buy or ⏰ Limit Sell on a token to queue a trade that fires automatically once the price crosses your target. Cancel anytime under ⏰ Limit Orders in the main menu.\n\n' +
  '*Batch Buy / Batch Sell / Batch Fund / Batch Collect*\n' +
  'Available under 💼 Wallets — all scoped to your currently selected chain.\n\n' +
  '*Still stuck?*\n' +
  'Contact support: panchi.eth@gmail.com';

export const WELCOME_TEXT =
  '🌴 *RobinPanchi Trading Bot*\n' +
  'Trade any chain, entirely in USDC — no bridging, ever 🍃\n\n' +
  'Paste a token contract address (or Solana mint) to trade it, or pick a chain first under 🔗 Chain.\n\n' +
  '_Support: panchi.eth@gmail.com_';
