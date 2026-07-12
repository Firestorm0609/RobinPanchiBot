import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// storage.js resolves its DB path from process.cwd() at import time, so we
// run the whole file from a throwaway temp directory.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panchi-test-'));
process.chdir(tmpDir);
process.env.MASTER_KEY = 'b'.repeat(64);

const storage = await import('../storage.js');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('addWallet + getWallet round-trips a private key through encryption', () => {
  const uid = 'u1';
  const w = storage.addWallet(uid, { name: 'Main', evmAddress: '0xabc', evmPrivateKey: '0xdeadbeef' });
  const fetched = storage.getWallet(uid, w.id);
  assert.equal(fetched.privateKey, '0xdeadbeef');
});

test('recordTrade: buy then partial sell computes correct running cost basis', () => {
  const uid = 'u2';
  const w = storage.addWallet(uid, { name: 'W', evmAddress: '0x1', evmPrivateKey: '0xkey' });
  const token = '0xTokenAddress000000000000000000000000001';
  const chain = 'base';

  storage.recordTrade(uid, w.id, chain, token, 'buy', 100, 1.0); // 100 tokens for 1 USDC
  let pos = storage.getPosition(uid, w.id, chain, token);
  assert.equal(pos.tokenAmount, 100);
  assert.equal(pos.costUsdc, 1.0);

  storage.recordTrade(uid, w.id, chain, token, 'sell', 50, 0.6); // sell half the tokens
  pos = storage.getPosition(uid, w.id, chain, token);
  assert.equal(pos.tokenAmount, 50);
  assert.equal(pos.costUsdc, 0.5); // half the cost basis removed proportionally
});

test('recordTrade: selling more than held clamps at zero, not negative', () => {
  const uid = 'u3';
  const w = storage.addWallet(uid, { name: 'W', evmAddress: '0x2', evmPrivateKey: '0xkey' });
  const token = '0xTokenAddress000000000000000000000000002';
  const chain = 'base';

  storage.recordTrade(uid, w.id, chain, token, 'buy', 10, 1.0);
  storage.recordTrade(uid, w.id, chain, token, 'sell', 999, 5.0); // way more than held
  const pos = storage.getPosition(uid, w.id, chain, token);
  assert.equal(pos.tokenAmount, 0);
  assert.equal(pos.costUsdc, 0);
});

test('getOrCreateReferralCode is stable across calls and unique per user', () => {
  const code1a = storage.getOrCreateReferralCode('ref_user_1');
  const code1b = storage.getOrCreateReferralCode('ref_user_1');
  const code2 = storage.getOrCreateReferralCode('ref_user_2');
  assert.equal(code1a, code1b);
  assert.notEqual(code1a, code2);
});

test('findUidByReferralCode resolves a code back to its owner', () => {
  const code = storage.getOrCreateReferralCode('ref_user_3');
  assert.equal(storage.findUidByReferralCode(code), 'ref_user_3');
});

test('findUidByReferralCode returns null for an unknown code', () => {
  assert.equal(storage.findUidByReferralCode('not-a-real-code'), null);
});

test('recordReferral: first referral wins, self-referral blocked, no double-counting', () => {
  const referrer = 'referrer_1';
  const friend = 'friend_1';

  assert.equal(storage.recordReferral(referrer, friend), true);
  assert.equal(storage.getTicketCount(referrer), 1);

  // Same referred user cannot be attributed to a second referrer.
  assert.equal(storage.recordReferral('someone_else', friend), false);
  assert.equal(storage.getTicketCount(referrer), 1);
  assert.equal(storage.getTicketCount('someone_else'), 0);

  // Self-referral is rejected outright.
  assert.equal(storage.recordReferral('solo_user', 'solo_user'), false);
});

test('hasBeenReferred reflects referral state correctly', () => {
  assert.equal(storage.hasBeenReferred('never_referred'), false);
  storage.recordReferral('someone', 'was_referred');
  assert.equal(storage.hasBeenReferred('was_referred'), true);
});
