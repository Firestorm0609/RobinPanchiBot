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
  balance, purely cosmetic).
- `price.js` — DexScreener (Robinhood slug bug FIXED — see Recent fixes),
  pump.fun (Solana), Uniswap Trading API fallback (Robinhood/NOXA-style
  WETH-paired launches). All working as of this checkpoint.

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
already deployed before any bridging work begins. CONFIRM this before
starting Phase 1.

## Build Plan

### Phase 0 — Prerequisites (do first, cheap)
- [ ] Confirm user has deployed the 3 files above (price.js, format.js,
      handlers/text.js) — ask if unsure, don't assume.
- [ ] Get a LI.FI API key (free tier exists — confirm current terms via
      web search, LI.FI docs may have changed).
- [ ] Add `LIFI_API_KEY` to `.env` / `.env.example`.
- [ ] `npm install @lifi/sdk` (check current package name/version via npm
      before assuming — verify it hasn't been renamed/deprecated).

### Phase 1 — Standalone bridge module (build + test in isolation)
New file: `bridge.js`
- [ ] `getBridgeQuote({ fromChainKey, toChainKey, fromToken, toToken,
      amount, fromAddress, toAddress })` — wraps LI.FI's quote endpoint.
      Must handle EVM->EVM, EVM->Solana, Solana->EVM (three distinct
      signing paths — Solana txs are NOT ethers.Wallet signed).
- [ ] `executeBridge(quote, signerOrKeypair)` — signs + submits + polls
      for completion. LI.FI bridges can take seconds to minutes — this
      MUST be async/awaitable with a timeout, not fire-and-forget.
- [ ] Test standalone: bridge a small amount of USDC (Base -> Robinhood
      Chain, becoming USDG) using a real funded test wallet BEFORE wiring
      into the bot. Do not skip this — bridging bugs move real money.
- [ ] Decide fee handling: LI.FI takes its own cut/gas on top of your
      existing AFFILIATE_FEE_BPS — work out what the user actually pays
      end-to-end and surface it in the confirm message.

### Phase 2 — Pending-trade state machine extension
`storage.js` — `pending_trades` table currently has status enum
('pending','submitted','confirmed','failed'). A bridge-then-swap flow
needs more granularity:
- [ ] Add stages: 'bridging' -> 'bridged' -> 'swapping' -> 'confirmed' (or
      'failed' at any stage). Consider a separate `bridge_hash` column
      alongside the existing `tx_hash` since a bridge-then-swap is TWO
      on-chain transactions, not one.
- [ ] `pollers.js`'s `checkStuckTrades` on restart needs to understand
      "stuck mid-bridge" as a distinct, recoverable state (funds are
      probably fine, just need to resume/retry the swap leg) vs. "stuck
      mid-swap" (same as today).

### Phase 3 — Unified balance UX
- [ ] New `getUnifiedUsdBalance(uid)` in storage.js/format.js — sums
      real per-chain balances (each fetched live, same as today) into one
      number for display purposes ONLY. Do not pretend this is atomic;
      it's a snapshot sum, chains can't be double-spent across.
- [ ] Update `renderTokenCard` / `menu_balance` to show unified total
      prominently, with per-chain breakdown available on tap (don't just
      delete the per-chain view — useful for debugging/support).

### Phase 4 — Trade flow integration (the actual "FOMO-style" behavior)
`trade-core.js` — `performBuyCore` needs a pre-flight step:
- [ ] Before quoting the swap: check if the wallet has enough of the
      target chain's stablecoin already. If yes, behave exactly as today
      (no bridge needed — cheapest/fastest path).
- [ ] If not enough on target chain: find a source chain with sufficient
      balance (prefer chain with the LARGEST balance, or let user pick —
      decide UX), bridge the shortfall, THEN swap.
- [ ] Update `executeBuy`'s user-facing messages to show both legs
      ("Bridging $50 from Base -> Robinhood Chain... Swapping into
      TOKEN..." ) rather than a single opaque "fetching quote" message,
      since this can take much longer than a same-chain swap.
- [ ] Decide: does Sell need this too (bridge proceeds back to a
      preferred chain)? Simplest v1: sells stay same-chain-only, only
      buys get auto-bridge. Revisit after v1 ships.

### Phase 5 — Batch features + auto-rules compatibility
- [ ] `handlers/batch.js` (Batch Buy) and `pollers.js` (TP/SL, limit
      orders) all call `performBuyCore`/`performSellCore` directly — once
      Phase 4 changes those functions' behavior, these callers get the
      new behavior for free IF the function signature doesn't change.
      Keep the signature stable; add bridging as internal logic, not new
      required params, so this phase should need minimal changes if
      earlier phases are done cleanly.

## Open questions to resolve before/during Phase 1
1. LI.FI pricing/fee model — confirm current terms (search, don't assume
   from training data — this space changes fast).
2. Does LI.FI's Solana support cover BOTH directions (Solana as source
   AND destination) as of today? Confirm before Phase 1 testing.
3. Bridge failure/refund handling — if a bridge fails mid-flight, where
   do funds end up? Need this answered before writing user-facing error
   messages.
4. Minimum viable bridge amount — dust amounts may not be economical to
   bridge (gas + LI.FI fee could exceed the trade). Need a floor, similar
   to existing `MIN_GAS_ETH_RESERVE` pattern.

## How to resume from this checkpoint
1. Read this file fully first.
2. Ask the user which files (if any) beyond price.js/format.js/
   handlers/text.js they've already deployed, and whether Phase 0/1 work
   has started.
3. Do NOT re-research the "is Robinhood Chain bridgeable" question — it's
   answered above. DO re-verify LI.FI-specific API/pricing details since
   those can change faster than chain support.
4. Follow phases in order — each phase is meant to be independently
   testable/shippable, don't jump to Phase 4 before Phase 1 is proven
   with a real test bridge transaction.
