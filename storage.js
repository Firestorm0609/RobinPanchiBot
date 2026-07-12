import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { encrypt, decrypt } from './crypto.js';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'panchi.sqlite');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  active_wallet_id TEXT,
  active_chain TEXT NOT NULL DEFAULT 'robinhood',
  settings TEXT
);
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  private_key TEXT NOT NULL,
  sol_address TEXT,
  sol_private_key TEXT
);
CREATE TABLE IF NOT EXISTS positions (
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_amount REAL NOT NULL,
  cost_usdc REAL NOT NULL,
  entry_mcap REAL,
  PRIMARY KEY (uid, wallet_id, chain, token_address)
);
CREATE TABLE IF NOT EXISTS pending_trades (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  chain TEXT NOT NULL,
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
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  usdc_amount REAL NOT NULL,
  mcap_usd REAL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_uid TEXT NOT NULL,
  referred_uid TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auto_rules (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  tp_pct REAL,
  sl_pct REAL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS limit_orders (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  trigger_price REAL NOT NULL,
  target_mcap REAL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallets_uid ON wallets(uid);
CREATE INDEX IF NOT EXISTS idx_positions_uid_wallet_chain ON positions(uid, wallet_id, chain);
CREATE INDEX IF NOT EXISTS idx_trade_log_created ON trade_log(created_at);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_uid);
CREATE INDEX IF NOT EXISTS idx_auto_rules_status ON auto_rules(status);
CREATE INDEX IF NOT EXISTS idx_auto_rules_uid ON auto_rules(uid);
CREATE INDEX IF NOT EXISTS idx_limit_orders_status ON limit_orders(status);
CREATE INDEX IF NOT EXISTS idx_limit_orders_uid ON limit_orders(uid);
CREATE INDEX IF NOT EXISTS idx_trade_log_uid_wallet_chain_token ON trade_log(uid, wallet_id, chain, token_address);
`);

// ---------------------------------------------------------------------------
// Migrations. Each is idempotent (checks PRAGMA table_info before altering)
// so this file can be dropped into an existing single-chain (Robinhood-only)
// deployment safely.
// ---------------------------------------------------------------------------

function columnsOf(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// users.active_chain
if (!columnsOf('users').includes('active_chain')) {
  db.exec("ALTER TABLE users ADD COLUMN active_chain TEXT NOT NULL DEFAULT 'robinhood'");
}

// wallets: add Solana columns
const walletCols = columnsOf('wallets');
if (!walletCols.includes('sol_address')) db.exec('ALTER TABLE wallets ADD COLUMN sol_address TEXT');
if (!walletCols.includes('sol_private_key')) db.exec('ALTER TABLE wallets ADD COLUMN sol_private_key TEXT');

// positions / pending_trades / trade_log / auto_rules / limit_orders: add `chain`
// column, defaulting existing rows to 'robinhood' (every trade before this
// migration ran was on Robinhood Chain by definition — this was a
// single-chain bot until now).
//
// KNOWN LIMITATION: SQLite's ALTER TABLE cannot change a PRIMARY KEY. On a
// fresh install the tables above are created with `chain` already part of
// the composite key. On an EXISTING database, the old (uid, wallet_id,
// token_address) primary key on `positions` remains in effect even after
// this migration adds the `chain` column — meaning if the exact same token
// contract address exists on two different chains (rare, but Solana mint
// addresses vs EVM addresses can't collide, so realistically this only
// matters between two EVM chains), the ON CONFLICT upsert in recordTrade()
// could clobber the wrong chain's row. If you're migrating a live database,
// run a one-off script to rebuild `positions` with the new composite key
// before deploying, or accept this edge case until then.
for (const table of ['positions', 'pending_trades', 'trade_log', 'auto_rules', 'limit_orders']) {
  if (!columnsOf(table).includes('chain')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN chain TEXT NOT NULL DEFAULT 'robinhood'`);
  }
}

// Migration: referral_code column (unchanged from prior version)
const userCols = columnsOf('users');
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

if (!columnsOf('positions').includes('entry_mcap')) {
  db.exec('ALTER TABLE positions ADD COLUMN entry_mcap REAL');
}
if (!columnsOf('limit_orders').includes('target_mcap')) {
  db.exec('ALTER TABLE limit_orders ADD COLUMN target_mcap REAL');
}

const DEFAULT_SETTINGS = {
  buyPresetsUsdc: [10, 50, 100],
  sellPresetsPct: [25, 50, 100],
  slippageBps: 100,
  confirmTrades: true,
  maxBuyUsdc: 1000,
  gasTier: 'normal',
  autoTradeEnabled: false,
  lowBalanceThresholdEth: 0.01,
  flexPnlMode: 'usdc',
};

function ensureUserRow(uid) {
  const row = db.prepare('SELECT uid FROM users WHERE uid = ?').get(String(uid));
  if (!row) {
    db.prepare("INSERT INTO users (uid, active_wallet_id, active_chain, settings) VALUES (?, NULL, 'robinhood', ?)")
      .run(String(uid), JSON.stringify({}));
  }
}

function walletRowToObj(row, includeDecryptedKeys) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    address: row.address, // EVM address
    privateKey: includeDecryptedKeys ? decrypt(row.private_key) : undefined,
    solAddress: row.sol_address || null,
    solPrivateKey: includeDecryptedKeys && row.sol_private_key ? decrypt(row.sol_private_key) : undefined,
  };
}

export function getUser(uid) {
  uid = String(uid);
  ensureUserRow(uid);
  const userRow = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  const wallets = db.prepare('SELECT id, name, address, sol_address FROM wallets WHERE uid = ?').all(uid)
    .map((w) => ({ id: w.id, name: w.name, address: w.address, solAddress: w.sol_address || null }));
  return { wallets, activeWalletId: userRow.active_wallet_id, activeChain: userRow.active_chain };
}

/** wallet must include { name, evmAddress, evmPrivateKey, solAddress, solPrivateKey } — see wallet.js. */
export function addWallet(uid, wallet) {
  uid = String(uid);
  ensureUserRow(uid);
  const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO wallets (id, uid, name, address, private_key, sol_address, sol_private_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, uid, wallet.name,
    wallet.evmAddress, encrypt(wallet.evmPrivateKey),
    wallet.solAddress || null, wallet.solPrivateKey ? encrypt(wallet.solPrivateKey) : null
  );

  const userRow = db.prepare('SELECT active_wallet_id FROM users WHERE uid = ?').get(uid);
  if (!userRow.active_wallet_id) {
    db.prepare('UPDATE users SET active_wallet_id = ? WHERE uid = ?').run(id, uid);
  }
  return {
    id, name: wallet.name,
    address: wallet.evmAddress, privateKey: wallet.evmPrivateKey,
    solAddress: wallet.solAddress, solPrivateKey: wallet.solPrivateKey,
  };
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

// ---------------------------------------------------------------------------
// Active chain — which chain the user is currently trading on. Persisted per
// user (not per wallet) since the same wallet trades on all of them.
// ---------------------------------------------------------------------------

export function getActiveChain(uid) {
  uid = String(uid);
  ensureUserRow(uid);
  const row = db.prepare('SELECT active_chain FROM users WHERE uid = ?').get(uid);
  return row.active_chain || 'robinhood';
}

export function setActiveChain(uid, chainKey) {
  uid = String(uid);
  ensureUserRow(uid);
  db.prepare('UPDATE users SET active_chain = ? WHERE uid = ?').run(chainKey, uid);
}

export function getAllActiveWallets() {
  return db.prepare(`
    SELECT u.uid AS uid, u.active_chain AS chain, w.id AS wallet_id, w.name AS name,
           w.address AS address, w.sol_address AS sol_address
    FROM users u
    JOIN wallets w ON w.id = u.active_wallet_id
  `).all();
}

// ---------------------------------------------------------------------------
// Positions / PnL — now scoped per chain. Same token address on two
// different EVM chains (or an EVM address vs a Solana mint, which never
// collide) are tracked as fully separate positions, since they're
// economically unrelated tokens.
// ---------------------------------------------------------------------------

export function recordTrade(uid, walletId, chain, tokenAddress, side, tokenAmount, usdcAmount, mcapUsd = null) {
  uid = String(uid);
  const key = chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase();
  const existing = db.prepare(
    'SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND chain = ? AND token_address = ?'
  ).get(uid, walletId, chain, key);

  let pos = existing
    ? { token_amount: existing.token_amount, cost_usdc: existing.cost_usdc, entry_mcap: existing.entry_mcap }
    : { token_amount: 0, cost_usdc: 0, entry_mcap: null };

  if (side === 'buy') {
    if (mcapUsd != null) {
      if (pos.cost_usdc > 0 && pos.entry_mcap != null) {
        pos.entry_mcap = (pos.entry_mcap * pos.cost_usdc + mcapUsd * usdcAmount) / (pos.cost_usdc + usdcAmount);
      } else {
        pos.entry_mcap = mcapUsd;
      }
    }
    pos.token_amount += tokenAmount;
    pos.cost_usdc += usdcAmount;
  } else {
    const fraction = pos.token_amount > 0 ? Math.min(tokenAmount / pos.token_amount, 1) : 0;
    pos.cost_usdc -= pos.cost_usdc * fraction;
    pos.token_amount = Math.max(pos.token_amount - tokenAmount, 0);
    if (pos.token_amount <= 0) pos.entry_mcap = null;
  }

  db.prepare(`
    INSERT INTO positions (uid, wallet_id, chain, token_address, token_amount, cost_usdc, entry_mcap)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid, wallet_id, chain, token_address) DO UPDATE SET
      token_amount = excluded.token_amount,
      cost_usdc = excluded.cost_usdc,
      entry_mcap = excluded.entry_mcap
  `).run(uid, walletId, chain, key, pos.token_amount, pos.cost_usdc, pos.entry_mcap);

  db.prepare(`
    INSERT INTO trade_log (uid, wallet_id, chain, token_address, side, usdc_amount, mcap_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uid, walletId, chain, key, side, usdcAmount, mcapUsd, Date.now());
}

export function getPosition(uid, walletId, chain, tokenAddress) {
  const key = chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase();
  const row = db.prepare(
    'SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND chain = ? AND token_address = ?'
  ).get(String(uid), walletId, chain, key);
  if (!row) return null;
  return {
    walletId: row.wallet_id,
    chain: row.chain,
    tokenAddress: row.token_address,
    tokenAmount: row.token_amount,
    costUsdc: row.cost_usdc,
    entryMcap: row.entry_mcap,
  };
}

export function getAllPositions(uid, walletId, chain = null) {
  const rows = chain
    ? db.prepare('SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND chain = ? AND token_amount > 0').all(String(uid), walletId, chain)
    : db.prepare('SELECT * FROM positions WHERE uid = ? AND wallet_id = ? AND token_amount > 0').all(String(uid), walletId);
  return rows.map((row) => ({
    walletId: row.wallet_id,
    chain: row.chain,
    tokenAddress: row.token_address,
    tokenAmount: row.token_amount,
    costUsdc: row.cost_usdc,
    entryMcap: row.entry_mcap,
  }));
}

/** All open positions for a user across EVERY wallet AND every chain. */
export function getAllPositionsForUser(uid) {
  const rows = db.prepare(`
    SELECT p.*, w.name AS wallet_name, w.address AS wallet_address, w.sol_address AS wallet_sol_address
    FROM positions p
    JOIN wallets w ON w.id = p.wallet_id
    WHERE p.uid = ? AND p.token_amount > 0
  `).all(String(uid));
  return rows.map((row) => ({
    walletId: row.wallet_id,
    walletName: row.wallet_name,
    walletAddress: row.chain === 'solana' ? row.wallet_sol_address : row.wallet_address,
    chain: row.chain,
    tokenAddress: row.token_address,
    tokenAmount: row.token_amount,
    costUsdc: row.cost_usdc,
    entryMcap: row.entry_mcap,
  }));
}

export function getRealizedPnl(uid, walletId, chain, tokenAddress) {
  const key = chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase();
  const rows = db.prepare(`
    SELECT side, usdc_amount, mcap_usd, created_at
    FROM trade_log
    WHERE uid = ? AND wallet_id = ? AND chain = ? AND token_address = ?
    ORDER BY created_at ASC
  `).all(String(uid), walletId, chain, key);

  if (rows.length === 0) return null;

  let totalBuyUsdc = 0, totalSellUsdc = 0, entryMcap = null, exitMcap = null;
  for (const row of rows) {
    if (row.side === 'buy') {
      totalBuyUsdc += row.usdc_amount;
      if (entryMcap === null && row.mcap_usd != null) entryMcap = row.mcap_usd;
    } else {
      totalSellUsdc += row.usdc_amount;
      if (row.mcap_usd != null) exitMcap = row.mcap_usd;
    }
  }
  return { totalBuyUsdc, totalSellUsdc, entryMcap, exitMcap };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pending trades (crash recovery) — now chain-scoped
// ---------------------------------------------------------------------------

export function createPendingTrade({ uid, walletId, chain, tokenAddress, side, amount }) {
  const id = `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO pending_trades (id, uid, wallet_id, chain, token_address, side, amount, status, tx_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
  `).run(id, String(uid), walletId, chain, tokenAddress, side, amount, now, now);
  return id;
}

export function markPendingTradeSubmitted(id, txHash) {
  db.prepare('UPDATE pending_trades SET status = ?, tx_hash = ?, updated_at = ? WHERE id = ?')
    .run('submitted', txHash, Date.now(), id);
}

export function markPendingTradeDone(id, status) {
  db.prepare('UPDATE pending_trades SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
}

export function getStuckPendingTrades() {
  return db.prepare(`SELECT * FROM pending_trades WHERE status IN ('pending', 'submitted') ORDER BY created_at ASC`).all();
}

// ---------------------------------------------------------------------------
// Auto-trade rules (TP/SL) — chain-scoped
// ---------------------------------------------------------------------------

export function createAutoRule({ uid, walletId, chain, tokenAddress, tpPct, slPct }) {
  const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const key = chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase();
  db.prepare(`
    INSERT INTO auto_rules (id, uid, wallet_id, chain, token_address, tp_pct, sl_pct, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, String(uid), walletId, chain, key, tpPct ?? null, slPct ?? null, now, now);
  return id;
}

export function cancelAutoRule(uid, id) {
  db.prepare(`UPDATE auto_rules SET status = 'cancelled', updated_at = ? WHERE id = ? AND uid = ?`)
    .run(Date.now(), id, String(uid));
}

export function markAutoRuleTriggered(id) {
  db.prepare(`UPDATE auto_rules SET status = 'triggered', updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function getActiveAutoRules() {
  return db.prepare(`SELECT * FROM auto_rules WHERE status = 'active'`).all();
}

export function getActiveAutoRuleForPosition(uid, walletId, chain, tokenAddress) {
  const key = chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase();
  return db.prepare(`
    SELECT * FROM auto_rules WHERE uid = ? AND wallet_id = ? AND chain = ? AND token_address = ? AND status = 'active'
  `).get(String(uid), walletId, chain, key);
}

export function getActiveAutoRulesForUser(uid) {
  return db.prepare(`SELECT * FROM auto_rules WHERE uid = ? AND status = 'active' ORDER BY created_at DESC`)
    .all(String(uid));
}

// ---------------------------------------------------------------------------
// Limit orders — chain-scoped
// ---------------------------------------------------------------------------

export function createLimitOrder({ uid, walletId, chain, tokenAddress, side, triggerPrice, amount, targetMcap = null }) {
  const id = `lo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const key = chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase();
  db.prepare(`
    INSERT INTO limit_orders (id, uid, wallet_id, chain, token_address, side, trigger_price, target_mcap, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(id, String(uid), walletId, chain, key, side, triggerPrice, targetMcap, amount, now, now);
  return id;
}

export function cancelLimitOrder(uid, id) {
  const result = db.prepare(`UPDATE limit_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND uid = ? AND status = 'open'`)
    .run(Date.now(), id, String(uid));
  return result.changes > 0;
}

export function markLimitOrderDone(id, status) {
  db.prepare(`UPDATE limit_orders SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
}

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

// ---------------------------------------------------------------------------
// Admin stats
// ---------------------------------------------------------------------------

export function getStats() {
  const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const totalWallets = db.prepare('SELECT COUNT(*) c FROM wallets').get().c;
  const totalTrades = db.prepare('SELECT COUNT(*) c FROM trade_log').get().c;
  const totalVolumeUsdc = db.prepare('SELECT COALESCE(SUM(usdc_amount), 0) v FROM trade_log').get().v;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const activeUsers24h = db.prepare('SELECT COUNT(DISTINCT uid) c FROM trade_log WHERE created_at > ?').get(dayAgo).c;
  const volume24hUsdc = db.prepare('SELECT COALESCE(SUM(usdc_amount), 0) v FROM trade_log WHERE created_at > ?').get(dayAgo).v;
  const openPositions = db.prepare('SELECT COUNT(*) c FROM positions WHERE token_amount > 0').get().c;
  const totalReferrals = db.prepare('SELECT COUNT(*) c FROM referrals').get().c;
  const activeAutoRules = db.prepare(`SELECT COUNT(*) c FROM auto_rules WHERE status = 'active'`).get().c;
  const openLimitOrders = db.prepare(`SELECT COUNT(*) c FROM limit_orders WHERE status = 'open'`).get().c;
  const volumeByChain = db.prepare(`
    SELECT chain, COALESCE(SUM(usdc_amount), 0) v, COUNT(*) c FROM trade_log GROUP BY chain
  `).all();
  return {
    totalUsers, totalWallets, totalTrades, totalVolumeUsdc, activeUsers24h, volume24hUsdc,
    openPositions, totalReferrals, activeAutoRules, openLimitOrders, volumeByChain,
  };
}

// ---------------------------------------------------------------------------
// Terms of use
// ---------------------------------------------------------------------------

export function hasAgreedTerms(uid) {
  return !!getSettings(uid).agreedTerms;
}

export function setAgreedTerms(uid) {
  updateSettings(uid, { agreedTerms: true });
}

// ---------------------------------------------------------------------------
// Rewards / Referrals (unchanged)
// ---------------------------------------------------------------------------

function genReferralCode() {
  return crypto.randomBytes(6).toString('base64url');
}

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
      if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    }
  }
  throw new Error('Failed to generate a unique referral code after 5 attempts');
}

export function findUidByReferralCode(code) {
  const row = db.prepare('SELECT uid FROM users WHERE referral_code = ?').get(code);
  return row ? row.uid : null;
}

export function recordReferral(referrerUid, referredUid) {
  referrerUid = String(referrerUid);
  referredUid = String(referredUid);
  if (referrerUid === referredUid) return false;
  try {
    db.prepare(`INSERT INTO referrals (referrer_uid, referred_uid, created_at) VALUES (?, ?, ?)`)
      .run(referrerUid, referredUid, Date.now());
    return true;
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
    throw err;
  }
}

export function getTicketCount(uid) {
  return db.prepare('SELECT COUNT(*) c FROM referrals WHERE referrer_uid = ?').get(String(uid)).c;
}

export function hasBeenReferred(uid) {
  return !!db.prepare('SELECT 1 FROM referrals WHERE referred_uid = ?').get(String(uid));
}
