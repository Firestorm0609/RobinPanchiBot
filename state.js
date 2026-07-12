import { getSettings } from './storage.js';
import { GAS_TIER_MULTIPLIERS } from './config.js';

export const pending = new Map(); // uid -> { type, ...context }
export const tradesInFlight = new Set(); // uid -> a buy/sell (interactive OR headless) is currently signing/sending
export const fundsInFlight = new Set(); // uid -> locked while a batch-fund/collect distribution is executing

export const lowBalanceWarned = new Set();

export const botIdentity = { username: null };

export function gasMultiplierFor(uid) {
  const { gasTier } = getSettings(uid);
  return GAS_TIER_MULTIPLIERS[gasTier] ?? 1;
}

// ---------- Token card auto-refresh ----------
export const autoRefreshTimers = new Map();

export function stopAutoRefresh(uid) {
  uid = String(uid);
  const timer = autoRefreshTimers.get(uid);
  if (timer) {
    clearInterval(timer);
    autoRefreshTimers.delete(uid);
  }
}

// ---------- Positions view auto-refresh ----------
export const positionsRefreshTimers = new Map();

export function stopPositionsRefresh(uid) {
  uid = String(uid);
  const timer = positionsRefreshTimers.get(uid);
  if (timer) {
    clearInterval(timer);
    positionsRefreshTimers.delete(uid);
  }
}

export function stopAllViewRefreshes(uid) {
  stopAutoRefresh(uid);
  stopPositionsRefresh(uid);
}

export function stopAllAutoRefreshes() {
  for (const timer of autoRefreshTimers.values()) clearInterval(timer);
  autoRefreshTimers.clear();
  for (const timer of positionsRefreshTimers.values()) clearInterval(timer);
  positionsRefreshTimers.clear();
}
