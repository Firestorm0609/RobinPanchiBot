import { bot } from './bot-instance.js';
import { sendAdminAlert } from './alerts.js';
import { stopAllAutoRefreshes } from './state.js';
import {
  checkStuckTrades, resumeStuckBridges, startLowBalancePoller, startAutoTradePoller,
  startLimitOrderPoller, startBridgeResumePoller,
} from './pollers.js';

// Each of these registers its bot.command/bot.action/bot.on handlers as a
// side effect of being imported — order doesn't matter except that
// bot-instance.js (above) must be created first, which it is via `bot`.
import './handlers/menu.js';
import './handlers/chain.js';
import './handlers/wallets.js';
import './handlers/positions.js';
import './handlers/settings.js';
import './handlers/token.js';
import './handlers/deposit.js';
import './handlers/batch.js';
import './handlers/rewards.js';
import './handlers/text.js'; // must be last: registers the catch-all bot.on('text', ...)

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  sendAdminAlert(bot.telegram, `🚨 Unhandled rejection: ${err?.message || err}`).catch(() => {});
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  sendAdminAlert(bot.telegram, `🚨 Uncaught exception (process will exit): ${err.message}`)
    .catch(() => {})
    .finally(() => process.exit(1));
});

bot.launch()
  .then(() => checkStuckTrades(bot))
  .then(() => resumeStuckBridges(bot)) // one-shot attempt right at startup, before the periodic poller kicks in
  .then(() => startLowBalancePoller(bot))
  .then(() => startAutoTradePoller(bot))
  .then(() => startLimitOrderPoller(bot))
  .then(() => startBridgeResumePoller(bot))
  .then(() => sendAdminAlert(bot.telegram, '✅ Bot started.'))
  .catch((err) => {
    console.error('Failed to launch bot:', err);
    process.exit(1);
  });

console.log('Panchi trading bot running — multichain (EVM + Solana), native stablecoins, auto-bridging shortfalls.');

process.once('SIGINT', () => { stopAllAutoRefreshes(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopAllAutoRefreshes(); bot.stop('SIGTERM'); });
