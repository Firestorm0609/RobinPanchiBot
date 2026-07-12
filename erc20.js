import { ethers } from 'ethers';

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

/** Ensures `signer` has approved Permit2 to move at least `amount` of `tokenAddress` on whatever chain `signer` is connected to. */
export async function ensureAllowance(signer, tokenAddress, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const current = await token.allowance(owner, PERMIT2_ADDRESS);
  if (current >= amount) return null;
  const tx = await token.approve(PERMIT2_ADDRESS, ethers.MaxUint256);
  return tx.wait();
}

export async function getDecimals(provider, tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return Number(await token.decimals());
}

export async function getTokenBalance(provider, tokenAddress, ownerAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return token.balanceOf(ownerAddress);
}

/** USDC balance on whatever chain `provider` is connected to — pass that chain's USDC address explicitly. */
export async function getUsdcBalance(provider, usdcAddress, ownerAddress) {
  const token = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
  return token.balanceOf(ownerAddress);
}

export async function transferToken(signer, tokenAddress, toAddress, amount) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const tx = await token.transfer(toAddress, amount);
  return tx.wait();
}
