// Fixes: "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
// constraint" on every buy/sell.
//
// Root cause: the `positions` table on this DB still has its ORIGINAL
// primary key — (uid, wallet_id, token_address), from before multichain
// support existed (either created that way by an old storage.js, or by
// migrate-json-to-sqlite.js). storage.js's later `ALTER TABLE positions
// ADD COLUMN chain ...` migration added the column but SQLite cannot alter
// an existing PRIMARY KEY, so the real constraint on disk never became
// (uid, wallet_id, chain, token_address) — which is what recordTrade()'s
// `INSERT ... ON CONFLICT(uid, wallet_id, chain, token_address)` requires.
//
// This script rebuilds `positions` with the correct composite primary key,
// copying every existing row over unchanged (chain defaults to 'robinhood'
// already via the old ALTER TABLE, so no data is lost or reinterpreted).
//
// Usage (run once, bot stopped or at least not actively trading):
//   node fix-positions-pk.js
//
// Safe to re-run: if the table already has the correct PK, it exits
// immediately without touching anything.

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'panchi.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function currentPositionsPk() {
  const cols = db.prepare('PRAGMA table_info(positions)').all();
  return cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}

const pk = currentPositionsPk();
const desired = ['uid', 'wallet_id', 'chain', 'token_address'];

if (JSON.stringify(pk) === JSON.stringify(desired)) {
  console.log('positions table already has the correct primary key — nothing to do.');
  process.exit(0);
}

console.log(`Current positions PK: (${pk.join(', ')}) — rebuilding to (${desired.join(', ')})...`);

const rebuild = db.transaction(() => {
  db.exec(`
    CREATE TABLE positions_new (
      uid TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_amount REAL NOT NULL,
      cost_usdc REAL NOT NULL,
      entry_mcap REAL,
      PRIMARY KEY (uid, wallet_id, chain, token_address)
    );
  `);

  // Copy rows, collapsing any accidental duplicates (same uid/wallet/chain/token
  // that could only have arisen from the bug itself clobbering a wrong row) by
  // summing amounts/cost — extremely unlikely to matter, but safe either way.
  const rows = db.prepare('SELECT * FROM positions').all();
  const insert = db.prepare(`
    INSERT INTO positions_new (uid, wallet_id, chain, token_address, token_amount, cost_usdc, entry_mcap)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid, wallet_id, chain, token_address) DO UPDATE SET
      token_amount = token_amount + excluded.token_amount,
      cost_usdc = cost_usdc + excluded.cost_usdc,
      entry_mcap = COALESCE(excluded.entry_mcap, entry_mcap)
  `);
  for (const r of rows) {
    insert.run(r.uid, r.wallet_id, r.chain || 'robinhood', r.token_address, r.token_amount, r.cost_usdc, r.entry_mcap);
  }

  db.exec('DROP TABLE positions;');
  db.exec('ALTER TABLE positions_new RENAME TO positions;');
  db.exec('CREATE INDEX IF NOT EXISTS idx_positions_uid_wallet_chain ON positions(uid, wallet_id, chain);');
});

rebuild();

console.log(`Done. Migrated ${db.prepare('SELECT COUNT(*) c FROM positions').get().c} position row(s).`);
console.log('Restart the bot now.');
