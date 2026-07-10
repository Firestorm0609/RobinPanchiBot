// Sends a Telegram message to the admin chat on notable failures.
// Set ADMIN_CHAT_ID in .env to your own Telegram user/chat ID to receive these.
// If unset, alerts are silently skipped (logged to console only).

export async function sendAdminAlert(telegram, message) {
  const chatId = process.env.ADMIN_CHAT_ID;
  if (!chatId) return;
  try {
    await telegram.sendMessage(chatId, `🚨 ${message}`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Failed to send admin alert:', err.message);
  }
}
