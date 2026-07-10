import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
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
CREATE INDEX IF NOT EXISTS idx_wallets_uid ON wallets(uid);
CREATE INDEX IF NOT EXISTS idx_positions_uid_wallet ON positions(uid, wallet_id);
`);

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
