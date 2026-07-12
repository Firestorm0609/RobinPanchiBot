import sharp from 'sharp';
import path from 'path';
import crypto from 'crypto';
import { getActiveWallet, getPosition, getRealizedPnl, getSettings } from './storage.js';
import { getTokenMarketData, fmtUsd, fmtTokenAmount } from './price.js';
import { getChain } from './chains.js';
import { shortAddr } from './wallet.js';

const NFT_DIR = path.join(process.cwd(), 'assets', 'nft-cards');
const NFT_COUNT = 100;
const CARD_SIZE = 800;

function pickNftIndex() {
  return (crypto.randomBytes(4).readUInt32BE(0) % NFT_COUNT) + 1;
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function formatPnlLabel(mode, pnlUsdc) {
  if (mode === 'hidden') return null;
  if (pnlUsdc == null) return null;
  const sign = pnlUsdc >= 0 ? '+' : '-';
  return `${sign}${fmtUsd(Math.abs(pnlUsdc))}`;
}

function buildOverlaySvg({ symbol, subtitle, pnlLabel, isWin, stats, footerLeft, footerRight }) {
  const pnlColor = isWin ? '#97C459' : '#E24B4A';

  const colWidth = (CARD_SIZE - 64) / stats.length;
  const statCols = stats.map((s, i) => {
    const x = 32 + i * colWidth;
    return `
    <text x="${x}" y="${CARD_SIZE - 118}" font-family="Arial, sans-serif" font-size="22" fill="#888780">${escapeXml(s.label)}</text>
    <text x="${x}" y="${CARD_SIZE - 86}" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="${s.color || '#ffffff'}">${escapeXml(s.value)}</text>`;
  }).join('');

  const pnlText = pnlLabel
    ? `<text x="${CARD_SIZE - 32}" y="53" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="${pnlColor}" text-anchor="end">${escapeXml(pnlLabel)}</text>`
    : '';

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

    ${pnlText}

    <text x="32" y="${CARD_SIZE - 190}" font-family="Arial, sans-serif" font-size="48" font-weight="bold" fill="#ffffff">${escapeXml(symbol)}</text>
    <text x="32" y="${CARD_SIZE - 158}" font-family="Arial, sans-serif" font-size="24" fill="#B4B2A9">${escapeXml(subtitle)}</text>

    ${statCols}

    <line x1="32" y1="${CARD_SIZE - 56}" x2="${CARD_SIZE - 32}" y2="${CARD_SIZE - 56}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
    <text x="32" y="${CARD_SIZE - 27}" font-family="Arial, sans-serif" font-size="18" fill="#5f5e5a">${escapeXml(footerLeft)}</text>
    <text x="${CARD_SIZE - 32}" y="${CARD_SIZE - 27}" font-family="Arial, sans-serif" font-size="18" fill="#5f5e5a" text-anchor="end">${escapeXml(footerRight)}</text>
  </svg>`;
}

async function renderCard({ symbol, subtitle, pnlLabel, isWin, stats }) {
  const idx = pickNftIndex();
  const imgPath = path.join(NFT_DIR, `${idx}.jpg`);

  const overlay = Buffer.from(buildOverlaySvg({
    symbol, subtitle, pnlLabel, isWin, stats,
    footerLeft: 't.me/panchitradingbot',
    footerRight: '@robinpanchi',
  }));

  return sharp(imgPath)
    .resize(CARD_SIZE, CARD_SIZE, { fit: 'cover' })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/** Realized-PnL card for a completed sell on a specific chain. */
export async function generateSellPnlCard({ uid, symbol, chainKey, pct, pnlUsdc, pnlPct, entryMcap, exitMcap }) {
  const { flexPnlMode } = getSettings(uid);
  const isWin = pnlUsdc >= 0;
  const pnlLabel = formatPnlLabel(flexPnlMode, pnlUsdc);
  const chainName = chainKey ? getChain(chainKey).name : null;

  const stats = [
    { label: 'Entry mcap', value: entryMcap != null ? fmtUsd(entryMcap) : 'n/a' },
    { label: 'Exit mcap', value: exitMcap != null ? fmtUsd(exitMcap) : 'n/a' },
    { label: 'PnL', value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`, color: isWin ? '#97C459' : '#E24B4A' },
  ];

  return renderCard({
    symbol,
    subtitle: chainName ? `Sold ${pct}% of position (${chainName})` : `Sold ${pct}% of position`,
    pnlLabel, isWin, stats,
  });
}

async function generateOpenPositionFlexCard(uid, wallet, chainKey, tokenAddress, pos) {
  const market = await getTokenMarketData(tokenAddress, chainKey).catch(() => null);
  if (!market) return null;

  const { flexPnlMode } = getSettings(uid);
  const chainName = getChain(chainKey).name;

  const valueUsd = pos.tokenAmount * market.priceUsd;
  const costUsd = pos.costUsdc;
  const pnlUsdc = valueUsd - costUsd;
  const pnlPct = costUsd > 0 ? (pnlUsdc / costUsd) * 100 : 0;
  const isWin = pnlUsdc >= 0;
  const pnlLabel = formatPnlLabel(flexPnlMode, pnlUsdc);

  const stats = [
    { label: 'Holding', value: fmtTokenAmount(pos.tokenAmount) },
    { label: 'Value', value: fmtUsd(valueUsd) },
    { label: 'PnL', value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`, color: isWin ? '#97C459' : '#E24B4A' },
  ];

  return renderCard({
    symbol: market.symbol,
    subtitle: pos.entryMcap != null ? `Entry mcap ${fmtUsd(pos.entryMcap)} (${chainName})` : `Open position (${chainName})`,
    pnlLabel,
    isWin,
    stats,
  });
}

async function generateClosedPositionFlexCard(uid, wallet, chainKey, tokenAddress) {
  const realized = getRealizedPnl(uid, wallet.id, chainKey, tokenAddress);
  if (!realized || realized.totalBuyUsdc <= 0) return null;

  const { flexPnlMode } = getSettings(uid);
  const chainName = getChain(chainKey).name;

  const { totalBuyUsdc, totalSellUsdc, entryMcap, exitMcap } = realized;
  const pnlUsdc = totalSellUsdc - totalBuyUsdc;
  const pnlPct = (pnlUsdc / totalBuyUsdc) * 100;
  const isWin = pnlUsdc >= 0;
  const pnlLabel = formatPnlLabel(flexPnlMode, pnlUsdc);

  const market = await getTokenMarketData(tokenAddress, chainKey).catch(() => null);
  const symbol = market?.symbol ?? shortAddr(tokenAddress);

  const stats = [
    { label: 'Entry mcap', value: entryMcap != null ? fmtUsd(entryMcap) : 'n/a' },
    { label: 'Exit mcap', value: exitMcap != null ? fmtUsd(exitMcap) : 'n/a' },
    { label: 'PnL', value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`, color: isWin ? '#97C459' : '#E24B4A' },
  ];

  return renderCard({ symbol, subtitle: `Closed position (${chainName})`, pnlLabel, isWin, stats });
}

/**
 * Entry point used by /flex. `chainKey` is the user's active chain — flex
 * only looks at that chain's position/history for this token (a token
 * address can exist on multiple EVM chains as unrelated tokens).
 */
export async function generateFlexCard(uid, chainKey, tokenAddress) {
  const w = getActiveWallet(uid);
  if (!w) return null;

  const pos = getPosition(uid, w.id, chainKey, tokenAddress);
  if (pos && pos.tokenAmount > 0) {
    return generateOpenPositionFlexCard(uid, w, chainKey, tokenAddress, pos);
  }

  return generateClosedPositionFlexCard(uid, w, chainKey, tokenAddress);
}
