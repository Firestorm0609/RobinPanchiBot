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
