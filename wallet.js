import { ethers } from 'ethers';

/**
 * Creates a fresh wallet for a Telegram user.
 * ⚠️ For production: encrypt privateKey at rest (e.g. AES with a per-user key
 * derived from a KMS/secrets manager), never keep raw keys in memory/logs long-term,
 * and consider ERC-4337 smart accounts + session keys instead of raw EOAs
 * so users can limit what the bot is allowed to do.
 */
export function createWallet() {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export function loadWallet(privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  return { address: wallet.address, privateKey: wallet.privateKey };
}
