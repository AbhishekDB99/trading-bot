# NSE Trading Tools — Project Context & Handoff Prompt v2

## What We Built (Complete Suite)

4 Node.js ESM scripts for NSE market analysis, regime detection, and Telegram alerts.

---

## Tech Stack
- Node.js (ESM — `"type": "module"` in package.json)
- `yahoo-finance2` — market data
- Native `https` module — Telegram (no extra packages)
- Telegram Bot API — alerts

## Setup (one time)
```bash
npm init -y
npm pkg set type="module"
npm install yahoo-finance2
```

---

## Files

### 1. `nifty-analysis.mjs` — Single symbol intraday observer
- 5-min candles, single stock/index
- Direction: BULLISH/BEARISH/SIDEWAYS (consecutive close comparisons)
- Volatility: VOLATILE/NORMAL (last candle range vs avg range)
- Alert engine: LONG_ENTRY / SHORT_ENTRY / EXIT_NOW / AVOID / WATCH
- Time rules: entry 09:30–13:30, hard exit 14:30, Thursday expiry rules
- Historical mode: `TARGET_DATE: "YYYY-MM-DD"` (null = live)
- Symbols: stocks = `SYMBOL.NS`, NIFTY = `^NSEI`, BankNifty = `^NSEBANK`

### 2. `nifty-scanner.mjs` — Multi-stock intraday scanner
- Same logic as nifty-analysis.mjs across multiple stocks
- Ranked output: LONG / SHORT / AVOID per stock
- Add stocks to STOCKS array with `.NS` suffix

### 3. `smart-scanner.mjs` — Regime-based delivery scanner + Telegram ⭐
- Daily candles, 90-day lookback
- Step 1: Detects NIFTY market regime
- Step 2: Switches algo based on regime
- Step 3: Scans stocks, sends BUY-only alerts to Telegram

**Regime detection logic:**
```
ATR(14) > 1.5× ATR 50-day avg        → VOLATILE
EMA20 > EMA50 + positive slope        → BULLISH
EMA20 < EMA50 + negative slope        → BEARISH
EMA flat / mixed                      → SIDEWAYS
```

**Algo per regime:**
```
BULLISH  → Breakout scanner (near 50-day high + RS vs NIFTY + volume)
SIDEWAYS → S/R scanner (price at support, 2+ touches, volume confirm)
BEARISH  → S/R scanner with stricter filter (volume confirm mandatory)
           + 50% position size warning on every BUY
VOLATILE → No delivery scan. Sends ORB levels for intraday only.
```

**S/R detection logic:**
- Swing point detection (5 candles each side)
- Cluster nearby levels within 1.5% into single zones
- Min 2 touches to call a level valid
- Volume confirmation: bounce candle >= 1.3× avg volume
- BUY = price at support (within 2%) + 2+ touches + R:R >= 1.5
- WAIT = price above support (not pulled back) OR weak support OR poor R:R
- AVOID = price below all support OR no support found
- Entry = support + 0.5% buffer (for GTT limit orders)
- Stop = support - 0.8% (below support level)
- Target = min(next resistance, 1.5× R:R target)

**Breakout scanner logic:**
- Price within 3% of 50-day high
- Stock outperforming NIFTY by 2%+ over 20 days (relative strength)
- Last candle volume >= 1.5× average
- Stop = below 10-day swing low
- Target = entry + (entry - stop) × 1.5

**Telegram:**
- Sends regime message first
- Individual BUY alerts as found
- Summary at end
- BEARISH/VOLATILE send warning messages instead of scanning

### 4. `backtest.mjs` — Strategy backtester + Telegram results
- Replays last N trading days (set BACKTEST_DAYS)
- Uses ONLY data available on each signal day (no future peeking)
- Runs same regime detection + S/R + breakout logic as smart-scanner
- Simulates trade outcomes over next 20 days
- Classifies: WIN / LOSS / PARTIAL_WIN / PARTIAL_LOSS
- Calculates: win rate, avg win, avg loss, expectancy, profit factor
- Verdict: TRADEABLE / NEEDS REFINEMENT / MARGINAL / DO NOT TRADE
- Sends per-trade breakdown + full summary to Telegram

**Current backtest config (CHANGE THESE):**
```js
BACKTEST_DAYS:    180,   // 6 months (was 30)
TOTAL_FETCH_DAYS: 300,   // warmup history
MAX_HOLD_DAYS:    20,    // exit after 20 days if neither target nor stop hit
```

---

## Telegram Setup
- Bot: `@richierich2bot`
- Personal Chat ID: `5975650526`
- Group: add bot → send message → get group ID (negative number) from:
  `https://api.telegram.org/bot<TOKEN>/getUpdates`
- Token goes in TELEGRAM config at top of each file
- NEVER share token publicly — revoke via @BotFather → /revoke if exposed

---

## Yahoo Finance Quirks (All Handled)
1. 4 response shapes normalised (meta+quotes, timestamp+indicators, chart.result, array)
2. Ghost zero candles filtered (open=high=low=close=0)
3. NSE stocks = `SYMBOL.NS` | NIFTY = `^NSEI` | BankNifty = `^NSEBANK`
4. Valid intervals: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1d
5. Telegram HTML entities sanitized (`<` → `&lt;` etc.) to prevent parse errors

---

## Key Design Decisions

| Decision | Reason |
|---|---|
| Regime-based algo switching | Different market conditions need different strategies |
| S/R from swing points not EMA | EMA is lagging — S/R is where market actually reacted |
| Entry = support + buffer | Predetermined limit order level, not current price |
| Stop = below support | If support breaks, thesis is wrong |
| BEARISH still scans | Stocks bucking the trend exist — but stricter filter |
| BUY only on Telegram | No spam — only actionable signals |
| Volume confirmation | Filters out weak bounces, confirms institutional activity |
| 6-month backtest | 30 days too short — need 50+ trades for statistical validity |
| Expectancy metric | Better than win rate alone — accounts for size of wins/losses |

---

## What This Does NOT Do
- No auto-trading / broker API
- No options premium / IV / Greeks data
- No position sizing calculation
- No P&L tracking of live trades
- No portfolio-level risk management

---

## Suggested Next Steps
1. **Position sizing** — risk fixed ₹ amount per trade based on stop distance
2. **Scheduler** — auto-run smart-scanner.mjs daily at 4:00 PM IST via node-cron
3. **Trade journal** — log every live signal to CSV/JSON, track actual outcome
4. **Expand stock universe** — 30+ stocks gives better signal frequency
5. **Longer backtest** — 1 year gives 100+ trades, statistically reliable verdict
6. **Options layer** — fetch NSE IV data to filter high-IV entries for options trades

---

## Continuation Prompt

Paste this into a new Claude chat to continue exactly where we left off:

---

> I am building a Node.js (ESM) NSE trading analysis suite. Here is the full context:
>
> **4 scripts built:**
> - `nifty-analysis.mjs` — intraday single symbol (5-min candles, direction + volatility, options/equity alert engine with time rules)
> - `nifty-scanner.mjs` — intraday multi-stock scanner
> - `smart-scanner.mjs` — regime-based delivery scanner with Telegram BUY-only alerts
> - `backtest.mjs` — 6-month backtester with Telegram results
>
> **Tech:** Node.js ESM, yahoo-finance2, native https for Telegram
>
> **Regime detection (NIFTY daily candles):**
> - VOLATILE = ATR(14) > 1.5× 50-day ATR avg
> - BULLISH = EMA20 > EMA50 + rising slope
> - BEARISH = EMA20 < EMA50 + falling slope (still scans with stricter filter)
> - SIDEWAYS = flat EMA / mixed signals
>
> **Algo per regime:**
> - BULLISH → Breakout (near 50-day high + RS vs NIFTY >2% + volume 1.5×)
> - SIDEWAYS/BEARISH → S/R (swing points, 1.5% clustering, 2+ touches, vol confirm)
> - VOLATILE → ORB levels for intraday, no delivery scan
>
> **S/R trade levels:**
> - Entry = support + 0.5% | Stop = support - 0.8% | Target = min(resistance, 1.5× R:R)
> - BUY only when price at support (within 2%) + 2+ touches + R:R >= 1.5
>
> **Telegram:** Bot @richierich2bot, Chat ID 5975650526
> - smart-scanner sends BUY signals only
> - backtest sends per-trade breakdown + verdict summary
> - Telegram HTML sanitized (< > & escaped)
>
> **Yahoo Finance:** 4 response shapes handled, ghost candles filtered, .NS suffix for NSE stocks
>
> **Backtest config:** BACKTEST_DAYS=180, TOTAL_FETCH_DAYS=300, MAX_HOLD_DAYS=20
> Win = target hit before stop. Verdict based on expectancy + profit factor + win rate.
>
> **Next I want to build:** [DESCRIBE WHAT YOU WANT NEXT HERE]
