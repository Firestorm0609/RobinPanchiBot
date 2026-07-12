import { bot } from './bot-instance.js';
import { renderTokenCard, renderPositionsView, renderPortfolioView } from './menus.js';
import {
  autoRefreshTimers, stopAutoRefresh,
  positionsRefreshTimers, stopPositionsRefresh,
  portfolioRefreshTimers, stopPortfolioRefresh,
} from './state.js';

// Keeps the last-viewed token card / positions list / portfolio summary live
// in place without the user having to tap Refresh. Only one of each runs per
// user — each call clears any prior timer of that kind for that uid.

const AUTO_REFRESH_INTERVAL_MS = 30_000;

export function scheduleCardAutoRefresh(uid, tokenAddress, chatId, messageId) {
  stopAutoRefresh(uid);
  const key = String(uid);
  const timer = setInterval(async () => {
    try {
      const { text, markup } = await renderTokenCard(uid, tokenAddress);
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        ...markup,
      });
    } catch (err) {
      // "message is not modified" just means nothing changed since last
      // tick — not an error, keep the timer running.
      if (err.description?.includes('message is not modified')) return;
      // Anything else (message deleted, chat gone, bot blocked, user
      // navigated away and the message no longer exists) — stop trying.
      stopAutoRefresh(key);
    }
  }, AUTO_REFRESH_INTERVAL_MS);
  autoRefreshTimers.set(key, timer);
}

export function schedulePositionsAutoRefresh(uid, chatId, messageId) {
  stopPositionsRefresh(uid);
  const key = String(uid);
  const timer = setInterval(async () => {
    try {
      const { text, markup } = await renderPositionsView(uid);
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        ...markup,
      });
    } catch (err) {
      if (err.description?.includes('message is not modified')) return;
      stopPositionsRefresh(key);
    }
  }, AUTO_REFRESH_INTERVAL_MS);
  positionsRefreshTimers.set(key, timer);
}

export function schedulePortfolioAutoRefresh(uid, chatId, messageId) {
  stopPortfolioRefresh(uid);
  const key = String(uid);
  const timer = setInterval(async () => {
    try {
      const { text, markup } = await renderPortfolioView(uid);
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        ...markup,
      });
    } catch (err) {
      if (err.description?.includes('message is not modified')) return;
      stopPortfolioRefresh(key);
    }
  }, AUTO_REFRESH_INTERVAL_MS);
  portfolioRefreshTimers.set(key, timer);
}
