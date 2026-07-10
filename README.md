# Panchi Trading Bot

Telegram bot for swapping tokens on Robinhood Chain via 0x, deployable on your existing VPS.

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `RPC_URL` — Alchemy free-tier endpoint for Robinhood Chain
   - `ZEROX_API_KEY` — from 0x.org dashboard (free tier available)
   - `AFFILIATE_ADDRESS` — your wallet to collect trading fees
   - `AFFILIATE_FEE_BPS` — your fee cut, in basis points (50 = 0.5%)
3. `npm start`

## Commands
- `/wallet` — generate/view trading wallet
- `/balance` — check ETH balance
- `/buy <token_address> <eth_amount>` — swap ETH for a token
- `/sell <token_address> <token_amount>` — swap a token for ETH

## Before going live (must-do, not optional)
- **Key storage**: wallets currently live in memory only (`sessions` Map in bot.js) — restart wipes them and it's not secure. Move to encrypted DB storage or ERC-4337 smart accounts with session keys.
- **Decimals**: `/sell` assumes 18 decimals — fetch actual token decimals via `IERC20.decimals()` before parsing amounts.
- **Rate limits**: Alchemy free tier will throttle at volume — monitor usage, upgrade if needed.
- **Error handling**: add slippage protection (0x quote includes `minBuyAmount`) and a max-trade-size guard.
- **Process manager**: run under `pm2` on your VPS so it restarts on crash/reboot.

## Architecture
Telegram (Telegraf) → your VPS → Alchemy RPC (Robinhood Chain) + 0x API (routing/quotes) → user's wallet signs & submits.
