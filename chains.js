import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Central chain registry. This is the single source of truth for every chain
// the bot can trade USDC on. Adding a new EVM chain is just adding an entry
// here (plus its RPC url + USDC address in .env) — no other file should ever
// hardcode a chainId, RPC url, or USDC address again.
//
// IMPORTANT: BSC's native USDC deployment uses 18 decimals, not 6 like every
// other chain's native USDC. That's why usdcDecimals is per-chain, not a
// global constant like the old USDC_DECIMALS in config.js.
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
    usdcAddress: process.env.USDC_ROBINHOOD_ADDRESS,
    usdcDecimals: 6,
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
  if (!CHAINS.robinhood.usdcAddress) problems.push('USDC_ROBINHOOD_ADDRESS is not set');
  if (!process.env.RPC_URL) problems.push('RPC_URL is not set (required for Robinhood Chain)');
  return problems;
}
