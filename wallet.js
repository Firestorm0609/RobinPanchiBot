import { ethers } from 'ethers';

/**
 * ⚠️ Production note: encrypt privateKey at rest (per-user key via KMS/secrets manager).
 * data/db.json currently stores keys in plaintext on disk — fine to get moving,
 * not fine for real user funds at scale. Migrate before serious volume.
 */
export function createWallet(name) {
  const wallet = ethers.Wallet.createRandom();
  return { name, address: wallet.address, privateKey: wallet.privateKey };
}

export function importWallet(name, privateKey) {
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(pk); // throws if invalid
  return { name, address: wallet.address, privateKey: wallet.privateKey };
}

export function shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
