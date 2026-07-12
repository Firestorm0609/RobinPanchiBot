import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, getAccount, createTransferInstruction,
  createAssociatedTokenAccountIdempotentInstruction, TokenAccountNotFoundError,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { CHAINS } from './chains.js';

const USDC_MINT = new PublicKey(CHAINS.solana.usdcMint);
const USDC_DECIMALS = CHAINS.solana.usdcDecimals;

let _connection = null;
export function getSolanaConnection() {
  if (_connection) return _connection;
  const rpcUrl = process.env.SOLANA_RPC_URL || CHAINS.solana.fallbackRpc;
  _connection = new Connection(rpcUrl, 'confirmed');
  return _connection;
}

/** Generates a brand-new Solana keypair. Returns { address, privateKey } — privateKey is base58 (Phantom-compatible export format). */
export function createSolanaWallet() {
  const kp = Keypair.generate();
  return { address: kp.publicKey.toBase58(), privateKey: bs58.encode(kp.secretKey) };
}

export function keypairFromPrivateKey(base58SecretKey) {
  return Keypair.fromSecretKey(bs58.decode(base58SecretKey));
}

export async function getSolBalance(address) {
  const connection = getSolanaConnection();
  const lamports = await connection.getBalance(new PublicKey(address));
  return lamports / LAMPORTS_PER_SOL;
}

/** Returns the wallet's USDC (SPL token) balance as a human-readable number. Returns 0 if no token account exists yet. */
export async function getSolanaUsdcBalance(address) {
  const connection = getSolanaConnection();
  const owner = new PublicKey(address);
  const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
  try {
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 10 ** USDC_DECIMALS;
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0;
    throw err;
  }
}

/** Raw (bigint, smallest-unit) USDC balance — used by trade-core for exact on-chain sell amounts. */
export async function getSolanaUsdcBalanceRaw(address) {
  const connection = getSolanaConnection();
  const owner = new PublicKey(address);
  const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
  try {
    const account = await getAccount(connection, ata);
    return account.amount; // bigint
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}

/**
 * Sends USDC (SPL token) from signerKeypair to a destination address.
 * Creates the destination's associated token account if it doesn't exist yet
 * (idempotent instruction — safe even if it already exists).
 */
export async function transferSolanaUsdc(signerKeypair, toAddress, rawAmount) {
  const connection = getSolanaConnection();
  const owner = signerKeypair.publicKey;
  const dest = new PublicKey(toAddress);

  const sourceAta = await getAssociatedTokenAddress(USDC_MINT, owner);
  const destAta = await getAssociatedTokenAddress(USDC_MINT, dest);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner, destAta, dest, USDC_MINT),
    createTransferInstruction(sourceAta, destAta, owner, rawAmount)
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [signerKeypair], { commitment: 'confirmed' });
  return { signature };
}

/** Sends native SOL — used for gas top-ups / sweeping dust during collect. */
export async function transferSol(signerKeypair, toAddress, lamports) {
  const connection = getSolanaConnection();
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: signerKeypair.publicKey, toPubkey: new PublicKey(toAddress), lamports })
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [signerKeypair], { commitment: 'confirmed' });
  return { signature };
}

/** Raw balance (bigint) + decimals for ANY SPL token mint — used to resolve exact sell amounts, mirroring erc20.js's getTokenBalance/getDecimals for EVM. */
export async function getSplTokenBalanceRaw(mintAddress, ownerAddress) {
  const connection = getSolanaConnection();
  const owner = new PublicKey(ownerAddress);
  const mint = new PublicKey(mintAddress);
  const ata = await getAssociatedTokenAddress(mint, owner);
  try {
    const account = await getAccount(connection, ata);
    return account.amount; // bigint
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}

export async function getSplTokenDecimals(mintAddress) {
  const connection = getSolanaConnection();
  const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
  return mintInfo.value?.data?.parsed?.info?.decimals ?? 6;
}

export function shortSolAddr(addr) {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}
