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

// Unanchored source fragment matching EITHER an EVM address OR a Solana mint,
// for building bot.action() callback_data regexes that must work for a token
// on either chain (buy/sell/custombuy/tpsl/limit/refresh buttons — anything
// keyed off a pasted token address). CA_REGEX/SOLANA_ADDRESS_REGEX are
// anchored (^...$) so they can't be spliced into a larger pattern directly —
// this is the same alternation, without anchors, for that purpose.
export const TOKEN_ADDR_SRC = '(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})';

export const QUOTE_STALE_MS = 15_000;
export const AUTO_TRADE_POLL_INTERVAL_MS = 30_000;
export const LIMIT_ORDER_POLL_INTERVAL_MS = 30_000;
export const LOW_BALANCE_POLL_INTERVAL_MS = 5 * 60_000;
export const BRIDGE_RESUME_POLL_INTERVAL_MS = 60_000;

export const GAS_TIERS = ['slow', 'normal', 'fast'];
export const GAS_TIER_MULTIPLIERS = { slow: 0.85, normal: 1, fast: 1.35 };
export const FALLBACK_GAS_LIMIT_BUY = 300_000n;
export const FALLBACK_GAS_LIMIT_SELL = 280_000n;
export const FALLBACK_GAS_LIMIT_TRANSFER = 21_000n; // plain native transfer
// ERC20 `transfer()` (stablecoin withdrawal) costs meaningfully more gas than
// a plain native transfer — 65k is a safe round-up over the ~45-52k typical
// for a standard (non-proxy) ERC20 transfer, used only for the display
// estimate shown before confirming a withdraw, not the actual tx gas limit
// (that's still resolved live at send time via ethers' default estimation).
export const FALLBACK_GAS_LIMIT_ERC20_TRANSFER = 65_000n;

// ---------------------------------------------------------------------------
// Gas abstraction (EVM only — Solana's "gas" is a near-zero flat fee paid in
// SOL, cheap enough that a light rent-exempt SOL balance covers thousands of
// swaps, so no auto-top-up mechanism is needed on that side).
// ---------------------------------------------------------------------------
export const MIN_GAS_ETH_RESERVE = 0.003;
export const GAS_TOPUP_USDC_AMOUNT = 5;
export const MIN_SOL_GAS_RESERVE = 0.01; // ~enough for dozens of swaps + rent-exempt token accounts

// ---------------------------------------------------------------------------
// Cross-chain auto-bridge (CROSSCHAIN_BUILD_PLAN.md Phase 4, shipped).
//
// MIN_BRIDGE_USD: floor below which a shortfall isn't worth auto-bridging.
// A dust bridge can cost more in LI.FI's 25bps fee + source/dest gas than
// the amount itself is worth. $5 comfortably clears typical bridge fees
// (a few cents to ~$1 on most EVM<->EVM routes) with room to spare. If a
// buy's shortfall is under this, performBuyCore fails with a clear message
// telling the user to fund the target chain directly instead of silently
// eating a bad-value bridge.
// ---------------------------------------------------------------------------
export const MIN_BRIDGE_USD = 5;

// Buffer applied on top of a bridge shortfall to absorb LI.FI's fee +
// destination-side slippage, so the destination chain ends up with AT LEAST
// the shortfall amount once the bridge lands (not less, which would abort
// the trade after already paying to bridge). 2% covers LI.FI's ~25bps
// integrator fee plus typical bridge-tool spread with room to spare.
export const BRIDGE_SHORTFALL_BUFFER_PCT = 2;

export const TERMS_TEXT =
  '⚠️ *Before you trade*\n\n' +
  'This bot lets you swap tokens — including low-cap memecoins — directly with your own funds, on any supported chain, entirely in that chain\'s dollar-pegged settlement stablecoin (USDC, or USDG on Robinhood Chain). ' +
  'By using it you accept that:\n\n' +
  '• Memecoins carry high rug-pull and total-loss risk\n' +
  '• Trades are final once confirmed on-chain\n' +
  '• You are solely responsible for funds in wallets you create here\n' +
  '• This is not financial advice, and there are no guarantees of any kind\n\n' +
  'Tap below to confirm you understand and wish to continue.';

export const HELP_TEXT =
  '❓ *Help & FAQ*\n\n' +
  '*How do I use this bot?*\n' +
  'Create a wallet under 💼 Wallets, deposit stablecoin on any chain under 📥 Deposit, then paste any token contract address (or Solana mint) — the bot automatically finds and trades on whichever chain has the best liquidity for it.\n\n' +
  '*Do I need to bridge or pick a chain manually?*\n' +
  'No. Your wallet works on every supported chain already (same address on all EVM chains; a separate Solana address for Solana). Deposit on whichever chain you like — if a token you paste trades on a chain where you\'re short of funds, the bot automatically bridges the shortfall in from another chain where you have a balance, then completes the trade. Small shortfalls (under $5) aren\'t auto-bridged since bridging fees wouldn\'t be worth it — just fund that chain directly for a top-up that small.\n\n' +
  '*Which chains are supported?*\n' +
  'Ethereum, Base, Arbitrum, BNB Chain, Robinhood Chain, and Solana. Deposit USDC on every chain except Robinhood Chain, where the settlement stablecoin is USDG (Robinhood does not have a native USDC deployment) — check 📥 Deposit to see each chain\'s address.\n\n' +
  '*How do I withdraw?*\n' +
  'Open 📤 Withdraw, pick the chain to withdraw from, enter the amount and destination address. You\'ll see an estimated network fee before confirming.\n\n' +
  '*Where\'s my referral link?*\n' +
  'Open 🎟 Rewards from the main menu.\n\n' +
  '*What are the fees?*\n' +
  `A ${(Number(process.env.AFFILIATE_FEE_BPS || 0) / 100).toFixed(2)}% fee applies on swaps, taken from the trade itself. If a trade needs auto-bridging, LI.FI's own bridge fee (typically well under 1%) also applies on that leg. No subscription, no feature is paywalled.\n\n` +
  '*Do I need to hold the native gas token?*\n' +
  'On EVM chains, no — the bot automatically converts a small amount of your chain stablecoin into the native gas token behind the scenes. On Solana, you\'ll want a small SOL balance (a few cents worth) since gas there is a flat, tiny fee.\n\n' +
  '*Security tips*\n' +
  '• This bot never DMs you first — if you receive an unsolicited message claiming to be us, it\'s a scammer\n' +
  '• We will never ask you to "verify" your wallet by sending funds or signing a message elsewhere\n' +
  '• Only use the official bot link — search results and copycat bots are common\n' +
  '• Anyone who private-messages you offering "support" and asks for your private key or seed phrase is trying to steal your funds\n\n' +
  '*Common trade failures*\n' +
  '• *Slippage exceeded* — raise your slippage tolerance in Settings, or trade a smaller size\n' +
  '• *Insufficient balance* — you need enough of the chain\'s stablecoin (or bridgeable balance on another chain) to cover the trade; add funds or reduce the amount\n' +
  '• *Timed out* — the network was congested; the bot automatically resubmits with higher gas (EVM) or resends (Solana), but if it still fails, try again in a moment. A bridge leg that times out is usually still safe — the bot resumes it automatically once LI.FI confirms\n\n' +
  '*Why does my PnL look off?*\n' +
  'PnL is based on your running average cost basis (in that chain\'s stablecoin) and the live price, so it can shift with volatility between refreshes.\n\n' +
  '*Auto TP/SL*\n' +
  'On any open position, tap 🎯 Set TP/SL to have the bot automatically sell 100% of that position once it hits your target gain (take-profit) or loss (stop-loss). One active rule per position — setting a new one replaces the old.\n\n' +
  '*Limit orders*\n' +
  'Tap ⏰ Limit Buy or ⏰ Limit Sell on a token to queue a trade that fires automatically once the price crosses your target. Cancel anytime under ⏰ Limit Orders in the main menu.\n\n' +
  '*Still stuck?*\n' +
  'Contact support: panchi.eth@gmail.com';

export const WELCOME_TEXT =
  '🌴 *RobinPanchi Trading Bot*\n' +
  'Trade any chain, entirely in that chain\'s stablecoin — deposit anywhere, we auto-bridge the rest 🍃\n\n' +
  'Paste a token contract address (or Solana mint) to trade it — we\'ll automatically find and switch to whichever chain has the best liquidity for it.\n\n' +
  '_Support: panchi.eth@gmail.com_';
