import { ethers } from 'ethers';
import { createSolanaWallet, importSolanaWallet, isValidSolanaPrivateKey } from './solana.js';

/**
 * A "wallet" in this bot is a pair of keypairs under one name: an EVM
 * keypair (same address works on Ethereum/Base/Arbitrum/BSC/Robinhood Chain
 * — that's just how EVM addresses work) and a Solana keypair (different
 * curve, needs its own key). This is what lets one wallet trade USDC on
 * every supported chain without the user ever thinking about bridging.
 *
 * evmPrivateKey / solPrivateKey are the DECRYPTED values in memory — storage.js
 * encrypts each independently before writing to disk.
 */
export function createWallet(name) {
  const evm = ethers.Wallet.createRandom();
  const sol = createSolanaWallet();
  return {
    name,
    evmAddress: evm.address,
    evmPrivateKey: evm.privateKey,
    solAddress: sol.address,
    solPrivateKey: sol.privateKey,
  };
}

/**
 * Imports a wallet from a SINGLE key of either type — the bot then
 * generates a fresh keypair for the OTHER chain type, since an EVM key and a
 * Solana key can't be derived from one another (different curves entirely).
 * The user is shown both addresses after import so they know the Solana (or
 * EVM) side is a NEW address they'll need to fund separately if they want to
 * trade there.
 *
 * Returns { wallet, generatedSide } where generatedSide is 'solana' | 'evm'
 * telling the caller which half was auto-generated, so the UI can warn the
 * user to fund it before trading on that side.
 */
export function importWallet(name, key) {
  const trimmed = key.trim();

  if (trimmed.startsWith('0x') || /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    // EVM private key
    const pk = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
    const evm = new ethers.Wallet(pk); // throws if invalid
    const sol = createSolanaWallet();
    return {
      wallet: {
        name,
        evmAddress: evm.address,
        evmPrivateKey: evm.privateKey,
        solAddress: sol.address,
        solPrivateKey: sol.privateKey,
      },
      generatedSide: 'solana',
    };
  }

  if (isValidSolanaPrivateKey(trimmed)) {
    const sol = importSolanaWallet(trimmed);
    const evm = ethers.Wallet.createRandom();
    return {
      wallet: {
        name,
        evmAddress: evm.address,
        evmPrivateKey: evm.privateKey,
        solAddress: sol.address,
        solPrivateKey: sol.privateKey,
      },
      generatedSide: 'evm',
    };
  }

  throw new Error('Unrecognized key format — send an EVM private key (0x...) or a Solana base58 secret key.');
}

export function shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
