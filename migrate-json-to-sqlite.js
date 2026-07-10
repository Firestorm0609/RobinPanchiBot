// Run once after deploying the new SQLite-backed storage.js:
//   node migrate-json-to-sqlite.js
// Reads the old data/db.json (keys already encrypted if you ran
// migrate-encrypt-keys.js earlier) and copies everything into data/panchi.sqlite.
// Safe to re-run against an empty sqlite db; will error on duplicate primary keys
// if run twice against an already-migrated db (by design, to avoid double-importing).
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const JSON_PATH = path.join(process.cwd(), 'data', 'db.json');
const SQLITE_PATH = path.join(process.cwd(), 'data', 'panchi.sqlite');

if (!fs.existsSync(JSON_PATH)) {
  console.log('No data/db.json found — nothing to migrate.');
  process.exit(0);
}

const oldDb = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const db = new Database(SQLITE_PATH);
db.pragma('journal_mode = WAL');

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
`);

let userCount = 0, walletCount = 0, posCount = 0;

const insertUser = db.prepare('INSERT INTO users (uid, active_wallet_id, settings) VALUES (?, ?, ?)');
const insertWallet = db.prepare('INSERT INTO wallets (id, uid, name, address, private_key) VALUES (?, ?, ?, ?, ?)');
const insertPosition = db.prepare('INSERT INTO positions (uid, wallet_id, token_address, token_amount, cost_eth) VALUES (?, ?, ?, ?, ?)');

const migrate = db.transaction(() => {
  for (const [uid, user] of Object.entries(oldDb.users || {})) {
    insertUser.run(uid, user.activeWalletId ?? null, JSON.stringify(user.settings || {}));
    userCount++;

    for (const w of user.wallets || []) {
      // private_key is already encrypted ("iv:tag:cipher") if migrate-encrypt-keys.js ran first
      insertWallet.run(w.id, uid, w.name, w.address, w.privateKey);
      walletCount++;
    }

    for (const pos of Object.values(user.positions || {})) {
      if (pos.tokenAmount > 0) {
        insertPosition.run(uid, pos.walletId, pos.tokenAddress.toLowerCase(), pos.tokenAmount, pos.costEth);
        posCount++;
      }
    }
  }
});

migrate();

console.log(`Migrated ${userCount} user(s), ${walletCount} wallet(s), ${posCount} position(s) into data/panchi.sqlite`);
console.log('Once you\'ve confirmed the bot works against SQLite, you can archive data/db.json.');
