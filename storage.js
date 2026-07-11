import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { encrypt, decrypt } from './crypto.js';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'panchi.sqlite');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safe concurrent reads/writes, no more whole-file rewrites

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  active_wallet_id TEXT,
  settings TEXT
);
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  private_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_amount REAL NOT NULL,
  cost_eth REAL NOT NULL,
  entry_mcap REAL,
  PRIMARY KEY (uid, wallet_id, token_address)
);
CREATE TABLE IF NOT EXISTS pending_trades (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trade_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  eth_amount REAL NOT NULL,
  mcap_usd REAL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_uid TEXT NOT NULL,
  referred_uid TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_bridges (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount_eth REAL NOT NULL,
  bridge_tool TEXT,
  from_chain INTEGER NOT NULL,
  to_chain INTEGER NOT NULL,
  source_tx_hash TEXT,
  dest_tx_hash TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auto_rules (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  tp_pct REAL,
  sl_pct REAL,
  status TEXT NOT NULL, -- 'active' | 'cancelled' | 'triggered'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS limit_orders (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL, -- 'buy' | 'sell'
  trigger_price REAL NOT NULL, -- USD price (per-token), what the poller actually checks
  target_mcap REAL, -- USD market cap the user actually typed in — display only
  amount REAL NOT NULL, -- ETH amount for buy side, token amount for sell side
  status TEXT NOT NULL, -- 'open' | 'filled' | 'cancelled' | 'failed'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallets_uid ON wallets(uid);
CREATE INDEX IF NOT EXISTS idx_positions_uid_wallet ON positions(uid, wallet_id);
CREATE INDEX IF NOT EXISTS idx_trade_log_created ON trade_log(created_at);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_uid);
CREATE INDEX IF NOT EXISTS idx_pending_bridges_status ON pending_bridges(status);
CREATE INDEX IF NOT EXISTS idx_pending_bridges_uid ON pending_bridges(uid);
CREATE INDEX IF NOT EXISTS idx_auto_rules_status ON auto_rules(status);
CREATE INDEX IF NOT EXISTS idx_auto_rules_uid ON auto_rules(uid);
CREATE INDEX IF NOT EXISTS idx_limit_orders_status ON limit_orders(status);
CREATE INDEX IF NOT EXISTS idx_limit_orders_uid ON limit_orders(uid);
CREATE INDEX IF NOT EXISTS idx_trade_log_uid_wallet_token ON trade_log(uid, wallet_id, token_address);
`);

// Migration: move referral_code from settings JSON (old location) to an indexed column.
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes('referral_code')) {
  db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT');
  const rows = db.prepare('SELECT uid, settings FROM users').all();
  const backfill = db.prepare('UPDATE users SET referral_code = ? WHERE uid = ?');
  for (const row of rows) {
    try {
      const s = JSON.parse(row.settings || '{}');
      if (s.referralCode) backfill.run(s.referralCode, row.uid);
    } catch { /* skip malformed settings row */ }
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)');

// Migration: add entry_mcap to positions (existing open positions get NULL —
// we have no historical mcap for them, display will just omit the line).
const positionCols = db.prepare("PRAGMA table_info(positions)").all().map((c) => c.name);
if (!positionCols.includes('entry_mcap')) {
  db.exec('ALTER TABLE positions ADD COLUMN entry_mcap REAL');
}

// Migration: add mcap_usd to trade_log (historical rows get NULL).
const tradeLogCols = db.prepare("PRAGMA table_info(trade_log)").all().map((c) => c.name);
if (!tradeLogCols.includes('mcap_usd')) {
  db.exec('ALTER TABLE trade_log ADD COLUMN mcap_usd REAL');
}

// Migration: add target_mcap to limit_orders (existing open orders, created
// before this update, get NULL — they'll display their raw trigger price instead).
const limitOrderCols = db.prepare("PRAGMA table_info(limit_orders)").all().map((c) => c.name);
if (!limitOrderCols.includes('target_mcap')) {
  db.exec('ALTER TABLE limit_orders ADD COLUMN target_mcap REAL');
}

const DEFAULT_SETTINGS = {
  buyPresetsEth: [0.01, 0.05, 0.1],
  sellPresetsPct: [25, 50, 100],
  slippageBps: 100, // 1%
  confirmTrades: true,
  maxBuyEth: 1,
  maxBridgeEth: 1, // mirrors maxBuyEth's guard, applied to bridge amounts
  // Gas priority tier used to scale maxFeePerGas/maxPriorityFeePerGas on
  // every trade/bridge tx. See GAS_TIER_MULTIPLIERS in bot.js.
  gasTier: 'normal', // 'slow' | 'normal' | 'fast'
  // Auto-buy/auto-sell (take-profit / stop-loss). Rules are per-position
  // (auto_rules table) — this flag is currently informational only.
  autoTradeEnabled: false,
  // DM once when active wallet ETH balance drops below this. Set to 0 to disable.
  lowBalanceThresholdEth: 0.01,
  // How PnL cards (sell card, /flex) display profit/loss: 'eth' | 'usd' | 'hidden'
  flexPnlMode: 'eth',
};

function ensureUserRow(uid) {
  const row = db.prepare('SELECT uid FROM users WHERE uid = ?').get(String(uid));
  if (!row) {
    db.prepare('INSERT INTO users (uid, active_wallet_id, settings) VALUES (?, NULL, ?)')
      .run(String(uid), JSON.stringify({}));
  }
}

function walletRowToObj(row, includeDecryptedKey) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    privateKey: includeDecryptedKey ? decrypt(row.private_key) : undefined,
  };
}

export function getUser(uid) {
  uid = String(uid);
  ensureUserRow(uid);
  const userRow = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  const wallets = db.prepare('SELECT id, name, address FROM wallets WHERE uid = ?').all(uid);
  return { wallets, activeWalletId: userRow.active_wallet_id };
}

export function addWallet(uid, wallet) {
  uid = String(uid);
  ensureUserRow(uid);
  const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('INSERT INTO wallets (id, uid, name, address, private_key) VALUES (?, ?, ?, ?, ?)')
    .run(id, uid, wallet.name, wallet.address, encrypt(wallet.privateKey));

  const userRow = db.prepare('SELECT active_wallet_id FROM users WHERE uid = ?').get(uid);
  if (!userRow.active_wallet_id) {
    db.prepare('UPDATE users SET active_wallet_id = ? WHERE uid = ?').run(id, uid);
  }
  return { id, name: wallet.name, address: wallet.address, privateKey: wallet.privateKey };
}

export function removeWallet(uid, walletId) {
  uid = String(uid);
  db.prepare('DELETE FROM wallets WHERE id = ? AND uid = ?').run(walletId, uid);
  const userRow = db.prepare('SELECT active_wallet_id FROM users WHERE uid = ?').get(uid);
  if (userRow?.active_wallet_id === walletId) {
    const next = db.prepare('SELECT id FROM wallets WHERE uid = ? LIMIT 1').get(uid);
    db.prepare('UPDATE users SET active_wallet_id = ? WHERE uid = ?').run(next?.id ?? null, uid);
  }
}

export function renameWallet(uid, walletId, newName) {
  db.prepare('UPDATE wallets SET name = ? WHERE id = ? AND uid = ?').run(newName, walletId, String(uid));
}

export function setActiveWallet(uid, walletId) {
  uid = String(uid);
  ensureUserRow(uid);
  db.prepare('UPDATE users SET active_wallet_id = ? WHERE uid = ?').run(walletId, uid);
}

export function getActiveWallet(uid) {
  uid = String(uid);
  const userRow = db.prepare('SELECT active_wallet_id FROM users WHERE uid = ?').get(uid);
  if (!userRow?.active_wallet_id) return null;
  const row = db.prepare('SELECT * FROM wallets WHERE id = ? AND uid = ?').get(userRow.active_wallet_id, uid);
  return walletRowToObj(row, true);
}

export function getWallet(uid, walletId) {
  const row = db.prepare('SELECT * FROM wallets WHERE id = ? AND uid = ?').get(walletId, String(uid));
  return walletRowToObj(row, true);
}

/**
 * Every user's currently-active wallet (uid + address only, no decrypted key).
 * Used by the low-balance poller in bot.js so it doesn't have to decrypt
 * every wallet's private key just to read a balance.
 */
export function getAllActiveWallets() {
  return db.prepare(`
    SELECT u.uid AS uid, w.id AS wallet_id, w.name AS name, w.address AS address
    FROM users u
    JOIN wallets w ON w.id = u.active_wallet_id
  `).all();
}

// ---------- Positions / PnL ----------
// Simple running-average cost basis per (wallet, token). entry_mcap tracks
// the token's market cap (USD) at the time of entry, weighted by ETH spent
// across buys (same weighting model as cost_eth). It is NOT adjusted on
// sells — it represents "what mcap you got in at", not a live figure.

/**
 * @param {number|null} mcapUsd - token's market cap (USD) at the moment of
 *   this trade. Pass null if unavailable (e.g. price feed down) — entry_mcap
 *   will simply stay whatever it was (or remain null on a fresh position).
 */
export function recordTrade(uid, walletId, tokenAddress, side, tokenAmount, ethAmount, mcapUsd = null) {
  uid = String(uid);
  const key = tokenAddress.toLowerCase();
  const existing = db.prepare(
    'SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND token_address = ?'
  ).get(uid, walletId, key);

  let pos = existing
    ? { token_amount: existing.token_amount, cost_eth: existing.cost_eth, entry_mcap: existing.entry_mcap }
    : { token_amount: 0, cost_eth: 0, entry_mcap: null };

  if (side === 'buy') {
    if (mcapUsd != null) {
      if (pos.cost_eth > 0 && pos.entry_mcap != null) {
        // Weighted average entry mcap, weighted by ETH spent (mirrors cost basis math).
        pos.entry_mcap = (pos.entry_mcap * pos.cost_eth + mcapUsd * ethAmount) / (pos.cost_eth + ethAmount);
      } else {
        pos.entry_mcap = mcapUsd;
      }
    }
    pos.token_amount += tokenAmount;
    pos.cost_eth += ethAmount;
  } else {
    const fraction = pos.token_amount > 0 ? Math.min(tokenAmount / pos.token_amount, 1) : 0;
    pos.cost_eth -= pos.cost_eth * fraction;
    pos.token_amount = Math.max(pos.token_amount - tokenAmount, 0);
    if (pos.token_amount <= 0) pos.entry_mcap = null; // position closed — clear entry mcap
  }

  db.prepare(`
    INSERT INTO positions (uid, wallet_id, token_address, token_amount, cost_eth, entry_mcap)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid, wallet_id, token_address) DO UPDATE SET
      token_amount = excluded.token_amount,
      cost_eth = excluded.cost_eth,
      entry_mcap = excluded.entry_mcap
  `).run(uid, walletId, key, pos.token_amount, pos.cost_eth, pos.entry_mcap);

  // ethAmount is always the ETH-side value of the trade (spent on buy, received on sell)
  db.prepare(`
    INSERT INTO trade_log (uid, wallet_id, token_address, side, eth_amount, mcap_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uid, walletId, key, side, ethAmount, mcapUsd, Date.now());
}

export function getPosition(uid, walletId, tokenAddress) {
  const row = db.prepare(
    'SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND token_address = ?'
  ).get(String(uid), walletId, tokenAddress.toLowerCase());
  if (!row) return null;
  return {
    walletId: row.wallet_id,
    tokenAddress: row.token_address,
    tokenAmount: row.token_amount,
    costEth: row.cost_eth,
    entryMcap: row.entry_mcap,
  };
}

export function getAllPositions(uid, walletId) {
  const rows = db.prepare(
    'SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND token_amount > 0'
  ).all(String(uid), walletId);
  return rows.map((row) => ({
    walletId: row.wallet_id,
    tokenAddress: row.token_address,
    tokenAmount: row.token_amount,
    costEth: row.cost_eth,
    entryMcap: row.entry_mcap,
  }));
}

/**
 * All open positions for a user across EVERY wallet they own (not just the
 * active one) — used for the portfolio-wide PnL summary. Joins in wallet
 * name so the caller can group/label by wallet without a second query.
 */
export function getAllPositionsForUser(uid) {
  const rows = db.prepare(`
    SELECT p.*, w.name AS wallet_name, w.address AS wallet_address
    FROM positions p
    JOIN wallets w ON w.id = p.wallet_id
    WHERE p.uid = ? AND p.token_amount > 0
  `).all(String(uid));
  return rows.map((row) => ({
    walletId: row.wallet_id,
    walletName: row.wallet_name,
    walletAddress: row.wallet_address,
    tokenAddress: row.token_address,
    tokenAmount: row.token_amount,
    costEth: row.cost_eth,
    entryMcap: row.entry_mcap,
  }));
}

/**
 * Realized PnL for a (uid, wallet, token) from the full trade_log history —
 * used for /flex on CLOSED positions, where the live `positions` row has
 * token_amount = 0 and entry_mcap cleared (recordTrade wipes it on close),
 * so there's nothing left to compute unrealized PnL from. This instead sums
 * every buy/sell ever logged for that pair.
 *
 * entryMcap/exitMcap are the mcap_usd of the FIRST buy and LAST sell with a
 * non-null mcap_usd respectively (display only, not used in the PnL math).
 * Returns null if there's no trade history at all for this pair.
 */
export function getRealizedPnl(uid, walletId, tokenAddress) {
  const key = tokenAddress.toLowerCase();
  const rows = db.prepare(`
    SELECT side, eth_amount, mcap_usd, created_at
    FROM trade_log
    WHERE uid = ? AND wallet_id = ? AND token_address = ?
    ORDER BY created_at ASC
  `).all(String(uid), walletId, key);

  if (rows.length === 0) return null;

  let totalBuyEth = 0;
  let totalSellEth = 0;
  let entryMcap = null;
  let exitMcap = null;

  for (const row of rows) {
    if (row.side === 'buy') {
      totalBuyEth += row.eth_amount;
      if (entryMcap === null && row.mcap_usd != null) entryMcap = row.mcap_usd;
    } else {
      totalSellEth += row.eth_amount;
      if (row.mcap_usd != null) exitMcap = row.mcap_usd; // last non-null sell mcap wins
    }
  }

  return { totalBuyEth, totalSellEth, entryMcap, exitMcap };
}

// ---------- Settings ----------

export function getSettings(uid) {
  uid = String(uid);
  ensureUserRow(uid);
  const row = db.prepare('SELECT settings FROM users WHERE uid = ?').get(uid);
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.settings || '{}')) };
}

export function updateSettings(uid, patch) {
  uid = String(uid);
  ensureUserRow(uid);
  const current = getSettings(uid);
  const merged = { ...current, ...patch };
  db.prepare('UPDATE users SET settings = ? WHERE uid = ?').run(JSON.stringify(merged), uid);
  return merged;
}

// ---------- Pending trades (crash recovery) ----------
// A row is written BEFORE a tx is submitted, updated after send, and finalized
// after confirmation. Anything left "pending" or "submitted" after a restart
// means the bot doesn't know if that trade succeeded — surfaced via
// getStuckPendingTrades() so it can be reconciled manually.

export function createPendingTrade({ uid, walletId, tokenAddress, side, amount }) {
  const id = `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO pending_trades (id, uid, wallet_id, token_address, side, amount, status, tx_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
  `).run(id, String(uid), walletId, tokenAddress, side, amount, now, now);
  return id;
}

export function markPendingTradeSubmitted(id, txHash) {
  db.prepare('UPDATE pending_trades SET status = ?, tx_hash = ?, updated_at = ? WHERE id = ?')
    .run('submitted', txHash, Date.now(), id);
}

export function markPendingTradeDone(id, status) {
  // status: 'confirmed' | 'failed'
  db.prepare('UPDATE pending_trades SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
}

/** Trades left in 'pending' or 'submitted' from before the last restart. */
export function getStuckPendingTrades() {
  return db.prepare(`SELECT * FROM pending_trades WHERE status IN ('pending', 'submitted') ORDER BY created_at ASC`).all();
}

// ---------- Pending bridges (cross-chain, async) ----------
// Unlike trades, a bridge can take minutes to settle on the destination chain,
// so the flow is: create row -> mark submitted (source tx confirmed) ->
// background poller checks LI.FI status periodically -> mark done/failed.
// Anything left 'pending' or 'submitted' after a restart needs re-polling,
// same crash-recovery shape as pending_trades.

export function createPendingBridge({ uid, walletId, direction, amountEth, fromChain, toChain, bridgeTool }) {
  const id = `pb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO pending_bridges
      (id, uid, wallet_id, direction, amount_eth, bridge_tool, from_chain, to_chain, source_tx_hash, dest_tx_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, ?)
  `).run(id, String(uid), walletId, direction, amountEth, bridgeTool || null, fromChain, toChain, now, now);
  return id;
}

export function markPendingBridgeSubmitted(id, sourceTxHash) {
  db.prepare('UPDATE pending_bridges SET status = ?, source_tx_hash = ?, updated_at = ? WHERE id = ?')
    .run('submitted', sourceTxHash, Date.now(), id);
}

export function markPendingBridgeDone(id, status, destTxHash) {
  // status: 'done' | 'failed'
  db.prepare('UPDATE pending_bridges SET status = ?, dest_tx_hash = ?, updated_at = ? WHERE id = ?')
    .run(status, destTxHash || null, Date.now(), id);
}

export function getPendingBridge(id) {
  return db.prepare('SELECT * FROM pending_bridges WHERE id = ?').get(id);
}

/** Bridges still in flight — polled periodically by the background worker in bot.js. */
export function getInFlightBridges() {
  return db.prepare(`SELECT * FROM pending_bridges WHERE status IN ('pending', 'submitted') ORDER BY created_at ASC`).all();
}

export function getBridgeHistory(uid, limit = 10) {
  return db.prepare('SELECT * FROM pending_bridges WHERE uid = ? ORDER BY created_at DESC LIMIT ?')
    .all(String(uid), limit);
}

// ---------- Auto-trade rules (take-profit / stop-loss) ----------
// One active rule per (uid, wallet, token) at a time — creating a new one
// implicitly supersedes any prior active rule for the same position (see
// bot.js, which cancels the old one before inserting). status transitions:
// active -> triggered (fired successfully or position gone) | cancelled (user action).

export function createAutoRule({ uid, walletId, tokenAddress, tpPct, slPct }) {
  const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO auto_rules (id, uid, wallet_id, token_address, tp_pct, sl_pct, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, String(uid), walletId, tokenAddress.toLowerCase(), tpPct ?? null, slPct ?? null, now, now);
  return id;
}

export function cancelAutoRule(uid, id) {
  db.prepare(`UPDATE auto_rules SET status = 'cancelled', updated_at = ? WHERE id = ? AND uid = ?`)
    .run(Date.now(), id, String(uid));
}

export function markAutoRuleTriggered(id) {
  db.prepare(`UPDATE auto_rules SET status = 'triggered', updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

/** All active rules across all users — polled periodically by bot.js. */
export function getActiveAutoRules() {
  return db.prepare(`SELECT * FROM auto_rules WHERE status = 'active'`).all();
}

export function getActiveAutoRuleForPosition(uid, walletId, tokenAddress) {
  return db.prepare(`
    SELECT * FROM auto_rules WHERE uid = ? AND wallet_id = ? AND token_address = ? AND status = 'active'
  `).get(String(uid), walletId, tokenAddress.toLowerCase());
}

export function getActiveAutoRulesForUser(uid) {
  return db.prepare(`SELECT * FROM auto_rules WHERE uid = ? AND status = 'active' ORDER BY created_at DESC`)
    .all(String(uid));
}

// ---------- Limit orders ----------
// trigger_price is a USD price (per token) — this is what the background
// poller actually compares against live market data. target_mcap is the
// user-facing figure they typed in (e.g. "50k") and is stored purely for
// display in the order list / confirmations; it's derived to trigger_price
// at creation time via mcapToPrice() in format.js.
// side='buy' fires when market price drops to or below trigger_price;
// side='sell' fires when it rises to or above it.
// amount is an ETH amount for buy orders, a token amount for sell orders.

export function createLimitOrder({ uid, walletId, tokenAddress, side, triggerPrice, amount, targetMcap = null }) {
  const id = `lo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO limit_orders (id, uid, wallet_id, token_address, side, trigger_price, target_mcap, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(id, String(uid), walletId, tokenAddress.toLowerCase(), side, triggerPrice, targetMcap, amount, now, now);
  return id;
}

export function cancelLimitOrder(uid, id) {
  const result = db.prepare(`UPDATE limit_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND uid = ? AND status = 'open'`)
    .run(Date.now(), id, String(uid));
  return result.changes > 0;
}

export function markLimitOrderDone(id, status) {
  // status: 'filled' | 'cancelled' | 'failed'
  db.prepare(`UPDATE limit_orders SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
}

/** All open orders across all users — polled periodically by bot.js. */
export function getOpenLimitOrders() {
  return db.prepare(`SELECT * FROM limit_orders WHERE status = 'open'`).all();
}

export function getOpenLimitOrdersForUser(uid) {
  return db.prepare(`SELECT * FROM limit_orders WHERE uid = ? AND status = 'open' ORDER BY created_at DESC`)
    .all(String(uid));
}

export function getLimitOrder(uid, id) {
  return db.prepare(`SELECT * FROM limit_orders WHERE id = ? AND uid = ?`).get(id, String(uid));
}

// ---------- Admin stats ----------

export function getStats() {
  const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const totalWallets = db.prepare('SELECT COUNT(*) c FROM wallets').get().c;
  const totalTrades = db.prepare('SELECT COUNT(*) c FROM trade_log').get().c;
  const totalVolumeEth = db.prepare('SELECT COALESCE(SUM(eth_amount), 0) v FROM trade_log').get().v;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const activeUsers24h = db.prepare('SELECT COUNT(DISTINCT uid) c FROM trade_log WHERE created_at > ?').get(dayAgo).c;
  const volume24hEth = db.prepare('SELECT COALESCE(SUM(eth_amount), 0) v FROM trade_log WHERE created_at > ?').get(dayAgo).v;
  const openPositions = db.prepare('SELECT COUNT(*) c FROM positions WHERE token_amount > 0').get().c;
  const totalReferrals = db.prepare('SELECT COUNT(*) c FROM referrals').get().c;
  const totalBridges = db.prepare('SELECT COUNT(*) c FROM pending_bridges').get().c;
  const totalBridgeVolumeEth = db.prepare("SELECT COALESCE(SUM(amount_eth), 0) v FROM pending_bridges WHERE status = 'done'").get().v;
  const activeAutoRules = db.prepare(`SELECT COUNT(*) c FROM auto_rules WHERE status = 'active'`).get().c;
  const openLimitOrders = db.prepare(`SELECT COUNT(*) c FROM limit_orders WHERE status = 'open'`).get().c;
  return {
    totalUsers, totalWallets, totalTrades, totalVolumeEth, activeUsers24h, volume24hEth,
    openPositions, totalReferrals, totalBridges, totalBridgeVolumeEth, activeAutoRules, openLimitOrders,
  };
}

// ---------- Terms of use ----------

export function hasAgreedTerms(uid) {
  return !!getSettings(uid).agreedTerms;
}

export function setAgreedTerms(uid) {
  updateSettings(uid, { agreedTerms: true });
}

// ---------- Rewards / Referrals ----------
// Ticket count = number of successful referrals. A referred user can only ever
// be attributed to ONE referrer (first one wins), preventing re-invite farming.
// referral_code is stored in the user's settings JSON to avoid a schema bump;
// if the user base grows large, move it to its own indexed table.

function genReferralCode() {
  // Pure random bytes — NOT derived from uid. A uid-prefixed string truncated
  // to a short slice can cut off before the random part is even encoded,
  // causing deterministic collisions between users with a shared uid prefix.
  return crypto.randomBytes(6).toString('base64url'); // 8 chars, ~48 bits of entropy
}

/** referral_code is a real, uniquely-indexed column — O(1) lookups either direction. */
export function getOrCreateReferralCode(uid) {
  uid = String(uid);
  ensureUserRow(uid);
  const existing = db.prepare('SELECT referral_code FROM users WHERE uid = ?').get(uid);
  if (existing.referral_code) return existing.referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genReferralCode();
    try {
      db.prepare('UPDATE users SET referral_code = ? WHERE uid = ?').run(code, uid);
      return code;
    } catch (err) {
      if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err; // collision, retry with a new random code
    }
  }
  throw new Error('Failed to generate a unique referral code after 5 attempts');
}

export function findUidByReferralCode(code) {
  const row = db.prepare('SELECT uid FROM users WHERE referral_code = ?').get(code);
  return row ? row.uid : null;
}

/**
 * Records a referral. Call once, on a brand-new user's first /start with a ref payload.
 * Returns true if recorded, false if this user was already referred (or self-referral).
 */
export function recordReferral(referrerUid, referredUid) {
  referrerUid = String(referrerUid);
  referredUid = String(referredUid);
  if (referrerUid === referredUid) return false;
  try {
    db.prepare(`
      INSERT INTO referrals (referrer_uid, referred_uid, created_at)
      VALUES (?, ?, ?)
    `).run(referrerUid, referredUid, Date.now());
    return true;
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return false; // already referred by someone else
    }
    throw err;
  }
}

export function getTicketCount(uid) {
  const row = db.prepare('SELECT COUNT(*) c FROM referrals WHERE referrer_uid = ?').get(String(uid));
  return row.c;
}

export function hasBeenReferred(uid) {
  const row = db.prepare('SELECT 1 FROM referrals WHERE referred_uid = ?').get(String(uid));
  return !!row;
}
