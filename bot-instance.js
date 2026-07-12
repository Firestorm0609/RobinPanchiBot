import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { validateEnv } from './config.js';
import { botIdentity } from './state.js';

validateEnv();

export const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.telegram.getMe()
  .then((me) => { botIdentity.username = me.username; })
  .catch((err) => console.error('Failed to fetch bot username:', err.message));
