import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey() {
  const key = process.env.MASTER_KEY;
  if (!key || key.length !== 64) {
    throw new Error(
      'MASTER_KEY must be set in .env as a 64-char hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(key, 'hex');
}

/** Encrypts a string, returns "iv:authTag:ciphertext" (all hex). */
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/** Reverses encrypt(). Throws if MASTER_KEY is wrong or data was tampered with. */
export function decrypt(payload) {
  const [ivHex, tagHex, encHex] = payload.split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('Malformed encrypted payload');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}
