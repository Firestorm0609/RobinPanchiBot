import { ethers } from 'ethers';

// Canonical Permit2 contract address — same on all EVM chains that have it deployed.
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

/**
 * Ensures the signer has approved Permit2 to move at least `amount` of `tokenAddress`.
 * One-time per token per wallet — subsequent sells skip the on-chain approve.
 */
export async function ensureAllowance(signer, tokenAddress, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const current = await token.allowance(owner, PERMIT2_ADDRESS);

  if (current >= amount) return null; // already approved, nothing to do

  const tx = await token.approve(PERMIT2_ADDRESS, ethers.MaxUint256);
  return tx.wait();
}

/**
 * Fetches the token's actual decimals. Falls back to 18 if the call fails
 * (non-standard token) — caller should treat that as a best-effort guess.
 */
export async function getDecimals(provider, tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return Number(await token.decimals());
}

/**
 * Raw on-chain token balance (bigint, smallest unit) for an address.
 * Used by Batch Collect to know how much of a token it can actually sweep,
 * rather than trusting the locally tracked position (which can drift from
 * the real chain state).
 */
export async function getTokenBalance(provider, tokenAddress, ownerAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return token.balanceOf(ownerAddress);
}

/**
 * Sends the full given amount (bigint, smallest unit) of a token to
 * `toAddress`. Used by Batch Collect. Returns the mined receipt.
 */
export async function transferToken(signer, tokenAddress, toAddress, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const tx = await token.transfer(toAddress, amount);
  return tx.wait();
}
