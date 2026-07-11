import { getSettings } from './storage.js';
import { GAS_TIER_MULTIPLIERS } from './config.js';

export const pending = new Map(); // uid -> { type, ...context }
export const tradesInFlight = new Set();
export const bridgesInFlight = new Set();
export const fundsInFlight = new Set(); // uid -> locked while a batch-fund/collect distribution is executing
export const lowBalanceWarned = new Set();

// Mutable holder so multiple modules can read the bot's own username once
// it's resolved at startup (bot.telegram.getMe() is async).
export const botIdentity = { username: null };

export function gasMultiplierFor(uid) {
  const { gasTier } = getSettings(uid);
  return GAS_TIER_MULTIPLIERS[gasTier] ?? 1;
}
