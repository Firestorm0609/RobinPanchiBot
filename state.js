import { getSettings } from './storage.js';
import { GAS_TIER_MULTIPLIERS } from './config.js';

export const pending = new Map(); // uid -> { type, ...context }
export const tradesInFlight = new Set(); // uid -> a buy/sell (interactive OR headless) is currently signing/sending
export const bridgesInFlight = new Set();
export const fundsInFlight = new Set(); // uid -> locked while a batch-fund/collect distribution is executing

// Mutable holder so multiple modules can read the bot's own username once
// it's resolved at startup (bot.telegram.getMe() is async).
export const botIdentity = { username: null };

export function gasMultiplierFor(uid) {
  const { gasTier } = getSettings(uid);
  return GAS_TIER_MULTIPLIERS[gasTier] ?? 1;
}
