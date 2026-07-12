import { ethers } from 'ethers';
import { getBridgeQuote, sendBridgeTx, chainIdsForDirection, ETH_CHAIN_ID } from './bridge.js';
import { getSettings, createPendingBridge, markPendingBridgeSubmitted, markPendingBridgeDone, getActiveWallet } from './storage.js';
import { sendAdminAlert } from './alerts.js';
import { provider, ethMainnetProvider, MIN_BRIDGE_ETH } from './config.js';
import { gasMultiplierFor, bridgesInFlight } from './state.js';
import { explorerTxUrlForChain, friendlyErrorMessage } from './format.js';
import { mainMenu, walletsMenu, directionLabel } from './menus.js';

export async function executeBridge(ctx, uid, direction, amountEth) {
  const w = getActiveWallet(uid);
  if (!w) return ctx.reply('No active wallet.', walletsMenu(uid));

  if (amountEth < MIN_BRIDGE_ETH) {
    return ctx.reply(
      `❌ ${amountEth} ETH is below the minimum bridgeable amount (${MIN_BRIDGE_ETH} ETH). Bridges below that typically have no valid route since fees exceed the amount.`,
      mainMenu()
    );
  }

  const { maxBridgeEth } = getSettings(uid);
  if (amountEth > maxBridgeEth) {
    return ctx.reply(`❌ ${amountEth} ETH exceeds your max bridge size (${maxBridgeEth} ETH). Adjust it in Settings if this was intentional.`, mainMenu());
  }

  if (bridgesInFlight.has(uid)) {
    return ctx.reply('⏳ A bridge is already in progress — please wait for it to finish.');
  }
  bridgesInFlight.add(uid);

  let pendingBridgeId;
  try {
    await ctx.reply(`Bridging ${amountEth} ETH (${directionLabel(direction)})... fetching quote.`);
    const { fromChain, toChain } = chainIdsForDirection(direction);
    const quote = await getBridgeQuote({ direction, amountEth, fromAddress: w.address });

    pendingBridgeId = createPendingBridge({
      uid, walletId: w.id, direction, amountEth, fromChain, toChain, bridgeTool: quote.tool,
    });

    const sourceProvider = fromChain === ETH_CHAIN_ID ? ethMainnetProvider : provider;
    const sourceSigner = new ethers.Wallet(w.privateKey, sourceProvider);

    const { txResponse, bumped } = await sendBridgeTx(sourceSigner, quote, { gasMultiplier: gasMultiplierFor(uid) });
    markPendingBridgeSubmitted(pendingBridgeId, txResponse.hash);

    if (bumped) await ctx.reply('⛽ Network was congested — resubmitted with higher gas.');

    const txLink = explorerTxUrlForChain(txResponse.hash, fromChain);
    await ctx.reply(
      `✅ Bridge submitted${txLink ? ` — [view transaction](${txLink})` : ''}.\n\n` +
      `Estimated arrival: ~${quote.estimatedDurationSeconds ? Math.ceil(quote.estimatedDurationSeconds / 60) + ' min' : 'a few minutes'}.\n` +
      `I'll message you here once it lands on the destination chain.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error(err);
    if (pendingBridgeId) markPendingBridgeDone(pendingBridgeId, 'failed');
    await ctx.reply(`❌ Bridge failed: ${friendlyErrorMessage(err)}`, mainMenu());
    await sendAdminAlert(ctx.telegram, `Bridge failed for user ${uid} (${direction}, ${amountEth} ETH): ${err.message}`);
  } finally {
    bridgesInFlight.delete(uid);
  }
}
