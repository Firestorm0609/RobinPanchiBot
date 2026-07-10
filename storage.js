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
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_uid TEXT NOT NULL,
  referred_uid TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallets_uid ON wallets(uid);
CREATE INDEX IF NOT EXISTS idx_positions_uid_wallet ON positions(uid, wallet_id);
CREATE INDEX IF NOT EXISTS idx_trade_log_created ON trade_log(created_at);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_uid);
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

const DEFAULT_SETTINGS = {
  buyPresetsEth: [0.01, 0.05, 0.1],
  sellPresetsPct: [25, 50, 100],
  slippageBps: 100, // 1%
  confirmTrades: true,
  maxBuyEth: 1,
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

// ---------- Positions / PnL ----------
// Simple running-average cost basis per (wallet, token).

export function recordTrade(uid, walletId, tokenAddress, side, tokenAmount, ethAmount) {
  uid = String(uid);
  const key = tokenAddress.toLowerCase();
  const existing = db.prepare(
    'SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND token_address = ?'
  ).get(uid, walletId, key);

  let pos = existing ? { token_amount: existing.token_amount, cost_eth: existing.cost_eth } : { token_amount: 0, cost_eth: 0 };

  if (side === 'buy') {
    pos.token_amount += tokenAmount;
    pos.cost_eth += ethAmount;
  } else {
    const fraction = pos.token_amount > 0 ? Math.min(tokenAmount / pos.token_amount, 1) : 0;
    pos.cost_eth -= pos.cost_eth * fraction;
    pos.token_amount = Math.max(pos.token_amount - tokenAmount, 0);
  }

  db.prepare(`
    INSERT INTO positions (uid, wallet_id, token_address, token_amount, cost_eth)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(uid, wallet_id, token_address) DO UPDATE SET token_amount = excluded.token_amount, cost_eth = excluded.cost_eth
  `).run(uid, walletId, key, pos.token_amount, pos.cost_eth);

  // ethAmount is always the ETH-side value of the trade (spent on buy, received on sell)
  db.prepare(`
    INSERT INTO trade_log (uid, wallet_id, token_address, side, eth_amount, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uid, walletId, key, side, ethAmount, Date.now());
}

export function getPosition(uid, walletId, tokenAddress) {
  const row = db.prepare(
    'SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND token_address = ?'
  ).get(String(uid), walletId, tokenAddress.toLowerCase());
  if (!row) return null;
  return { walletId: row.wallet_id, tokenAddress: row.token_address, tokenAmount: row.token_amount, costEth: row.cost_eth };
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
  }));
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
  return { totalUsers, totalWallets, totalTrades, totalVolumeEth, activeUsers24h, volume24hEth, openPositions, totalReferrals };
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
