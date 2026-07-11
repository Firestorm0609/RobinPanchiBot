import { ethers } from 'ethers';
import { ETH_CHAIN_ID } from './bridge.js';

export const REQUIRED_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'RPC_URL',
  'CHAIN_ID',
  'ZEROX_API_KEY',
  'AFFILIATE_ADDRESS',
  'AFFILIATE_FEE_BPS',
  'MASTER_KEY',
];
export const REQUIRED_FOR_BRIDGE = ['ETH_RPC_URL', 'EXPLORER_BASE_URL'];

export function validateEnv() {
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

export const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, Number(process.env.CHAIN_ID));
export const ethMainnetProvider = new ethers.JsonRpcProvider(
  process.env.ETH_RPC_URL || 'https://cloudflare-eth.com',
  ETH_CHAIN_ID
);

export const USDG_ROBINHOOD_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const ERC20_BALANCE_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export const CA_REGEX = /^0x[a-fA-F0-9]{40}$/;
export const QUOTE_STALE_MS = 15_000;
export const BRIDGE_POLL_INTERVAL_MS = 30_000;
export const LOW_BALANCE_POLL_INTERVAL_MS = 5 * 60_000;
export const AUTO_TRADE_POLL_INTERVAL_MS = 30_000;
export const LIMIT_ORDER_POLL_INTERVAL_MS = 30_000;

export const MAX_BATCH_FUND_NEW_WALLETS = 20; // sane upper bound on wallets-created-in-one-go

export const GAS_TIERS = ['slow', 'normal', 'fast'];
export const GAS_TIER_MULTIPLIERS = { slow: 0.85, normal: 1, fast: 1.35 };
export const FALLBACK_GAS_LIMIT_BUY = 300_000n;
export const FALLBACK_GAS_LIMIT_SELL = 280_000n;
export const FALLBACK_GAS_LIMIT_TRANSFER = 21_000n; // plain native ETH transfer

export const TERMS_TEXT =
  '⚠️ *Before you trade*\n\n' +
  'This bot lets you swap tokens — including low-cap memecoins — directly with your own funds. ' +
  'By using it you accept that:\n\n' +
  '• Memecoins carry high rug-pull and total-loss risk\n' +
  '• Trades are final once confirmed on-chain\n' +
  '• You are solely responsible for funds in wallets you create or import here\n' +
  '• This is not financial advice, and there are no guarantees of any kind\n\n' +
  'Tap below to confirm you understand and wish to continue.';

export const HELP_TEXT =
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
  '*Auto TP/SL*\n' +
  'On any open position, tap 🎯 Set TP/SL to have the bot automatically sell 100% of that position once it hits your target gain (take-profit) or loss (stop-loss). One active rule per position — setting a new one replaces the old.\n\n' +
  '*Limit orders*\n' +
  'Tap ⏰ Limit Buy or ⏰ Limit Sell on a token to queue a trade that fires automatically once the price crosses your target. Cancel anytime under ⏰ Limit Orders in the main menu.\n\n' +
  '*Batch Buy*\n' +
  'Tap 📦 Batch Buy on a token to buy the same ETH or USD amount across multiple wallets in one go — useful for spreading a position.\n\n' +
  '*Batch Sell*\n' +
  'Tap 📦 Batch Sell on a token to sell the same percentage across every wallet that holds a position in it.\n\n' +
  '*Batch Fund*\n' +
  'Open 💼 Wallets → 📤 Batch Fund to send ETH from your best-funded wallet to your other wallets in one go, split evenly. If you only have one wallet, it can create new wallets for you and fund each one.\n\n' +
  '*Batch Collect*\n' +
  'Open 💼 Wallets → 📥 Batch Collect to sweep ETH (Robinhood Chain) plus every token you hold from a set of wallets into a single wallet you choose — handy for consolidating before a withdrawal.\n\n' +
  '*Still stuck?*\n' +
  'Contact support: panchi.eth@gmail.com';

export const WELCOME_TEXT =
  '🌴 *RobinPanchi Trading Bot*\n' +
  'The first NFT trading bot on Robinhood 🍃\n\n' +
  'Paste a token contract address to trade it.\n\n' +
  '_Support: panchi.eth@gmail.com_';
