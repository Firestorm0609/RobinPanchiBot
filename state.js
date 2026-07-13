import { getSettings } from './storage.js';
import { GAS_TIER_MULTIPLIERS } from './config.js';

export const pending = new Map(); // uid -> { type, ...context }

// uid -> array of { walletId, tokenAddress }, rebuilt every time the
// Positions view renders. Telegram's callback_data has a hard 64-byte cap,
// which a raw "openpos~<walletId>~<tokenAddress>" button blows past (wallet
// id + a full 0x address routinely runs ~70+ bytes) — Telegram then silently
// drops/ignores the button tap. Buttons reference an entry here by short
// index instead ("openpos~3"), so callback_data always stays tiny.
export const positionRefs = new Map();

export const tradesInFlight = new Set(); // uid -> a buy/sell (interactive OR headless) is currently signing/sending
export const bridgesInFlight = new Set();
export const fundsInFlight = new Set(); // uid -> locked while a batch-fund/collect distribution is executing

// uid (string) -> true once we've sent a low-balance alert, so the poller in
// pollers.js doesn't re-notify every cycle while still under threshold.
// Cleared when the user updates their threshold in Settings.
export const lowBalanceWarned = new Set();

// Mutable holder so multiple modules can read the bot's own username once
// it's resolved at startup (bot.telegram.getMe() is async).
export const botIdentity = { username: null };

export function gasMultiplierFor(uid) {
  const { gasTier } = getSettings(uid);
  return GAS_TIER_MULTIPLIERS[gasTier] ?? 1;
}

// ---------- Token card auto-refresh ----------
// uid -> setInterval handle for the token card currently being kept live.
// Only one auto-refresh runs per user at a time — starting a new one (via
// scheduleCardAutoRefresh) clears whatever was running before, so an old
// card doesn't keep getting edited in the background after the user has
// moved on to a different token or menu.
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

/** Stops every kind of live-updating view (token card, positions) for a user. */
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
