# Panchi Bot — Unified Cross-Chain Balance ("FOMO-style") Build Plan

## Goal
Right now the bot requires the user to manually pick an active chain and
deposit that chain's stablecoin before trading on it (USDC per-EVM-chain,
USDG on Robinhood, USDC on Solana — all separate balances, no bridging).

Target: deposit once, on any supported chain, and trade any token on any
supported chain — the bot auto-bridges + auto-swaps behind the scenes,
like FOMO's "unified USD balance across chains" model.

## Key finding (confirmed, don't re-research)
Robinhood Chain IS supported by LI.FI (via Jumper, Robinhood's own listed
bridging partner). LI.FI supports EVM<->EVM and EVM<->Solana routes, and
covers every chain this bot already lists (Ethereum, Base, Arbitrum, BNB,
Robinhood, Solana). So this is buildable — no blocker there.

## Current architecture (baseline, as of this checkpoint)
- `chains.js` — central registry of 6 chains (5 EVM + Solana), each with
  its OWN stablecoin (USDC everywhere except Robinhood=USDG).
- `storage.js` — positions/balances are implicitly PER-CHAIN. There is no
  "total balance" concept anywhere. `getActiveChain(uid)` gates every
  trade/balance call.
- `trade-core.js` — `performBuyCore`/`performSellCore` operate on ONE
  chain at a time, no cross-chain awareness at all.
- `handlers/text.js` — `resolveChainForCA()` auto-switches the user's
  ACTIVE chain to wherever a pasted token has the best liquidity (already
  built, works, was just made silent per user request — no chat spam).
- `format.js` — `chainBalanceLines`, `getChainUsdcBalance`,
  `allChainsBalanceSummary` all read ONE chain's balance at a time (the
  last one loops all chains and just concatenates lines — NOT a unified
  balance, purely cosmetic). **As of Phase 3, also has
  `getUnifiedUsdBalance()` / `formatUnifiedBalanceLines()` — see below.**
- `price.js` — DexScreener (Robinhood slug bug FIXED — see Recent fixes),
  pump.fun (Solana), Uniswap Trading API fallback (Robinhood/NOXA-style
  WETH-paired launches). All working as of this checkpoint.
- `bridge.js` — **NEW as of Phase 1.** Standalone LI.FI REST wrapper. See
  below.

## Recent fixes already shipped (don't redo)
1. `DEXSCREENER_ROBINHOOD_SLUG` default corrected: 'robinhoodchain' ->
   'robinhood' (confirmed via live debug logs). Fixed in price.js.
2. Solana RPC: user added Helius `SOLANA_RPC_URL` — balances now resolve.
3. `solAddress: null` bug: was just user's OLD wallet being active
   (pre-multichain wallet) — NOT a code bug. New wallets get both
   EVM+Solana keypairs correctly via `wallet.js:createWallet()`.
4. pump.fun liquidity: reserve-based estimate was WRONG (real_sol_reserves
   is 0 post-graduation, virtual_sol_reserves is stale post-migration —
   produced numbers ~3x off DexScreener). REPLACED with: use pump.fun for
   price/mcap, merge in DexScreener's liquidityUsd when available. Shipped
   in price.js `getTokenMarketData()`.
5. Chain-auto-switch notification message removed per user request
   (handlers/text.js) — switch still happens, just silently now.
6. `PRICE_DEBUG=1` / `[price debug]` and `[format debug]` logging added to
   price.js and format.js — leave these in, they're gated behind the env
   var and harmless in production.

All fixed files were delivered as full-file artifacts (not patches) to:
price.js, format.js, handlers/text.js — user needs to have these three
already deployed before any bridging work begins. Confirmed at the start
of this build.

## Progress so far

### Phase 0 — Prerequisites — DONE
- Confirmed price.js/format.js/handlers/text.js deployed.
- **LI.FI SDK decision: NOT using `@lifi/sdk`.** It went through a
  breaking v3->v4 change right as this build started (v4 requires viem
  wallet clients + separate per-ecosystem provider packages —
  `@lifi/sdk-provider-ethereum`, `-solana`, etc.). This bot has zero viem
  dependency and signs everywhere with raw `ethers.Wallet` / Solana
  `Keypair`. Adopting v4 would mean a large unrelated refactor just to get
  bridging. **Decision: call LI.FI's REST API directly via axios**,
  matching the pattern already used for 0x (swap.js) and Jupiter
  (solana-swap.js). No new npm dependency needed (axios already in use).
- LI.FI REST API confirmed: base URL `https://li.quest/v1`, no API key
  required (200 req/2hr unauthenticated; set `LIFI_API_KEY` in .env for
  200 req/min). Default integrator fee is 25bps (LI.FI's own cut, on top
  of this bot's existing `AFFILIATE_FEE_BPS` — these are separate and
  both apply on a bridge+swap trade).
- Robinhood Chain bridging confirmed live via Jumper/LI.FI (chain launched
  July 1, 2026). Solana LI.FI chain ID confirmed: `1151111081099710`.

### Phase 1 — Standalone bridge module — DONE (code), NOT YET LIVE-TESTED
New file: `bridge.js` — delivered as a full-file artifact. Contains:
- `getBridgeQuote({ fromChainKey, toChainKey, fromToken, toToken, amount,
  fromAddress, toAddress, slippage })` — wraps `GET /v1/quote`.
- `summarizeBridgeQuote(quote)` — extracts total fee (USD), ETA, tool used,
  for confirm-message display.
- `executeBridge(quote, signerOrKeypair, opts)` — signs + submits the
  SOURCE-chain leg (EVM via ethers `sendTransaction`, Solana via raw
  `Keypair.sign` + `sendRawTransaction`, trying VersionedTransaction then
  falling back to legacy `Transaction`), then polls `GET /v1/status` until
  the bridge (and any destination-side swap LI.FI itself performs) reports
  `DONE`, `FAILED`, or times out (default 8 min). Fully awaitable —
  returns `{ ok, sourceTxHash, destTxHash, status, receivedAmount }`.
  A `TIMEOUT` result (`ok: false`) is NOT necessarily a failure — the
  source tx landed, LI.FI just hasn't confirmed completion yet; treat as
  resumable (see Phase 2).
- `checkBridgeStatus({ sourceTxHash, bridgeTool, fromChainKey, toChainKey })`
  — one-off status re-check, for resuming after a bot restart without
  re-sending anything.

**⚠️ STILL OUTSTANDING before Phase 4 can go live:** the plan's own
instruction to bridge a small real amount (e.g. Base -> Robinhood Chain
USDC->USDG) with a funded test wallet has **not been done yet**. Do this
before wiring `bridge.js` into any real trade flow — bridging bugs move
real money.

### Phase 2 — Pending-trade state machine extension — DONE
`storage.js` — delivered as a full-file artifact. Changes:
- `pending_trades` gained two columns: `bridge_hash` (source-chain tx hash
  of the bridge leg) and `bridge_from_chain` (which chain funds were
  bridged FROM). Both idempotent `ALTER TABLE` migrations, safe on an
  existing DB.
- Status enum extended: `pending -> [bridging -> bridged ->] submitted ->
  confirmed | failed`. The bridging/bridged stages are simply skipped for
  a same-chain trade — `createPendingTrade()`, `markPendingTradeSubmitted()`,
  `markPendingTradeDone()` behave EXACTLY as before for those, so no
  existing same-chain code in `trade-core.js` needed to change for this
  migration to be safe.
- New functions: `markPendingTradeBridging(id, bridgeTxHash, fromChain)`,
  `markPendingTradeBridged(id)`, `markPendingTradeSwapping(id)`.
- `getStuckPendingTrades()` replaced by `getStuckPendingTradesByKind()`,
  which splits stuck trades into `bridgeStuck` (status `bridging`/`bridged`
  — funds probably fine, just needs the swap leg resumed once Phase 4
  wires that up) vs `swapStuck` (everything else — same "verify manually"
  bucket as before bridging existed).
- `pollers.js` — delivered as a full-file artifact. `checkStuckTrades()`
  updated to use `getStuckPendingTradesByKind()` and sends a categorized
  admin alert on restart instead of one undifferentiated list.

**Note:** Phase 2 only extended the state machine and restart-recovery
alerting. It does NOT yet actually resume a stuck bridge-then-swap trade
automatically — that resume logic is Phase 4 territory once bridging is
wired into `performBuyCore`.

### Phase 3 — Unified balance UX — DONE
- `format.js` — added `getUnifiedUsdBalance(wallet)`: fetches every
  chain's stablecoin balance live (same underlying calls as the existing
  `allChainsBalanceSummary`) and sums them into one USD number, plus a
  per-chain breakdown array. Explicitly a DISPLAY-ONLY snapshot sum — NOT
  atomic, NOT spendable as one balance (chains can't be pooled without
  actually bridging, which is Phase 4). A chain that errors out gets
  `usd: null` in its row and is excluded from the total, not silently
  dropped. Also added `formatUnifiedBalanceLines()` for the "Total:
  $X\n  Chain: $Y..." block.
- `menus.js` — `renderTokenCard()` now shows a
  `Unified balance (all chains): $X` line (best-effort, never blocks the
  card on failure).
- `handlers/token.js` — `menu_balance` now leads with the unified total
  block, with the existing active-chain native+stablecoin breakdown kept
  underneath (per-chain view intentionally NOT deleted — still needed when
  actually funding a trade on a specific chain).
- `handlers/wallets.js`'s wallet-detail view (`allChainsBalanceSummary`,
  per-chain list) was left untouched — still useful for
  debugging/support, per original Phase 3 spec.

## Remaining work

### Phase 4 — Trade flow integration (the actual "FOMO-style" behavior) — NOT STARTED
`trade-core.js` — `performBuyCore` needs a pre-flight step:
- [ ] Before quoting the swap: check if the wallet has enough of the
      target chain's stablecoin already. If yes, behave exactly as today
      (no bridge needed — cheapest/fastest path).
- [ ] If not enough on target chain: find a source chain with sufficient
      balance (prefer chain with the LARGEST balance, or let user pick —
      decide UX), bridge the shortfall via `bridge.js`, THEN swap. Use the
      new `pending_trades` bridging/bridged/swapping stages from Phase 2
      to track progress and survive a restart mid-flight.
- [ ] Update `executeBuy`'s user-facing messages to show both legs
      ("Bridging $50 from Base -> Robinhood Chain... Swapping into
      TOKEN..." ) rather than a single opaque "fetching quote" message,
      since this can take much longer than a same-chain swap. Use
      `summarizeBridgeQuote()` from bridge.js to show the fee/ETA before
      confirming.
- [ ] Decide: does Sell need this too (bridge proceeds back to a
      preferred chain)? Simplest v1: sells stay same-chain-only, only
      buys get auto-bridge. Revisit after v1 ships.
- [ ] Wire restart-recovery: on `checkStuckTrades()` finding a
      `bridgeStuck` trade, use `bridge.js`'s `checkBridgeStatus()` to see
      if it actually completed while the bot was down, and resume the
      swap leg if so (currently Phase 2 only ALERTS on this, doesn't act).

### Phase 5 — Batch features + auto-rules compatibility — NOT STARTED
- [ ] `handlers/batch.js` (Batch Buy) and `pollers.js` (TP/SL, limit
      orders) all call `performBuyCore`/`performSellCore` directly — once
      Phase 4 changes those functions' behavior, these callers get the
      new behavior for free IF the function signature doesn't change.
      Keep the signature stable; add bridging as internal logic, not new
      required params, so this phase should need minimal changes if
      earlier phases are done cleanly.

## Open questions to resolve before/during Phase 4
1. ~~LI.FI pricing/fee model~~ — RESOLVED: 25bps LI.FI fee, no API key
   required, see Phase 0 above.
2. ~~Does LI.FI's Solana support cover BOTH directions~~ — RESOLVED per
   LI.FI's own docs/marketing (EVM<->Solana both ways, chain id
   `1151111081099710`), but this has NOT been proven with a real
   Solana-side test transaction yet — only EVM<->EVM has any real-money
   confidence plan drafted (Base -> Robinhood). Test a Solana leg
   specifically before trusting it in Phase 4.
3. Bridge failure/refund handling — if a bridge fails mid-flight, where
   do funds end up? Still need this answered (check LI.FI's docs on
   partial-failure/refund behavior per bridge tool used) before writing
   user-facing error messages for Phase 4.
4. Minimum viable bridge amount — dust amounts may not be economical to
   bridge (gas + LI.FI's 25bps + destination gas-top-up cost could exceed
   a small trade). Need a floor, similar to existing `MIN_GAS_ETH_RESERVE`
   pattern. Not yet decided.

## How to resume from this checkpoint
1. Read this file fully first.
2. **Do the Phase 1 real-money test bridge transaction if it still hasn't
   been done** — this blocks Phase 4 regardless of how much code is
   written, per the "bridging bugs move real money" rule.
3. Do NOT re-research: "is Robinhood Chain bridgeable" (yes), LI.FI's
   REST API shape / fee / auth requirements (documented above), or
   whether to use `@lifi/sdk` (no — REST direct, decided above). DO
   re-verify anything LI.FI-specific that could have changed since this
   checkpoint (fee %, rate limits, v4 SDK status) if picking this up much
   later.
4. Start Phase 4 once the test bridge transaction is confirmed working.
   Don't jump ahead of it.
