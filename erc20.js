import { ethers } from 'ethers';

// Canonical Permit2 contract address — same on all EVM chains that have it deployed.
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
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
