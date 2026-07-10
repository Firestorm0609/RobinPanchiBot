// In-memory sliding-window rate limiter, per Telegram user ID.
// Good enough for a single-process bot; resets on restart (acceptable — it's
// abuse protection, not a security boundary).

const WINDOW_MS = 60_000;
const MAX_ACTIONS_PER_WINDOW = 20; // covers CA lookups + trade confirmations

const hits = new Map(); // uid -> array of timestamps

/** Returns true if the user is currently over the limit (call should be rejected). */
export function isRateLimited(uid) {
  const now = Date.now();
  const key = String(uid);
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);

  if (arr.length >= MAX_ACTIONS_PER_WINDOW) {
    hits.set(key, arr);
    return true;
  }

  arr.push(now);
  hits.set(key, arr);
  return false;
}
