import sharp from 'sharp';
import path from 'path';
import crypto from 'crypto';
import { getActiveWallet, getPosition, getRealizedPnl } from './storage.js';
import { getTokenMarketData, getEthUsdPrice, fmtUsd, fmtTokenAmount } from './price.js';
import { shortAddr } from './wallet.js';

const NFT_DIR = path.join(process.cwd(), 'assets', 'nft-cards');
const NFT_COUNT = 100;
const CARD_SIZE = 800;

/** Deterministic pick so the same user always gets the same NFT on their cards. */
function pickNftIndex(uid) {
  const hash = crypto.createHash('md5').update(String(uid)).digest();
  const n = hash.readUInt32BE(0);
  return (n % NFT_COUNT) + 1;
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function buildOverlaySvg({ symbol, subtitle, pnlLabel, isWin, stats, nftLabel, footerLeft, footerRight }) {
  const pillBg = isWin ? 'rgba(99,153,34,0.9)' : 'rgba(163,45,45,0.9)';
  const pillText = isWin ? '#173404' : '#ffffff';
  const pillWidth = Math.max(120, 24 + pnlLabel.length * 13);

  const colWidth = (CARD_SIZE - 64) / stats.length;
  const statCols = stats.map((s, i) => {
    const x = 32 + i * colWidth;
    return `
    <text x="${x}" y="${CARD_SIZE - 118}" font-family="Arial, sans-serif" font-size="18" fill="#888780">${escapeXml(s.label)}</text>
    <text x="${x}" y="${CARD_SIZE - 90}" font-family="Arial, sans-serif" font-size="25" font-weight="bold" fill="${s.color || '#ffffff'}">${escapeXml(s.value)}</text>`;
  }).join('');

  return `
  <svg width="${CARD_SIZE}" height="${CARD_SIZE}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fade" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#000000" stop-opacity="0.88"/>
        <stop offset="38%" stop-color="#000000" stop-opacity="0.55"/>
        <stop offset="62%" stop-color="#000000" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="${CARD_SIZE}" height="${CARD_SIZE}" fill="url(#fade)"/>

    <rect x="28" y="28" rx="20" ry="20" width="210" height="36" fill="rgba(0,0,0,0.5)"/>
    <text x="46" y="52" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#ffffff">${escapeXml(nftLabel)}</text>

    <rect x="${CARD_SIZE - pillWidth - 30}" y="28" rx="20" ry="20" width="${pillWidth}" height="36" fill="${pillBg}"/>
    <text x="${CARD_SIZE - 30 - pillWidth / 2}" y="52" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="${pillText}" text-anchor="middle">${escapeXml(pnlLabel)}</text>

    <text x="32" y="${CARD_SIZE - 190}" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="#ffffff">${escapeXml(symbol)}</text>
    <text x="32" y="${CARD_SIZE - 160}" font-family="Arial, sans-serif" font-size="20" fill="#B4B2A9">${escapeXml(subtitle)}</text>

    ${statCols}

    <line x1="32" y1="${CARD_SIZE - 56}" x2="${CARD_SIZE - 32}" y2="${CARD_SIZE - 56}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
    <text x="32" y="${CARD_SIZE - 28}" font-family="Arial, sans-serif" font-size="16" fill="#5f5e5a">${escapeXml(footerLeft)}</text>
    <text x="${CARD_SIZE - 32}" y="${CARD_SIZE - 28}" font-family="Arial, sans-serif" font-size="16" fill="#5f5e5a" text-anchor="end">${escapeXml(footerRight)}</text>
  </svg>`;
}

/**
 * Composites the overlay onto a deterministically-picked NFT background.
 * `stats` is up to 3 { label, value, color? } columns shown along the bottom.
 */
async function renderCard({ uid, symbol, subtitle, pnlLabel, isWin, stats }) {
  const idx = pickNftIndex(uid);
  const imgPath = path.join(NFT_DIR, `${idx}.jpg`);
  const nftLabel = `Panchi #${idx}`;

  const overlay = Buffer.from(buildOverlaySvg({
    symbol, subtitle, pnlLabel, isWin, stats, nftLabel,
    footerLeft: 't.me/robinpanchi_bot',
    footerRight: '@robinpanchi',
  }));

  return sharp(imgPath)
    .resize(CARD_SIZE, CARD_SIZE, { fit: 'cover' })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * Realized-PnL card for a completed sell. Pass everything already computed
 * by the caller (trade-core.js) — this module doesn't re-fetch trade data.
 */
export async function generateSellPnlCard({ uid, symbol, pct, pnlEth, pnlPct, entryMcap, exitMcap }) {
  const isWin = pnlEth >= 0;
  const pnlLabel = `${pnlEth >= 0 ? '+' : ''}${pnlEth.toFixed(3)} ETH`;

  const stats = [
    { label: 'Entry mcap', value: entryMcap != null ? fmtUsd(entryMcap) : 'n/a' },
    { label: 'Exit mcap', value: exitMcap != null ? fmtUsd(exitMcap) : 'n/a' },
    { label: 'PnL', value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`, color: isWin ? '#97C459' : '#E24B4A' },
  ];

  return renderCard({
    uid,
    symbol,
    subtitle: `Sold ${pct}% of position`,
    pnlLabel,
    isWin,
    stats,
  });
}

/**
 * Unrealized-PnL "flex" card for /flex on an OPEN position — looks up the
 * user's live position on the given token itself, so callers just pass
 * uid + tokenAddress.
 */
async function generateOpenPositionFlexCard(uid, wallet, tokenAddress, pos) {
  const market = await getTokenMarketData(tokenAddress).catch(() => null);
  const ethUsd = await getEthUsdPrice().catch(() => null);
  if (!market || !ethUsd) return null;

  const valueUsd = pos.tokenAmount * market.priceUsd;
  const costUsd = pos.costEth * ethUsd;
  const pnlUsd = valueUsd - costUsd;
  const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0;
  const isWin = pnlUsd >= 0;
  const pnlLabel = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;

  const stats = [
    { label: 'Holding', value: fmtTokenAmount(pos.tokenAmount) },
    { label: 'Value', value: fmtUsd(valueUsd) },
    { label: 'PnL', value: `${pnlUsd >= 0 ? '+' : ''}${fmtUsd(pnlUsd)}`, color: isWin ? '#97C459' : '#E24B4A' },
  ];

  return renderCard({
    uid,
    symbol: market.symbol,
    subtitle: pos.entryMcap != null ? `Entry mcap ${fmtUsd(pos.entryMcap)}` : 'Open position',
    pnlLabel,
    isWin,
    stats,
  });
}

/**
 * Realized-PnL "flex" card for a CLOSED position — position has no live
 * tokenAmount left, so this sums the wallet's full buy/sell history for the
 * token (via getRealizedPnl) and flexes total ETH profit/loss instead.
 */
async function generateClosedPositionFlexCard(uid, wallet, tokenAddress) {
  const realized = getRealizedPnl(uid, wallet.id, tokenAddress);
  if (!realized || realized.totalBuyEth <= 0) return null;

  const { totalBuyEth, totalSellEth, entryMcap, exitMcap } = realized;
  const pnlEth = totalSellEth - totalBuyEth;
  const pnlPct = (pnlEth / totalBuyEth) * 100;
  const isWin = pnlEth >= 0;
  const pnlLabel = `${pnlEth >= 0 ? '+' : ''}${pnlEth.toFixed(3)} ETH`;

  const market = await getTokenMarketData(tokenAddress).catch(() => null);
  const symbol = market?.symbol ?? shortAddr(tokenAddress);

  const stats = [
    { label: 'Entry mcap', value: entryMcap != null ? fmtUsd(entryMcap) : 'n/a' },
    { label: 'Exit mcap', value: exitMcap != null ? fmtUsd(exitMcap) : 'n/a' },
    { label: 'PnL', value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`, color: isWin ? '#97C459' : '#E24B4A' },
  ];

  return renderCard({
    uid,
    symbol,
    subtitle: 'Closed position',
    pnlLabel,
    isWin,
    stats,
  });
}

/**
 * Entry point used by /flex. Works for BOTH an open position (live
 * unrealized PnL vs. current price) and a fully closed one (realized PnL
 * summed from trade history). Returns null if there's no active wallet, or
 * no trade history at all for this token — the caller shows a "no position"
 * message in that case.
 */
export async function generateFlexCard(uid, tokenAddress) {
  const w = getActiveWallet(uid);
  if (!w) return null;

  const pos = getPosition(uid, w.id, tokenAddress);
  if (pos && pos.tokenAmount > 0) {
    return generateOpenPositionFlexCard(uid, w, tokenAddress, pos);
  }

  return generateClosedPositionFlexCard(uid, w, tokenAddress);
}
