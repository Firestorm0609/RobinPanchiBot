import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// storage.js resolves its DB path from process.cwd() at import time, so we
// run the whole file from a throwaway temp directory (same pattern as
// test/storage.test.js).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panchi-pt-test-'));
process.chdir(tmpDir);
process.env.MASTER_KEY = 'c'.repeat(64);

const storage = await import('../storage.js');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTrade(overrides = {}) {
  return storage.createPendingTrade({
    uid: 'u1',
    walletId: 'w1',
    chain: 'base',
    tokenAddress: '0xToken',
    side: 'buy',
    amount: 50,
    ...overrides,
  });
}

test('a fresh pending trade starts in "pending" and is bucketed as swapStuck', () => {
  makeTrade();
  const { bridgeStuck, swapStuck } = storage.getStuckPendingTradesByKind();
  assert.equal(bridgeStuck.length, 0);
  assert.ok(swapStuck.some((t) => t.status === 'pending'));
});

test('markPendingTradeBridging moves a trade into bridgeStuck with hash + source chain recorded', () => {
  const id = makeTrade();
  storage.markPendingTradeBridging(id, '0xSourceTxHash', 'arbitrum');

  const { bridgeStuck, swapStuck } = storage.getStuckPendingTradesByKind();
  const trade = bridgeStuck.find((t) => t.id === id);
  assert.ok(trade, 'trade should appear in bridgeStuck once status is "bridging"');
  assert.equal(trade.status, 'bridging');
  assert.equal(trade.bridge_hash, '0xSourceTxHash');
  assert.equal(trade.bridge_from_chain, 'arbitrum');
  assert.ok(!swapStuck.some((t) => t.id === id));
});

test('markPendingTradeBridged keeps the trade in bridgeStuck (not swapStuck) until swap resumes', () => {
  const id = makeTrade();
  storage.markPendingTradeBridging(id, '0xHash2', 'ethereum');
  storage.markPendingTradeBridged(id);

  const { bridgeStuck, swapStuck } = storage.getStuckPendingTradesByKind();
  const trade = bridgeStuck.find((t) => t.id === id);
  assert.ok(trade);
  assert.equal(trade.status, 'bridged');
  assert.ok(!swapStuck.some((t) => t.id === id));
});

test('markPendingTradeSwapping moves a bridged trade into swapStuck (bridge leg is done, swap is now the risk)', () => {
  const id = makeTrade();
  storage.markPendingTradeBridging(id, '0xHash3', 'bsc');
  storage.markPendingTradeBridged(id);
  storage.markPendingTradeSwapping(id);

  const { bridgeStuck, swapStuck } = storage.getStuckPendingTradesByKind();
  assert.ok(!bridgeStuck.some((t) => t.id === id));
  assert.ok(swapStuck.some((t) => t.id === id && t.status === 'swapping'));
});

test('markPendingTradeDone("confirmed") removes the trade from both stuck buckets', () => {
  const id = makeTrade();
  storage.markPendingTradeSwapping(id);
  storage.markPendingTradeSubmitted(id, '0xFinalHash');
  storage.markPendingTradeDone(id, 'confirmed');

  const { bridgeStuck, swapStuck } = storage.getStuckPendingTradesByKind();
  assert.ok(!bridgeStuck.some((t) => t.id === id));
  assert.ok(!swapStuck.some((t) => t.id === id));
});

test('a bridge TIMEOUT (left in "bridging") survives as resumable, distinct from an outright "failed" trade', () => {
  const timeoutId = makeTrade();
  storage.markPendingTradeBridging(timeoutId, '0xTimeoutHash', 'base');
  // caller leaves status as 'bridging' on timeout — simulated here directly,
  // matching bridgeShortfall()'s bridgeTimeout branch in trade-core.js.

  const failedId = makeTrade();
  storage.markPendingTradeDone(failedId, 'failed');

  const { bridgeStuck, swapStuck } = storage.getStuckPendingTradesByKind();
  assert.ok(bridgeStuck.some((t) => t.id === timeoutId));
  assert.ok(!swapStuck.some((t) => t.id === failedId));
  assert.ok(!bridgeStuck.some((t) => t.id === failedId));
});

test('same-chain trades (no bridge_hash) never appear in bridgeStuck regardless of how long they sit pending', () => {
  const id = makeTrade({ chain: 'robinhood' });
  const { bridgeStuck, swapStuck } = storage.getStuckPendingTradesByKind();
  assert.ok(!bridgeStuck.some((t) => t.id === id));
  assert.ok(swapStuck.some((t) => t.id === id));
});
