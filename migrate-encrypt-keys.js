// Run once after adding MASTER_KEY to .env and deploying the new storage.js:
//   node migrate-encrypt-keys.js
// Safe to re-run: skips keys that are already encrypted (contain ':').
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { encrypt } from './crypto.js';

const DB_PATH = path.join(process.cwd(), 'data', 'db.json');

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
let changed = 0;

for (const uid of Object.keys(db.users || {})) {
  for (const w of db.users[uid].wallets || []) {
    const looksEncrypted = typeof w.privateKey === 'string' && w.privateKey.split(':').length === 3;
    if (!looksEncrypted) {
      w.privateKey = encrypt(w.privateKey);
      changed++;
    }
  }
}

fs.writeFileSync(DB_PATH + '.bak', fs.readFileSync(DB_PATH)); // backup before overwrite
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
console.log(`Encrypted ${changed} key(s). Backup saved to data/db.json.bak`);
