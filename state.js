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

// ---------- Positions list -> token-card lookup ----------
// Telegram callback_data is capped at 64 bytes, which a Solana mint (up to
// 44 chars) plus a wallet id plus a chain key won't reliably fit into. So
// the Positions view (menus.js's renderPositionsView) doesn't encode the
// token address in the button at all — it stores the position list here,
// keyed by uid, and each button just carries its index into that list
// (handlers/positions.js's `pos_<idx>` action). Overwritten every time the
// Positions view is (re)rendered, so it's always in sync with what's on
// screen; stale taps after a refresh just fail gracefully (index out of
// range -> handled as "list changed, refresh and try again").
export const positionsIndex = new Map(); // uid -> [{ walletId, chain, tokenAddress }, ...]

export function setPositionsIndex(uid, list) {
  positionsIndex.set(String(uid), list);
}

export function getPositionsIndexEntry(uid, idx) {
  const list = positionsIndex.get(String(uid));
  if (!list) return null;
  return list[idx] ?? null;
}
