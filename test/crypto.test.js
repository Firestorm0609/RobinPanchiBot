import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// crypto.js reads MASTER_KEY at call time via getKey(), so it must be set before import.
process.env.MASTER_KEY = 'a'.repeat(64); // valid 32-byte hex key for test purposes only

const { encrypt, decrypt } = await import('../crypto.js');

test('encrypt/decrypt round-trips a plain string', () => {
  const plaintext = '0xabc123deadbeef';
  const enc = encrypt(plaintext);
  assert.equal(decrypt(enc), plaintext);
});

test('encrypt output has the expected iv:tag:cipher shape', () => {
  const enc = encrypt('hello');
  const parts = enc.split(':');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^[0-9a-f]{24}$/); // 12-byte IV as hex
  assert.match(parts[1], /^[0-9a-f]{32}$/); // 16-byte auth tag as hex
});

test('encrypt is non-deterministic (random IV per call)', () => {
  const a = encrypt('same input');
  const b = encrypt('same input');
  assert.notEqual(a, b);
});

test('decrypt throws on tampered ciphertext (auth tag mismatch)', () => {
  const enc = encrypt('sensitive data');
  const [iv, tag, cipher] = enc.split(':');
  const tampered = `${iv}:${tag}:${cipher.slice(0, -2)}00`; // flip last byte
  assert.throws(() => decrypt(tampered));
});

test('decrypt throws on malformed payload', () => {
  assert.throws(() => decrypt('not-a-valid-payload'));
});
