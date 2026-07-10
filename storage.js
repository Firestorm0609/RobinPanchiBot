import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'db.json');

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: {} }, null, 2));
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function getUser(uid) {
  const db = readDb();
  if (!db.users[uid]) {
    db.users[uid] = { wallets: [], activeWalletId: null };
    writeDb(db);
  }
  return db.users[uid];
}

export function addWallet(uid, wallet) {
  const db = readDb();
  const user = db.users[uid] || { wallets: [], activeWalletId: null };
  const entry = {
    id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: wallet.name,
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
  user.wallets.push(entry);
  if (!user.activeWalletId) user.activeWalletId = entry.id;
  db.users[uid] = user;
  writeDb(db);
  return entry;
}

export function removeWallet(uid, walletId) {
  const db = readDb();
  const user = db.users[uid];
  if (!user) return;
  user.wallets = user.wallets.filter((w) => w.id !== walletId);
  if (user.activeWalletId === walletId) {
    user.activeWalletId = user.wallets[0]?.id ?? null;
  }
  writeDb(db);
}

export function renameWallet(uid, walletId, newName) {
  const db = readDb();
  const user = db.users[uid];
  if (!user) return;
  const w = user.wallets.find((x) => x.id === walletId);
  if (w) w.name = newName;
  writeDb(db);
}

export function setActiveWallet(uid, walletId) {
  const db = readDb();
  const user = db.users[uid];
  if (!user) return;
  user.activeWalletId = walletId;
  writeDb(db);
}

export function getActiveWallet(uid) {
  const user = getUser(uid);
  return user.wallets.find((w) => w.id === user.activeWalletId) || null;
}

export function getWallet(uid, walletId) {
  const user = getUser(uid);
  return user.wallets.find((w) => w.id === walletId) || null;
}

// ---------- Positions / PnL ----------
// Simple running-average cost basis per (wallet, token).

export function recordTrade(uid, walletId, tokenAddress, side, tokenAmount, ethAmount) {
  const db = readDb();
  const user = db.users[uid];
  if (!user) return;
  if (!user.positions) user.positions = {};
  const key = `${walletId}_${tokenAddress.toLowerCase()}`;
  const pos = user.positions[key] || { walletId, tokenAddress, tokenAmount: 0, costEth: 0 };

  if (side === 'buy') {
    pos.tokenAmount += tokenAmount;
    pos.costEth += ethAmount;
  } else {
    // sell: reduce holdings and cost basis proportionally
    const fraction = pos.tokenAmount > 0 ? Math.min(tokenAmount / pos.tokenAmount, 1) : 0;
    pos.costEth -= pos.costEth * fraction;
    pos.tokenAmount = Math.max(pos.tokenAmount - tokenAmount, 0);
  }

  user.positions[key] = pos;
  db.users[uid] = user;
  writeDb(db);
}

export function getPosition(uid, walletId, tokenAddress) {
  const db = readDb();
  const user = db.users[uid];
  if (!user?.positions) return null;
  const key = `${walletId}_${tokenAddress.toLowerCase()}`;
  return user.positions[key] || null;
}

export function getAllPositions(uid, walletId) {
  const db = readDb();
  const user = db.users[uid];
  if (!user?.positions) return [];
  return Object.values(user.positions).filter((p) => p.walletId === walletId && p.tokenAmount > 0);
}

// ---------- Settings ----------

const DEFAULT_SETTINGS = {
  buyPresetsEth: [0.01, 0.05, 0.1],
  sellPresetsPct: [25, 50, 100],
  slippageBps: 100, // 1%
  confirmTrades: true,
};

export function getSettings(uid) {
  const db = readDb();
  const user = db.users[uid];
  if (!user) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(user.settings || {}) };
}

export function updateSettings(uid, patch) {
  const db = readDb();
  const user = db.users[uid] || { wallets: [], activeWalletId: null };
  user.settings = { ...DEFAULT_SETTINGS, ...(user.settings || {}), ...patch };
  db.users[uid] = user;
  writeDb(db);
  return user.settings;
}
