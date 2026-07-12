import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBridgeQuote } from '../bridge.js';

test('summarizeBridgeQuote sums fee + gas costs into totalFeeUsd', () => {
  const quote = {
    tool: 'stargate',
    toolDetails: { name: 'Stargate' },
    estimate: {
      feeCosts: [{ amountUSD: '1.20' }, { amountUSD: '0.05' }],
      gasCosts: [{ amountUSD: '0.30' }],
      executionDuration: 180,
      toAmountUSD: '48.45',
    },
  };
  const summary = summarizeBridgeQuote(quote);
  assert.equal(summary.totalFeeUsd, 1.55);
  assert.equal(summary.etaSeconds, 180);
  assert.equal(summary.toAmountUsd, 48.45);
  assert.equal(summary.toolUsed, 'Stargate');
});

test('summarizeBridgeQuote handles missing estimate fields gracefully', () => {
  const quote = { tool: 'unknown-tool' };
  const summary = summarizeBridgeQuote(quote);
  assert.equal(summary.totalFeeUsd, 0);
  assert.equal(summary.etaSeconds, null);
  assert.equal(summary.toAmountUsd, 0);
  assert.equal(summary.toolUsed, 'unknown-tool');
});

test('summarizeBridgeQuote falls back to "unknown route" when no tool info present', () => {
  const summary = summarizeBridgeQuote({ estimate: {} });
  assert.equal(summary.toolUsed, 'unknown route');
});

test('summarizeBridgeQuote ignores malformed fee entries (NaN-safe)', () => {
  const quote = {
    tool: 'across',
    estimate: {
      feeCosts: [{ amountUSD: undefined }, { amountUSD: '2.00' }],
      gasCosts: [],
    },
  };
  const summary = summarizeBridgeQuote(quote);
  assert.equal(summary.totalFeeUsd, 2.00);
});
