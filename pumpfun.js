import {
  PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getSolanaConnection } from './solana.js';

// ---------------------------------------------------------------------------
// Direct integration with pump.fun's bonding-curve program, for tokens that
// haven't graduated to an AMM pool yet (Jupiter has no route for these —
// there's no liquidity pool, just the bonding curve itself). Once a token
// graduates, its curve account's `complete` flag flips true and it should
// go back through the normal Jupiter path in solana-swap.js.
//
// Based on pump.fun's long-standing public IDL (the one nearly every
// open-source pump.fun bot uses). Pump.fun has changed this program before
// without much notice — if buys/sells here start failing outright, that's
// the first thing to re-check (discriminators, account order, or a new fee
// mechanism), not a sign the RPC/wallet setup is wrong.
//
// IMPORTANT: this program trades native SOL only, not USDC. Callers (see
// trade-core.js) are responsible for converting USDC<->SOL via Jupiter
// before/after calling into here — this module only speaks lamports.
// ---------------------------------------------------------------------------

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

const GLOBAL_SEED = Buffer.from('global');
const BONDING_CURVE_SEED = Buffer.from('bonding-curve');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

const [GLOBAL_PDA] = PublicKey.findProgramAddressSync([GLOBAL_SEED], PUMP_PROGRAM_ID);
const [EVENT_AUTHORITY_PDA] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], PUMP_PROGRAM_ID);

function bondingCurvePda(mint) {
  return PublicKey.findProgramAddressSync([BONDING_CURVE_SEED, mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}

function u64le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function readU64le(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

// ---------------------------------------------------------------------------
// Account decoding. Both accounts are Anchor-serialized: 8-byte discriminator
// then fields in declaration order, no padding for these primitive types.
// ---------------------------------------------------------------------------

let globalStateCache = null; // { feeRecipient, feeBasisPoints } — static-ish, cached for process lifetime

export async function getGlobalState() {
  if (globalStateCache) return globalStateCache;
  const connection = getSolanaConnection();
  const info = await connection.getAccountInfo(GLOBAL_PDA);
  if (!info) throw new Error('pump.fun global account not found — program ID or network may be wrong');

  const data = info.data;
  // discriminator(8) + initialized(bool,1) + authority(32) + feeRecipient(32) + ...u64 fields
  let offset = 8 + 1 + 32;
  const feeRecipient = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  offset += 8 + 8 + 8; // initialVirtualTokenReserves, initialVirtualSolReserves, initialRealTokenReserves
  offset += 8; // tokenTotalSupply
  const feeBasisPoints = readU64le(data, offset);

  globalStateCache = { feeRecipient, feeBasisPoints };
  return globalStateCache;
}

/**
 * Reads a mint's bonding-curve account. Returns null if the account doesn't
 * exist at all (i.e. this isn't a pump.fun-launched token), in which case
 * callers should fall through to the normal Jupiter path.
 */
export async function getBondingCurveState(mintAddress) {
  const connection = getSolanaConnection();
  const mint = new PublicKey(mintAddress);
  const curvePda = bondingCurvePda(mint);
  const info = await connection.getAccountInfo(curvePda);
  if (!info) return null;

  const data = info.data;
  let offset = 8;
  const virtualTokenReserves = readU64le(data, offset); offset += 8;
  const virtualSolReserves = readU64le(data, offset); offset += 8;
  const realTokenReserves = readU64le(data, offset); offset += 8;
  const realSolReserves = readU64le(data, offset); offset += 8;
  const tokenTotalSupply = readU64le(data, offset); offset += 8;
  const complete = data.readUInt8(offset) !== 0;

  return {
    mint, curvePda, virtualTokenReserves, virtualSolReserves,
    realTokenReserves, realSolReserves, tokenTotalSupply, complete,
  };
}

/** True if `mintAddress` is a pump.fun bonding-curve token that hasn't graduated to an AMM pool yet. */
export async function isUngraduatedPumpFunToken(mintAddress) {
  const state = await getBondingCurveState(mintAddress).catch(() => null);
  return !!(state && !state.complete);
}

// ---------------------------------------------------------------------------
// Pricing — constant-product curve (x*y=k) on the VIRTUAL reserves, same
// formula pump.fun's own frontend uses. Fee is taken out of the SOL side
// before it hits the curve on a buy, and out of the SOL side after leaving
// the curve on a sell.
// ---------------------------------------------------------------------------

/** Tokens received (raw, bigint) for spending `solInLamports` (bigint) of SOL, before fee. */
export function quoteTokensOutForSol(curve, solInLamports, feeBasisPoints) {
  const feeBps = feeBasisPoints ?? 100n; // pump.fun's fee has historically been 1% (100bps); overridden by live global state where available
  const solAfterFee = solInLamports - (solInLamports * feeBps) / 10000n;
  const k = curve.virtualSolReserves * curve.virtualTokenReserves;
  const newVirtualSol = curve.virtualSolReserves + solAfterFee;
  const newVirtualTokens = k / newVirtualSol;
  const tokensOut = curve.virtualTokenReserves - newVirtualTokens;
  return tokensOut > 0n ? tokensOut : 0n;
}

/** SOL received (raw lamports, bigint) for selling `tokensInRaw` (bigint) of the token, after fee. */
export function quoteSolOutForTokens(curve, tokensInRaw, feeBasisPoints) {
  const feeBps = feeBasisPoints ?? 100n;
  const k = curve.virtualSolReserves * curve.virtualTokenReserves;
  const newVirtualTokens = curve.virtualTokenReserves + tokensInRaw;
  const newVirtualSol = k / newVirtualTokens;
  const solOutBeforeFee = curve.virtualSolReserves - newVirtualSol;
  const solOut = solOutBeforeFee - (solOutBeforeFee * feeBps) / 10000n;
  return solOut > 0n ? solOut : 0n;
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function buildBuyInstruction({ mint, curvePda, associatedBondingCurve, associatedUser, user, feeRecipient, amountTokens, maxSolCost }) {
  const keys = [
    { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: curvePda, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedUser, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([BUY_DISCRIMINATOR, u64le(amountTokens), u64le(maxSolCost)]);
  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data });
}

function buildSellInstruction({ mint, curvePda, associatedBondingCurve, associatedUser, user, feeRecipient, amountTokens, minSolOutput }) {
  const keys = [
    { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: curvePda, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedUser, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([SELL_DISCRIMINATOR, u64le(amountTokens), u64le(minSolOutput)]);
  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// High-level buy/sell — mirrors solana-swap.js's sendSolanaSwap shape
// (signs, sends, confirms) so trade-core.js can treat both paths similarly.
// ---------------------------------------------------------------------------

/**
 * Spends `solInLamports` of native SOL to buy `mintAddress` via the bonding
 * curve directly. `slippageBps` bounds how much worse than the current-quote
 * price we'll accept before the tx reverts (fails safe — a bad quote just
 * means the tx bounces, it never silently overpays).
 */
export async function executePumpFunBuy(signerKeypair, mintAddress, solInLamports, slippageBps = 100) {
  const connection = getSolanaConnection();
  const mint = new PublicKey(mintAddress);
  const curve = await getBondingCurveState(mintAddress);
  if (!curve) throw new Error(`No pump.fun bonding-curve account found for ${mintAddress}`);
  if (curve.complete) throw new Error(`${mintAddress} has already graduated — use the normal Jupiter swap path instead`);

  const { feeRecipient, feeBasisPoints } = await getGlobalState();
  const tokensOutEstimate = quoteTokensOutForSol(curve, solInLamports, feeBasisPoints);
  if (tokensOutEstimate <= 0n) throw new Error('Bonding-curve quote returned zero tokens out — curve may be near-empty or already graduated');

  // Ask for slightly fewer tokens than the raw estimate (protects against a
  // stale reserve read causing an on-chain revert), while capping the SOL
  // we're willing to spend at solInLamports * (1 + slippage).
  const amountTokens = (tokensOutEstimate * 9950n) / 10000n; // 0.5% haircut on the estimate
  const maxSolCost = solInLamports + (solInLamports * BigInt(slippageBps)) / 10000n;

  const curvePda = curve.curvePda;
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, curvePda, true);
  const associatedUser = getAssociatedTokenAddressSync(mint, signerKeypair.publicKey);

  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(signerKeypair.publicKey, associatedUser, signerKeypair.publicKey, mint),
    buildBuyInstruction({
      mint, curvePda, associatedBondingCurve, associatedUser,
      user: signerKeypair.publicKey, feeRecipient, amountTokens, maxSolCost,
    }),
  ];

  const tx = new Transaction().add(...ixs);
  const signature = await sendAndConfirmTransaction(connection, tx, [signerKeypair], { commitment: 'confirmed' });
  return { signature, tokensOut: amountTokens };
}

/**
 * Sells `tokenAmountRaw` (bigint, raw/smallest-unit) of `mintAddress` via the
 * bonding curve directly, receiving native SOL back into the wallet.
 */
export async function executePumpFunSell(signerKeypair, mintAddress, tokenAmountRaw, slippageBps = 100) {
  const connection = getSolanaConnection();
  const mint = new PublicKey(mintAddress);
  const curve = await getBondingCurveState(mintAddress);
  if (!curve) throw new Error(`No pump.fun bonding-curve account found for ${mintAddress}`);
  if (curve.complete) throw new Error(`${mintAddress} has already graduated — use the normal Jupiter swap path instead`);

  const { feeRecipient, feeBasisPoints } = await getGlobalState();
  const solOutEstimate = quoteSolOutForTokens(curve, tokenAmountRaw, feeBasisPoints);
  const minSolOutput = (solOutEstimate * BigInt(10000 - slippageBps)) / 10000n;

  const curvePda = curve.curvePda;
  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, curvePda, true);
  const associatedUser = getAssociatedTokenAddressSync(mint, signerKeypair.publicKey);

  const ix = buildSellInstruction({
    mint, curvePda, associatedBondingCurve, associatedUser,
    user: signerKeypair.publicKey, feeRecipient, amountTokens: tokenAmountRaw, minSolOutput,
  });

  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [signerKeypair], { commitment: 'confirmed' });
  return { signature, solOut: solOutEstimate };
}

export { LAMPORTS_PER_SOL };
