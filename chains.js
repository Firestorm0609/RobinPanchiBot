import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Central chain registry. This is the single source of truth for every chain
// the bot can trade in-its-native-stablecoin on. Adding a new EVM chain is
// just adding an entry here (plus its RPC url + stablecoin address in .env)
// — no other file should ever hardcode a chainId, RPC url, or stablecoin
// address again.
//
// IMPORTANT: BSC's native USDC deployment uses 18 decimals, not 6 like every
// other chain's native USDC. That's why usdcDecimals is per-chain, not a
// global constant.
//
// IMPORTANT #2: Robinhood Chain does NOT have a native USDC deployment —
// Circle has not issued USDC there. Robinhood Chain's actual settlement
// stablecoin is USDG (Global Dollar, issued by Paxos), which is what
// Robinhood Earn and every reported DEX volume figure on that chain are
// denominated in. So `robinhood.usdcAddress` below points at USDG, and
// `stableSymbol` is 'USDG' instead of the 'USDC' every other chain uses —
// UI text should read from `stableSymbol`, not hardcode "USDC".
//
// `usdcDecimals: null` means "don't guess — resolve it on-chain via
// decimals() the first time it's needed" (see getStableDecimals below).
// This is deliberate: USDG's decimals weren't confirmed from official docs
// at the time this was wired up, and guessing a wrong decimals value here
// would silently corrupt every trade amount on that chain.
// ---------------------------------------------------------------------------

export const CHAIN_KIND = { EVM: 'evm', SOLANA: 'solana' };

export const CHAINS = {
  ethereum: {
    key: 'ethereum',
    name: 'Ethereum',
    kind: CHAIN_KIND.EVM,
    chainId: 1,
    rpcEnvVar: 'ETH_RPC_URL',
    fallbackRpc: 'https://cloudflare-eth.com',
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usdcDecimals: 6,
    stableSymbol: 'USDC',
    explorerBase: 'https://etherscan.io',
    nativeSymbol: 'ETH',
  },
  base: {
    key: 'base',
    name: 'Base',
    kind: CHAIN_KIND.EVM,
    chainId: 8453,
    rpcEnvVar: 'BASE_RPC_URL',
    fallbackRpc: 'https://mainnet.base.org',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcDecimals: 6,
    stableSymbol: 'USDC',
    explorerBase: 'https://basescan.org',
    nativeSymbol: 'ETH',
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum',
    kind: CHAIN_KIND.EVM,
    chainId: 42161,
    rpcEnvVar: 'ARBITRUM_RPC_URL',
    fallbackRpc: 'https://arb1.arbitrum.io/rpc',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    usdcDecimals: 6,
    stableSymbol: 'USDC',
    explorerBase: 'https://arbiscan.io',
    nativeSymbol: 'ETH',
  },
  bsc: {
    key: 'bsc',
    name: 'BNB Chain',
    kind: CHAIN_KIND.EVM,
    chainId: 56,
    rpcEnvVar: 'BSC_RPC_URL',
    fallbackRpc: 'https://bsc-dataseed.binance.org',
    usdcAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    usdcDecimals: 18, // NOTE: BSC's native USDC is 18 decimals, unlike everywhere else
    stableSymbol: 'USDC',
    explorerBase: 'https://bscscan.com',
    nativeSymbol: 'BNB',
  },
  robinhood: {
    key: 'robinhood',
    name: 'Robinhood Chain',
    kind: CHAIN_KIND.EVM,
    chainId: Number(process.env.CHAIN_ID || 4663),
    rpcEnvVar: 'RPC_URL',
    fallbackRpc: null, // no public fallback — this one's required in .env
    // USDG (Global Dollar, Paxos) — Robinhood Chain's official contracts page
    // lists no USDC deployment at all. This address is from Robinhood's own
    // docs (docs.robinhood.com/chain/contracts). Verify against that page
    // if Robinhood ever redeploys or adds a second stablecoin.
    usdcAddress: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    usdcDecimals: null, // resolved on-chain on first use — see getStableDecimals()
    stableSymbol: 'USDG',
    explorerBase: (process.env.EXPLORER_BASE_URL || '').replace(/\/$/, ''),
    nativeSymbol: 'ETH',
  },
  solana: {
    key: 'solana',
    name: 'Solana',
    kind: CHAIN_KIND.SOLANA,
    rpcEnvVar: 'SOLANA_RPC_URL',
    fallbackRpc: 'https://api.mainnet-beta.solana.com',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    usdcDecimals: 6,
    stableSymbol: 'USDC',
    explorerBase: 'https://solscan.io',
    nativeSymbol: 'SOL',
  },
};

export const EVM_CHAIN_KEYS = Object.values(CHAINS).filter((c) => c.kind === CHAIN_KIND.EVM).map((c) => c.key);
export const ALL_CHAIN_KEYS = Object.keys(CHAINS);

export function getChain(chainKey) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`);
  return chain;
}

export function isEvmChain(chainKey) {
  return getChain(chainKey).kind === CHAIN_KIND.EVM;
}

export function isSolanaChain(chainKey) {
  return getChain(chainKey).kind === CHAIN_KIND.SOLANA;
}

/** Display label for whatever this chain's settlement stablecoin is — 'USDC' everywhere except Robinhood Chain ('USDG'). */
export function stableSymbolFor(chainKey) {
  return getChain(chainKey).stableSymbol || 'USDC';
}

// ---------------------------------------------------------------------------
// EVM provider cache — one JsonRpcProvider per chain, created lazily and
// reused (mirrors how config.js used to hold a single module-level `provider`).
// ---------------------------------------------------------------------------

const providerCache = new Map();

export function getEvmProvider(chainKey) {
  const chain = getChain(chainKey);
  if (chain.kind !== CHAIN_KIND.EVM) throw new Error(`${chainKey} is not an EVM chain`);
  if (providerCache.has(chainKey)) return providerCache.get(chainKey);

  const rpcUrl = process.env[chain.rpcEnvVar] || chain.fallbackRpc;
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for ${chain.name} — set ${chain.rpcEnvVar} in .env`);
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, chain.chainId);
  providerCache.set(chainKey, provider);
  return provider;
}

// ---------------------------------------------------------------------------
// Stablecoin decimals — hardcoded per chain where known, resolved on-chain
// (and cached) where not. This is what lets Robinhood Chain's USDG entry
// have `usdcDecimals: null` above instead of a guessed value.
// ---------------------------------------------------------------------------

const DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const decimalsCache = new Map(); // chainKey -> resolved decimals (number)

export async function getStableDecimals(chainKey) {
  const chain = getChain(chainKey);

  if (isSolanaChain(chainKey)) return chain.usdcDecimals;
  if (typeof chain.usdcDecimals === 'number') return chain.usdcDecimals;

  if (decimalsCache.has(chainKey)) return decimalsCache.get(chainKey);

  const provider = getEvmProvider(chainKey);
  const token = new ethers.Contract(chain.usdcAddress, DECIMALS_ABI, provider);
  const decimals = Number(await token.decimals());
  decimalsCache.set(chainKey, decimals);
  return decimals;
}

export function explorerTxUrl(chainKey, txHash) {
  const chain = getChain(chainKey);
  if (chain.kind === CHAIN_KIND.SOLANA) return `${chain.explorerBase}/tx/${txHash}`;
  if (!chain.explorerBase) return null;
  return `${chain.explorerBase}/tx/${txHash}`;
}

export function explorerAddressUrl(chainKey, address) {
  const chain = getChain(chainKey);
  if (chain.kind === CHAIN_KIND.SOLANA) return `${chain.explorerBase}/account/${address}`;
  if (!chain.explorerBase) return null;
  return `${chain.explorerBase}/address/${address}`;
}

/** Validates that required env vars are present for every chain marked required (Robinhood always is). */
export function validateChainEnv() {
  const problems = [];
  if (!process.env.RPC_URL) problems.push('RPC_URL is not set (required for Robinhood Chain)');
  return problems;
}
