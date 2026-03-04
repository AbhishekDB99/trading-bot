/**
 * NSE Strategy Backtester — Last 30 Days
 * ----------------------------------------
 * Replays the last 30 trading days day by day.
 * For each day, runs the SAME S/R + Breakout logic as smart-scanner.mjs
 * using ONLY data available up to that day (no future peeking).
 * Then checks what the stock actually did over the next 20 days.
 *
 * Outputs:
 *   - Every signal generated with outcome (WIN / LOSS / OPEN / STOPPED)
 *   - Win rate, average gain, average loss, expectancy
 *   - Verdict: TRADEABLE / NEEDS WORK / DO NOT TRADE
 *
 * Usage: node backtest.mjs
 */

import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const STOCKS = [
  "VISHNU.NS",
  "TPLPLASTEH.NS",
  "CYIENTDLM.NS",
  "BHAGERIA.NS",
  "SIS.NS",
  "JSWSTEEL.NS",
  "NITIRAJ.NS",
  "AGARIND.NS",
  "ROTO.NS",
  "DREAMFOLKS.NS",
  "KOTHARIPET.NS",
  "SPAL.NS",
  "INDOCO.NS",
  "HINDUNILVR.NS",
  "VPRPL.NS",
  "EKC.NS",
  "DCXINDIA.NS",
  "DYCL.NS",
  "INTLCONV.NS",
  "CLSEL.NS",
  "JKLAKSHMI.NS",
  "TIMESGTY.NS",
  "GMRP&UI.NS",
  "SUKHJITS.NS",
  "IRMENERGY.NS",
  "MARINE.NS",
  "COROMANDEL.NS",
  "IMAGICAA.NS",
  "GABRIEL.NS",
  "SPAL.NS",
  "ADANIPOWER.NS",
  "ZAGGLE.NS",
  "NTPCGREEN.NS",
  "MAMATA.NS",
  "LATENTVIEW.NS",
  "JKTYRE.NS",
  "ALANKIT.NS",
  "THOMASCOOK.NS",
  "SCHAEFFLER.NS",
  "CEATLTD.NS",
  "ZENTEC.NS",
  "CONCORDBIO.NS",
  "MANGCHEFER.NS",
  "GRSE.NS",
  "COCHINSHIP.NS",
  "KRISHANA.NS",
  "RCF.NS",
  "DOLATALGO.NS",
  "NIVABUPA.NS",
  "OBEROIRLTY.NS",
  "CAMPUS.NS",
  "OLECTRA.NS",
  "PENIND.NS",
  "SURYAROSNI.NS",
  "RAILTEL.NS",
  "NETWEB.NS",
  "JINDALSTEL.NS",
];

const CONFIG = {
  NIFTY_SYMBOL:        "^NSEI",
  BACKTEST_DAYS:       30,       // how many trading days to replay
  TOTAL_FETCH_DAYS:    120,      // fetch extra history for indicator warmup
  MAX_HOLD_DAYS:       20,       // exit after 20 days if neither target nor stop hit

  // Regime detection
  ATR_PERIOD:          14,
  ATR_AVG_PERIOD:      50,
  ATR_VOLATILE_X:      1.5,
  EMA_FAST:            20,
  EMA_SLOW:            50,
  EMA_FLAT_BAND:       0.005,

  // S/R scanner
  SWING_LOOKBACK:      5,
  SR_ZONE_PCT:         0.015,
  MIN_TOUCHES:         2,
  NEAR_LEVEL_PCT:      0.02,
  VOLUME_CONFIRM_X:    1.3,
  ENTRY_BUFFER_PCT:    0.005,
  STOP_BUFFER_PCT:     0.008,
  MIN_RR:              1.5,

  // Breakout scanner
  HIGH_LOOKBACK_DAYS:  50,
  HIGH_PROXIMITY_PCT:  0.03,
  REL_STRENGTH_DAYS:   20,
  BREAKOUT_VOLUME_X:   1.5,

  FETCH_DELAY_MS:      350,

  // Win = target hit before stop within MAX_HOLD_DAYS
  // Partial win = closed at 20 days with profit
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function safeNum(v)  { const n = Number(v); return isFinite(n) ? n : null; }
function sleep(ms)   { return new Promise((r) => setTimeout(r, ms)); }
function pct(a, b)   { return ((a - b) / b) * 100; }
function fmt(n, d=2) { return n != null ? Number(n).toFixed(d) : "—"; }
function avg(arr)    { return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0; }

function formatDate(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

// ─── NORMALIZER ───────────────────────────────────────────────────────────────

function normalizeYahooResponse(raw) {
  if (!raw) return null;
  if (Array.isArray(raw.quotes) && raw.quotes.length > 0)
    return buildCandlesFromQuotes(raw.quotes);
  if (Array.isArray(raw.timestamp) && raw.indicators?.quote)
    return buildFromTimestamps(raw.timestamp, raw.indicators.quote[0]);
  if (raw.chart?.result?.length) {
    const r = raw.chart.result[0];
    if (r?.timestamp && r?.indicators?.quote)
      return buildFromTimestamps(r.timestamp, r.indicators.quote[0]);
  }
  return null;
}

function buildCandlesFromQuotes(quotes) {
  const candles = [];
  for (const q of quotes) {
    const dateVal = q.date ?? q.timestamp;
    if (!dateVal) continue;
    const time =
      dateVal instanceof Date                          ? dateVal.getTime() / 1000
      : typeof dateVal === "number" && dateVal > 1e12 ? dateVal / 1000
      : typeof dateVal === "number"                   ? dateVal
      : new Date(dateVal).getTime() / 1000;
    const open = safeNum(q.open), high = safeNum(q.high);
    const low  = safeNum(q.low),  close = safeNum(q.close) ?? safeNum(q.adjclose);
    const volume = safeNum(q.volume) ?? 0;
    if (!isFinite(time)||open==null||high==null||low==null||close==null) continue;
    if (open===0&&high===0&&low===0&&close===0) continue;
    candles.push({ time, open, high, low, close, volume });
  }
  return candles.length > 0 ? candles : null;
}

function buildFromTimestamps(timestamps, quote) {
  if (!timestamps || !quote) return null;
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time  = timestamps[i];
    const open  = safeNum(quote.open?.[i]),  high  = safeNum(quote.high?.[i]);
    const low   = safeNum(quote.low?.[i]),   close = safeNum(quote.close?.[i]);
    const volume = safeNum(quote.volume?.[i]) ?? 0;
    if (time==null||open==null||high==null||low==null||close==null) continue;
    candles.push({ time, open, high, low, close, volume });
  }
  return candles.length > 0 ? candles : null;
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = avg(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcEMAFull(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let ema = avg(closes.slice(0, period));
  result[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function calcATR(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    ));
  }
  let atr = avg(trs.slice(0, period));
  const series = [atr];
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    series.push(atr);
  }
  return { current: atr, series };
}

// ─── REGIME DETECTION ─────────────────────────────────────────────────────────

function detectRegime(candles) {
  const closes = candles.map((c) => c.close);
  const atrData = calcATR(candles, CONFIG.ATR_PERIOD);
  if (!atrData) return "UNKNOWN";
  const recentATRs = atrData.series.slice(-CONFIG.ATR_AVG_PERIOD);
  const avgATR = avg(recentATRs.slice(0, -1));
  const atrRatio = avgATR > 0 ? atrData.current / avgATR : 1;
  const ema20 = calcEMA(closes, CONFIG.EMA_FAST);
  const ema50 = calcEMA(closes, CONFIG.EMA_SLOW);
  if (!ema20 || !ema50) return "UNKNOWN";
  const emaDiff = (ema20 - ema50) / ema50;
  const ema20Full = calcEMAFull(closes, CONFIG.EMA_FAST);
  const ema20Prev = ema20Full[ema20Full.length - 6];
  const ema20Slope = ema20Prev ? pct(ema20, ema20Prev) : 0;

  if (atrRatio >= CONFIG.ATR_VOLATILE_X)                              return "VOLATILE";
  if (Math.abs(emaDiff) <= CONFIG.EMA_FLAT_BAND || Math.abs(ema20Slope) < 0.3) return "SIDEWAYS";
  if (ema20 > ema50 && ema20Slope > 0)                               return "BULLISH";
  if (ema20 < ema50 && ema20Slope < 0)                               return "BEARISH";
  return "SIDEWAYS";
}

// ─── S/R SCANNER ──────────────────────────────────────────────────────────────

function findSwingPoints(candles) {
  const N = CONFIG.SWING_LOOKBACK;
  const supports = [], resistances = [];
  for (let i = N; i < candles.length - N; i++) {
    const win = candles.slice(i - N, i + N + 1);
    if (win.every((c, idx) => idx === N || candles[i].low  <= c.low))  supports.push({ price: candles[i].low,  volume: candles[i].volume });
    if (win.every((c, idx) => idx === N || candles[i].high >= c.high)) resistances.push({ price: candles[i].high, volume: candles[i].volume });
  }
  return { supports, resistances };
}

function clusterLevels(points) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].price - current[0].price) / current[0].price <= CONFIG.SR_ZONE_PCT) {
      current.push(sorted[i]);
    } else { clusters.push(current); current = [sorted[i]]; }
  }
  clusters.push(current);
  return clusters.map((c) => ({ price: avg(c.map((x) => x.price)), touches: c.length }));
}

function enrichLevels(candles, clusters, isSupport) {
  const avgVol = avg(candles.map((c) => c.volume).filter((v) => v > 0));
  return clusters.map((lvl) => {
    let touches = 0, volConfirmed = false;
    for (let i = 1; i < candles.length - 1; i++) {
      const near = Math.abs((isSupport ? candles[i].low : candles[i].high) - lvl.price) / lvl.price <= CONFIG.SR_ZONE_PCT;
      if (near) { touches++; if (candles[i+1]?.volume >= avgVol * CONFIG.VOLUME_CONFIRM_X) volConfirmed = true; }
    }
    return { ...lvl, touches, volConfirmed, isSupport };
  }).filter((l) => l.touches >= CONFIG.MIN_TOUCHES);
}

function runSRScanner(candles) {
  const currentPrice = candles[candles.length - 1].close;
  const { supports, resistances } = findSwingPoints(candles);
  const suppLevels = enrichLevels(candles, clusterLevels(supports),    true);
  const resLevels  = enrichLevels(candles, clusterLevels(resistances), false);
  if (!suppLevels.length) return null;
  const suppBelow = suppLevels.filter((s) => s.price < currentPrice * 1.02).sort((a, b) => b.price - a.price);
  const resAbove  = resLevels.filter((r)  => r.price > currentPrice * 0.98).sort((a, b) => a.price - b.price);
  if (!suppBelow.length) return null;
  const supp = suppBelow[0];
  const res  = resAbove[0] ?? null;
  const entryPrice = supp.price * (1 + CONFIG.ENTRY_BUFFER_PCT);
  const stopPrice  = supp.price * (1 - CONFIG.STOP_BUFFER_PCT);
  const riskUnit   = entryPrice - stopPrice;
  const rrTarget   = entryPrice + riskUnit * CONFIG.MIN_RR;
  const target     = res?.price > entryPrice ? Math.min(res.price, rrTarget) : rrTarget;
  const rr         = Math.abs(pct(target, entryPrice) / pct(entryPrice, stopPrice));
  const distFromSupp = pct(currentPrice, supp.price);
  const atSupport  = distFromSupp <= CONFIG.NEAR_LEVEL_PCT * 100 && distFromSupp >= 0;
  if (!atSupport) return null;
  if (supp.touches < CONFIG.MIN_TOUCHES) return null;
  if (rr < CONFIG.MIN_RR) return null;
  return { entryPrice: +entryPrice.toFixed(2), stopPrice: +stopPrice.toFixed(2), target: +target.toFixed(2), support: supp, algo: "S/R" };
}

// ─── BREAKOUT SCANNER ─────────────────────────────────────────────────────────

function runBreakoutScanner(candles, niftyCandles) {
  const currentPrice = candles[candles.length - 1].close;
  const avgVol  = avg(candles.slice(-20).map((c) => c.volume));
  const lastVol = candles[candles.length - 1].volume;
  const recentHigh = Math.max(...candles.slice(-CONFIG.HIGH_LOOKBACK_DAYS).map((c) => c.high));
  const distFromHigh = pct(currentPrice, recentHigh);
  if (distFromHigh < -CONFIG.HIGH_PROXIMITY_PCT * 100) return null;
  const stockStart = candles[candles.length - CONFIG.REL_STRENGTH_DAYS]?.close;
  const niftyStart = niftyCandles?.[niftyCandles.length - CONFIG.REL_STRENGTH_DAYS]?.close;
  const stockReturn = stockStart ? pct(currentPrice, stockStart) : null;
  const niftyReturn = niftyStart ? pct(niftyCandles[niftyCandles.length - 1].close, niftyStart) : null;
  const relStrength = stockReturn != null && niftyReturn != null ? stockReturn - niftyReturn : null;
  if (!relStrength || relStrength <= 2) return null;
  if (lastVol < avgVol * CONFIG.BREAKOUT_VOLUME_X) return null;
  const swingLow  = Math.min(...candles.slice(-10).map((c) => c.low));
  const stopPrice = swingLow * 0.992;
  const target    = currentPrice + (currentPrice - stopPrice) * CONFIG.MIN_RR;
  return { entryPrice: +currentPrice.toFixed(2), stopPrice: +stopPrice.toFixed(2), target: +target.toFixed(2), algo: "BREAKOUT" };
}

// ─── SIMULATE TRADE OUTCOME ───────────────────────────────────────────────────
// Given entry, stop, target — walk forward through future candles
// and determine what actually happened

function simulateOutcome(futureCandles, entryPrice, stopPrice, target) {
  if (!futureCandles || futureCandles.length === 0) return { outcome: "OPEN", exitPrice: null, holdDays: 0, pctChange: null };

  for (let i = 0; i < Math.min(futureCandles.length, CONFIG.MAX_HOLD_DAYS); i++) {
    const c = futureCandles[i];

    // Check stop first (intraday low could have hit stop before high hit target)
    // Conservative assumption: if both stop and target hit same day, assume stop hit
    const stopHit   = c.low  <= stopPrice;
    const targetHit = c.high >= target;

    if (stopHit && targetHit) {
      // Same day — conservative: assume stop hit (gap risk)
      return { outcome: "LOSS", exitPrice: stopPrice, holdDays: i + 1, pctChange: +pct(stopPrice, entryPrice).toFixed(2) };
    }
    if (stopHit) {
      return { outcome: "LOSS", exitPrice: stopPrice, holdDays: i + 1, pctChange: +pct(stopPrice, entryPrice).toFixed(2) };
    }
    if (targetHit) {
      return { outcome: "WIN",  exitPrice: target,    holdDays: i + 1, pctChange: +pct(target, entryPrice).toFixed(2) };
    }
  }

  // Neither hit within MAX_HOLD_DAYS — close at last available price
  const exitPrice   = futureCandles[Math.min(futureCandles.length, CONFIG.MAX_HOLD_DAYS) - 1].close;
  const pctChange   = pct(exitPrice, entryPrice);
  const outcome     = pctChange > 0 ? "PARTIAL_WIN" : "PARTIAL_LOSS";
  return { outcome, exitPrice: +exitPrice.toFixed(2), holdDays: CONFIG.MAX_HOLD_DAYS, pctChange: +pctChange.toFixed(2) };
}

// ─── MAIN BACKTESTER ──────────────────────────────────────────────────────────

async function run() {
  const hdr  = "═".repeat(72);
  const div  = "─".repeat(72);
  const thin = "·".repeat(72);

  console.log(hdr);
  console.log("  NSE Strategy Backtester — Last 30 Trading Days");
  console.log(hdr);
  console.log(`  Stocks  : ${STOCKS.length}`);
  console.log(`  Window  : Last ${CONFIG.BACKTEST_DAYS} trading days`);
  console.log(`  Max Hold: ${CONFIG.MAX_HOLD_DAYS} days per trade`);
  console.log(`  Win def : Target hit before stop`);
  console.log(div);

  // ── Fetch all candles upfront (more efficient than fetching per day) ──
  console.log("  Fetching historical data...");
  const allCandles = {};

  // NIFTY first
  process.stdout.write("  NIFTY ... ");
  try {
    const period2 = new Date();
    const period1 = new Date(period2.getTime() - CONFIG.TOTAL_FETCH_DAYS * 24 * 60 * 60 * 1000);
    const raw = await yahooFinance.chart(CONFIG.NIFTY_SYMBOL, { period1, period2, interval: "1d" });
    allCandles["NIFTY"] = normalizeYahooResponse(raw);
    console.log(`✓ ${allCandles["NIFTY"]?.length ?? 0} candles`);
  } catch (e) { console.log(`❌ ${e.message.slice(0,50)}`); }

  await sleep(CONFIG.FETCH_DELAY_MS);

  for (const symbol of STOCKS) {
    process.stdout.write(`  ${symbol.padEnd(18)} ... `);
    try {
      const period2 = new Date();
      const period1 = new Date(period2.getTime() - CONFIG.TOTAL_FETCH_DAYS * 24 * 60 * 60 * 1000);
      const raw = await yahooFinance.chart(symbol, { period1, period2, interval: "1d" });
      allCandles[symbol] = normalizeYahooResponse(raw);
      console.log(`✓ ${allCandles[symbol]?.length ?? 0} candles`);
    } catch (e) {
      console.log(`❌ ${e.message.slice(0,50)}`);
      allCandles[symbol] = null;
    }
    await sleep(CONFIG.FETCH_DELAY_MS);
  }

  console.log(div);

  const niftyAll = allCandles["NIFTY"];
  if (!niftyAll || niftyAll.length < 60) {
    console.error("[ERROR] Not enough NIFTY data to backtest.");
    process.exit(1);
  }

  // ── Replay each day ──
  // We use the last BACKTEST_DAYS candles as "signal days"
  // For each signal day D:
  //   - Data available = candles[0..D] (no future peeking)
  //   - Future candles = candles[D+1..D+MAX_HOLD_DAYS]

  const totalCandles = niftyAll.length;
  const startIdx     = totalCandles - CONFIG.BACKTEST_DAYS; // first signal day index
  const allTrades    = [];

  console.log("  Running backtest...\n");
  console.log(
    "  " +
    "DATE".padEnd(12) +
    "STOCK".padEnd(14) +
    "REGIME".padEnd(10) +
    "ALGO".padEnd(10) +
    "ENTRY".padEnd(9) +
    "STOP".padEnd(9) +
    "TARGET".padEnd(9) +
    "OUTCOME".padEnd(14) +
    "P&L%"
  );
  console.log(div);

  for (let dayIdx = startIdx; dayIdx < totalCandles; dayIdx++) {
    const niftySlice = niftyAll.slice(0, dayIdx + 1);
    const signalDate = formatDate(niftyAll[dayIdx].time);

    // Detect regime for this day
    const regime = detectRegime(niftySlice);

    // Skip VOLATILE days — no delivery signals
    if (regime === "VOLATILE") continue;

    for (const symbol of STOCKS) {
      const stockAll = allCandles[symbol];
      if (!stockAll || stockAll.length < 60) continue;

      // Find the stock candle index corresponding to this nifty day
      // Match by date (within 1 day tolerance for non-trading days)
      const niftyDate = niftyAll[dayIdx].time;
      const stockDayIdx = stockAll.findIndex((c) =>
        Math.abs(c.time - niftyDate) < 86400 * 2  // within 2 days
      );
      if (stockDayIdx < 30) continue; // not enough history

      const stockSlice   = stockAll.slice(0, stockDayIdx + 1);
      const futureCandles = stockAll.slice(stockDayIdx + 1, stockDayIdx + 1 + CONFIG.MAX_HOLD_DAYS);
      if (futureCandles.length < 3) continue; // not enough future data to evaluate

      // Run the appropriate scanner (no future data — only stockSlice)
      let signal = null;
      if (regime === "BULLISH") {
        const niftySliceForRS = niftyAll.slice(0, dayIdx + 1);
        signal = runBreakoutScanner(stockSlice, niftySliceForRS);
      } else {
        // SIDEWAYS or BEARISH — S/R
        signal = runSRScanner(stockSlice);
        // Bearish filter: require volume confirmation
        if (regime === "BEARISH" && signal && !signal.support?.volConfirmed) {
          signal = null;
        }
      }

      if (!signal) continue; // no BUY signal this day

      // Simulate what happened
      const { outcome, exitPrice, holdDays, pctChange } = simulateOutcome(
        futureCandles, signal.entryPrice, signal.stopPrice, signal.target
      );

      const trade = {
        date: signalDate,
        symbol,
        regime,
        algo: signal.algo,
        entryPrice: signal.entryPrice,
        stopPrice: signal.stopPrice,
        target: signal.target,
        outcome,
        exitPrice,
        holdDays,
        pctChange,
      };
      allTrades.push(trade);

      // Console row
      const outcomeIcon =
        outcome === "WIN"          ? "✅ WIN         "
        : outcome === "LOSS"       ? "❌ LOSS        "
        : outcome === "PARTIAL_WIN"  ? "🟡 PARTIAL WIN "
        : "🟠 PARTIAL LOSS";

      const pnlStr = pctChange != null
        ? `${pctChange > 0 ? "+" : ""}${pctChange}%`
        : "—";

      console.log(
        "  " +
        signalDate.padEnd(12) +
        symbol.replace(".NS","").padEnd(14) +
        regime.padEnd(10) +
        signal.algo.padEnd(10) +
        `₹${signal.entryPrice}`.padEnd(9) +
        `₹${signal.stopPrice}`.padEnd(9) +
        `₹${signal.target}`.padEnd(9) +
        outcomeIcon.padEnd(14) +
        pnlStr
      );
    }
  }

  // ─── RESULTS ANALYSIS ────────────────────────────────────────────────────────

  if (allTrades.length === 0) {
    console.log();
    console.log("  No BUY signals generated in the last 30 days.");
    console.log("  This could mean:");
    console.log("  - Market was mostly VOLATILE (no delivery signals)");
    console.log("  - Stocks were not near support levels");
    console.log("  - S/R conditions were not met");
    console.log("  Try expanding the stock list or looser parameters.");
    return;
  }

  console.log();
  console.log(hdr);
  console.log("  BACKTEST RESULTS");
  console.log(hdr);

  const wins         = allTrades.filter((t) => t.outcome === "WIN");
  const losses       = allTrades.filter((t) => t.outcome === "LOSS");
  const partialWins  = allTrades.filter((t) => t.outcome === "PARTIAL_WIN");
  const partialLosses= allTrades.filter((t) => t.outcome === "PARTIAL_LOSS");
  const openTrades   = allTrades.filter((t) => t.outcome === "OPEN");

  const closedTrades = [...wins, ...losses, ...partialWins, ...partialLosses];
  const totalSignals = allTrades.length;
  const winRate      = closedTrades.length > 0
    ? ((wins.length + partialWins.length) / closedTrades.length * 100)
    : 0;

  const allPnls      = closedTrades.map((t) => t.pctChange).filter((p) => p != null);
  const winPnls      = [...wins, ...partialWins].map((t) => t.pctChange).filter((p) => p != null);
  const lossPnls     = [...losses, ...partialLosses].map((t) => t.pctChange).filter((p) => p != null);

  const avgWin       = winPnls.length  ? avg(winPnls)  : 0;
  const avgLoss      = lossPnls.length ? avg(lossPnls) : 0;

  // Expectancy = (winRate × avgWin) + (lossRate × avgLoss)
  const lossRate     = 100 - winRate;
  const expectancy   = (winRate / 100 * avgWin) + (lossRate / 100 * avgLoss);

  // Profit factor = gross wins / gross losses
  const grossWins    = winPnls.reduce((a, b) => a + Math.max(b, 0), 0);
  const grossLosses  = Math.abs(lossPnls.reduce((a, b) => a + Math.min(b, 0), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;

  // Avg hold days
  const avgHoldDays  = closedTrades.length
    ? avg(closedTrades.map((t) => t.holdDays))
    : 0;

  // By regime breakdown
  const regimes = [...new Set(allTrades.map((t) => t.regime))];

  console.log(`  Total signals generated : ${totalSignals}`);
  console.log(`  Closed trades           : ${closedTrades.length}`);
  console.log(`  Still open              : ${openTrades.length}`);
  console.log(thin);
  console.log(`  ✅ Full wins            : ${wins.length}`);
  console.log(`  🟡 Partial wins         : ${partialWins.length}  (held ${CONFIG.MAX_HOLD_DAYS} days, closed positive)`);
  console.log(`  ❌ Full losses          : ${losses.length}`);
  console.log(`  🟠 Partial losses       : ${partialLosses.length}  (held ${CONFIG.MAX_HOLD_DAYS} days, closed negative)`);
  console.log(thin);
  console.log(`  Win rate                : ${fmt(winRate, 1)}%  (wins+partial wins / closed trades)`);
  console.log(`  Avg winning trade       : +${fmt(avgWin, 2)}%`);
  console.log(`  Avg losing trade        : ${fmt(avgLoss, 2)}%`);
  console.log(`  Expectancy per trade    : ${fmt(expectancy, 2)}%`);
  console.log(`  Profit factor           : ${fmt(profitFactor, 2)}  (>1.5 is good)`);
  console.log(`  Avg hold days           : ${fmt(avgHoldDays, 1)} days`);
  console.log(thin);

  // Regime breakdown
  for (const regime of regimes) {
    const rTrades = allTrades.filter((t) => t.regime === regime);
    const rWins   = rTrades.filter((t) => t.outcome === "WIN" || t.outcome === "PARTIAL_WIN");
    const rWR     = rTrades.length > 0 ? (rWins.length / rTrades.length * 100) : 0;
    console.log(`  ${regime.padEnd(12)} : ${rTrades.length} signals  |  win rate: ${fmt(rWR, 1)}%`);
  }

  console.log(thin);

  // ── VERDICT ────────────────────────────────────────────────────────────────

  console.log();
  console.log(hdr);
  console.log("  VERDICT");
  console.log(hdr);

  let verdict, explanation, action;

  if (closedTrades.length < 5) {
    verdict     = "⚠️  INSUFFICIENT DATA";
    explanation = `Only ${closedTrades.length} closed trades in 30 days. Not enough to draw conclusions.`;
    action      = "Expand your stock list to 20-30 stocks and rerun. Need at least 20 trades for statistical validity.";
  } else if (expectancy > 1.5 && profitFactor > 1.5 && winRate >= 45) {
    verdict     = "✅ TRADEABLE";
    explanation = `Expectancy of ${fmt(expectancy, 2)}% per trade with ${fmt(winRate, 1)}% win rate and profit factor of ${fmt(profitFactor, 2)}.`;
    action      = "Strategy shows positive edge. Start with small position sizes (1-2% of capital per trade) and track live results for 30 more days before scaling up.";
  } else if (expectancy > 0 && profitFactor > 1.0 && winRate >= 40) {
    verdict     = "🟡 NEEDS REFINEMENT";
    explanation = `Positive expectancy (${fmt(expectancy, 2)}%) but not strong enough to trade confidently. Profit factor: ${fmt(profitFactor, 2)}.`;
    action      = "Strategy has a slight edge but needs improvement. Consider: (1) requiring 3 touches instead of 2, (2) adding volume confirmation as mandatory, (3) only trading in BULLISH/SIDEWAYS regimes.";
  } else if (expectancy > 0) {
    verdict     = "🟠 MARGINAL — DO NOT TRADE YET";
    explanation = `Technically positive expectancy (${fmt(expectancy, 2)}%) but win rate of ${fmt(winRate, 1)}% and profit factor of ${fmt(profitFactor, 2)} are too low for consistent profitability.`;
    action      = "Do not trade this strategy with real money. The edge is too thin — transaction costs and slippage will wipe it out. Tighten entry criteria significantly.";
  } else {
    verdict     = "❌ DO NOT TRADE";
    explanation = `Negative expectancy (${fmt(expectancy, 2)}% per trade). Strategy loses money on average. Win rate: ${fmt(winRate, 1)}%.`;
    action      = "This strategy is not working for these stocks in this period. Fundamental logic needs revisiting — support levels may not be holding. Consider adding trend filter or requiring stronger volume confirmation.";
  }

  console.log(`  ${verdict}`);
  console.log();
  console.log(`  ${explanation}`);
  console.log();
  console.log(`  Action: ${action}`);
  console.log();

  // Honest caveats
  console.log(div);
  console.log("  ⚠️  IMPORTANT CAVEATS");
  console.log(div);
  console.log("  1. 30 days is a short sample — results can change with more data");
  console.log("  2. Backtest assumes you got filled at entry price exactly — real");
  console.log("     trades have slippage, especially on limit orders");
  console.log("  3. This does not account for brokerage, STT, or exchange charges");
  console.log("     (~0.3-0.5% per round trip — reduces expectancy by that much)");
  console.log("  4. Past performance does not guarantee future results");
  console.log("  5. Run this again after adding more stocks for better sample size");
  console.log(hdr);
}

run().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
