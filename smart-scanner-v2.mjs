/**
 * NSE Regime-Based Smart Scanner
 * --------------------------------
 * Step 1 — Detects current market regime from NIFTY daily candles
 * Step 2 — Selects the best algo for that regime
 * Step 3 — Scans your stock list with the chosen algo
 * Step 4 — Sends only actionable BUY signals to Telegram
 *
 * Regimes:
 *   VOLATILE  → ATR expanded — avoid delivery, send ORB levels for intraday
 *   BULLISH   → Uptrend — momentum + breakout scanner
 *   BEARISH   → Downtrend — stay cash alert
 *   SIDEWAYS  → Range bound — support/resistance scanner
 *
 * Usage: node smart-scanner.mjs
 */

import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();
import https from "https";

// ─── TELEGRAM ────────────────────────────────────────────────────────────────

const TELEGRAM = {
  BOT_TOKEN: "8601847341:AAGO6KGVDjM1nLcV4ds72e7IVv_GIYSKoY4",  // ← paste token here
  CHAT_ID:   "-1003595507367",                 // personal or group ID
};

// ─── STOCK LIST ───────────────────────────────────────────────────────────────

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

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  NIFTY_SYMBOL:      "^NSEI",
  LOOKBACK_DAYS:     90,
  FETCH_DELAY_MS:    400,

  // ── Regime detection ──────────────────────────────────────────────────────
  ATR_PERIOD:        14,
  ATR_AVG_PERIOD:    50,
  ATR_VOLATILE_X:    1.5,      // ATR > 1.5× its 50-day avg = VOLATILE
  EMA_FAST:          20,
  EMA_SLOW:          50,
  EMA_FLAT_BAND:     0.005,    // EMA20 within 0.5% of EMA50 = SIDEWAYS

  // ── S/R scanner (SIDEWAYS regime) ─────────────────────────────────────────
  SWING_LOOKBACK:    5,
  SR_ZONE_PCT:       0.015,
  MIN_TOUCHES:       2,
  NEAR_LEVEL_PCT:    0.02,
  VOLUME_CONFIRM_X:  1.3,
  ENTRY_BUFFER_PCT:  0.005,
  STOP_BUFFER_PCT:   0.008,
  MIN_RR:            1.5,

  // ── Breakout scanner (BULLISH regime) ─────────────────────────────────────
  HIGH_LOOKBACK_DAYS:     50,   // near 52-week high if within this many days
  HIGH_PROXIMITY_PCT:     0.03, // within 3% of recent high = breakout zone
  REL_STRENGTH_DAYS:      20,   // compare stock vs NIFTY over this many days
  BREAKOUT_VOLUME_X:      1.5,  // breakout candle must have 1.5× avg volume

  // ── ORB (VOLATILE regime) ─────────────────────────────────────────────────
  ORB_MINUTES:            15,   // opening range = first 15 min
};

// ─── TELEGRAM SENDER ─────────────────────────────────────────────────────────

function sendTelegram(message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM.CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });
    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${TELEGRAM.BOT_TOKEN}/sendMessage`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const p = JSON.parse(data);
          if (!p.ok) console.error(`[TELEGRAM] ${p.description}`);
        } catch {}
        resolve();
      });
    });
    req.on("error", (e) => { console.error(`[TELEGRAM NETWORK] ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function safeNum(v)  { const n = Number(v); return isFinite(n) ? n : null; }
function sleep(ms)   { return new Promise((r) => setTimeout(r, ms)); }
function pct(a, b)   { return ((a - b) / b) * 100; }
function fmt(n, d=2) { return n != null ? Number(n).toFixed(d) : "—"; }
function fmtINR(n)   { return n != null ? `₹${Number(n).toFixed(2)}` : "—"; }
function sanitize(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function avg(arr)    { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

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
    if (!isFinite(time) || open==null || high==null || low==null || close==null) continue;
    if (open===0 && high===0 && low===0 && close===0) continue;
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
    if (time==null || open==null || high==null || low==null || close==null) continue;
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
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close)
    );
    trs.push(tr);
  }
  // Wilder smoothing
  let atr = avg(trs.slice(0, period));
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  // Return full ATR array for avg calculation
  const atrArr = new Array(period).fill(null);
  let a = avg(trs.slice(0, period));
  atrArr.push(a);
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
    atrArr.push(a);
  }
  return { current: atr, series: atrArr.filter(Boolean) };
}

// ─── REGIME DETECTION ────────────────────────────────────────────────────────

function detectRegime(candles) {
  const closes = candles.map((c) => c.close);

  // ATR
  const atrData = calcATR(candles, CONFIG.ATR_PERIOD);
  if (!atrData) return { regime: "UNKNOWN", reason: "Not enough data for ATR" };

  const recentATRs = atrData.series.slice(-CONFIG.ATR_AVG_PERIOD);
  const avgATR     = avg(recentATRs.slice(0, -1)); // avg excluding latest
  const currentATR = atrData.current;
  const atrRatio   = avgATR > 0 ? currentATR / avgATR : 1;

  // EMA
  const ema20 = calcEMA(closes, CONFIG.EMA_FAST);
  const ema50 = calcEMA(closes, CONFIG.EMA_SLOW);
  if (!ema20 || !ema50) return { regime: "UNKNOWN", reason: "Not enough data for EMA" };

  const emaDiff    = (ema20 - ema50) / ema50;
  const ema20Full  = calcEMAFull(closes, CONFIG.EMA_FAST);
  const ema20Prev  = ema20Full[ema20Full.length - 6]; // 5 days ago
  const ema20Slope = ema20Prev ? pct(ema20, ema20Prev) : 0;

  // Regime decision
  let regime, reason, details;

  if (atrRatio >= CONFIG.ATR_VOLATILE_X) {
    regime = "VOLATILE";
    reason = `ATR is ${fmt(atrRatio)}× its ${CONFIG.ATR_AVG_PERIOD}-day average — market is highly volatile`;
  } else if (Math.abs(emaDiff) <= CONFIG.EMA_FLAT_BAND || Math.abs(ema20Slope) < 0.3) {
    regime = "SIDEWAYS";
    reason = `EMA20 and EMA50 are flat (diff: ${fmt(emaDiff * 100, 2)}%) — market is range-bound`;
  } else if (ema20 > ema50 && ema20Slope > 0) {
    regime = "BULLISH";
    reason = `EMA20 (${fmt(ema20)}) > EMA50 (${fmt(ema50)}), slope +${fmt(ema20Slope)}% — uptrend confirmed`;
  } else if (ema20 < ema50 && ema20Slope < 0) {
    regime = "BEARISH";
    reason = `EMA20 (${fmt(ema20)}) < EMA50 (${fmt(ema50)}), slope ${fmt(ema20Slope)}% — downtrend confirmed`;
  } else {
    regime = "SIDEWAYS";
    reason = `Mixed signals — treating as SIDEWAYS for safety`;
  }

  return {
    regime,
    reason,
    ema20: fmt(ema20),
    ema50: fmt(ema50),
    ema20Slope: fmt(ema20Slope, 2),
    atrRatio: fmt(atrRatio, 2),
    currentATR: fmt(currentATR, 2),
    niftyPrice: closes[closes.length - 1],
  };
}

// ─── FETCH CANDLES ────────────────────────────────────────────────────────────

async function fetchDailyCandles(symbol, days) {
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    const raw = await yahooFinance.chart(symbol, { period1, period2, interval: "1d" });
    return normalizeYahooResponse(raw);
  } catch (err) {
    return null;
  }
}

// ─── ALGO 1: S/R SCANNER (SIDEWAYS) ──────────────────────────────────────────

function findSwingPoints(candles) {
  const N = CONFIG.SWING_LOOKBACK;
  const supports = [], resistances = [];
  for (let i = N; i < candles.length - N; i++) {
    const win = candles.slice(i - N, i + N + 1);
    if (win.every((c, idx) => idx === N || candles[i].low  <= c.low))  supports.push({ price: candles[i].low,  index: i, volume: candles[i].volume });
    if (win.every((c, idx) => idx === N || candles[i].high >= c.high)) resistances.push({ price: candles[i].high, index: i, volume: candles[i].volume });
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
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);
  return clusters.map((c) => ({
    price:   avg(c.map((x) => x.price)),
    touches: c.length,
    maxVol:  Math.max(...c.map((x) => x.volume)),
  }));
}

function enrichLevels(candles, clusters, isSupport) {
  const avgVol = avg(candles.map((c) => c.volume).filter((v) => v > 0));
  return clusters.map((lvl) => {
    let touches = 0, volConfirmed = false;
    for (let i = 1; i < candles.length - 1; i++) {
      const near = Math.abs((isSupport ? candles[i].low : candles[i].high) - lvl.price) / lvl.price <= CONFIG.SR_ZONE_PCT;
      if (near) {
        touches++;
        if (candles[i + 1]?.volume >= avgVol * CONFIG.VOLUME_CONFIRM_X) volConfirmed = true;
      }
    }
    return { ...lvl, touches, volConfirmed, isSupport };
  }).filter((l) => l.touches >= CONFIG.MIN_TOUCHES);
}

function runSRScanner(candles, symbol) {
  const currentPrice = candles[candles.length - 1].close;
  const currentDate  = formatDate(candles[candles.length - 1].time);
  const { supports, resistances } = findSwingPoints(candles);
  const suppLevels = enrichLevels(candles, clusterLevels(supports),    true);
  const resLevels  = enrichLevels(candles, clusterLevels(resistances), false);

  if (!suppLevels.length) return { signal: "AVOID", reason: "No clear support levels found." };

  const suppBelow = suppLevels.filter((s) => s.price < currentPrice * 1.02).sort((a, b) => b.price - a.price);
  const resAbove  = resLevels.filter((r)  => r.price > currentPrice * 0.98).sort((a, b) => a.price - b.price);

  if (!suppBelow.length) return { signal: "AVOID", reason: "Price is below all support levels — no floor. Stay out.", currentPrice, currentDate };

  const supp       = suppBelow[0];
  const res        = resAbove[0] ?? null;
  const entryPrice = supp.price * (1 + CONFIG.ENTRY_BUFFER_PCT);
  const stopPrice  = supp.price * (1 - CONFIG.STOP_BUFFER_PCT);
  const riskPerUnit = entryPrice - stopPrice;
  const riskPct    = pct(entryPrice, stopPrice);
  const rrTarget   = entryPrice + riskPerUnit * CONFIG.MIN_RR;
  const natTarget  = res?.price ?? null;
  const target     = natTarget && natTarget > entryPrice ? Math.min(natTarget, rrTarget) : rrTarget;
  const targetPct  = pct(target, entryPrice);
  const rr         = Math.abs(targetPct / riskPct);
  const distFromSupp = pct(currentPrice, supp.price);
  const atSupport  = distFromSupp <= CONFIG.NEAR_LEVEL_PCT * 100;
  const extended   = distFromSupp > 8;

  let signal, reason, warning = null;
  if (extended)          { signal = "WAIT"; reason = `Price is ${fmt(distFromSupp, 1)}% above support — extended. Set limit at ${fmtINR(entryPrice)}.`; }
  else if (supp.touches < CONFIG.MIN_TOUCHES) { signal = "WAIT"; reason = `Support at ${fmtINR(supp.price)} has only ${supp.touches} touch — needs one more confirmation.`; }
  else if (rr < CONFIG.MIN_RR) { signal = "WAIT"; reason = `R:R is ${fmt(rr, 2)} — below minimum ${CONFIG.MIN_RR}. Target too tight.`; }
  else if (atSupport && supp.touches >= CONFIG.MIN_TOUCHES) {
    signal = "BUY";
    reason = `Price at support ${fmtINR(supp.price)} (${supp.touches}× touched${supp.volConfirmed ? ", vol ✓" : ""})`;
    if (!supp.volConfirmed) warning = "Volume not confirmed on bounce — size down.";
  } else {
    signal = "WAIT";
    reason = `Good support at ${fmtINR(supp.price)} — ${fmt(distFromSupp, 1)}% away. Set GTT limit at ${fmtINR(entryPrice)}.`;
  }

  return {
    signal, reason, warning, algo: "S/R",
    currentPrice, currentDate,
    entryPrice: +entryPrice.toFixed(2), stopPrice: +stopPrice.toFixed(2),
    target: +target.toFixed(2), riskPct: +riskPct.toFixed(2),
    targetPct: +targetPct.toFixed(2), rr: +rr.toFixed(2),
    support: supp, resistance: res,
  };
}

// ─── ALGO 2: BREAKOUT SCANNER (BULLISH) ──────────────────────────────────────

function runBreakoutScanner(candles, symbol, niftyCandles) {
  const currentPrice = candles[candles.length - 1].close;
  const currentDate  = formatDate(candles[candles.length - 1].time);
  const avgVol       = avg(candles.slice(-20).map((c) => c.volume));
  const lastVol      = candles[candles.length - 1].volume;

  // Recent high
  const recentCandles = candles.slice(-CONFIG.HIGH_LOOKBACK_DAYS);
  const recentHigh    = Math.max(...recentCandles.map((c) => c.high));
  const distFromHigh  = pct(currentPrice, recentHigh);   // negative = below high
  const nearHigh      = distFromHigh >= -CONFIG.HIGH_PROXIMITY_PCT * 100;

  // Relative strength vs NIFTY
  const stockStart  = candles[candles.length - CONFIG.REL_STRENGTH_DAYS]?.close;
  const niftyStart  = niftyCandles?.[niftyCandles.length - CONFIG.REL_STRENGTH_DAYS]?.close;
  const stockReturn = stockStart ? pct(currentPrice, stockStart) : null;
  const niftyReturn = niftyStart ? pct(niftyCandles[niftyCandles.length - 1].close, niftyStart) : null;
  const relStrength = stockReturn != null && niftyReturn != null ? stockReturn - niftyReturn : null;
  const strongRS    = relStrength != null && relStrength > 2; // outperforming NIFTY by 2%+

  // Volume on breakout
  const volumeBreakout = lastVol >= avgVol * CONFIG.BREAKOUT_VOLUME_X;

  // Stop = recent swing low (10 days)
  const recentLows  = candles.slice(-10).map((c) => c.low);
  const swingLow    = Math.min(...recentLows);
  const stopPrice   = swingLow * 0.992;
  const riskPct     = pct(currentPrice, stopPrice);
  const target      = currentPrice + (currentPrice - stopPrice) * CONFIG.MIN_RR;
  const targetPct   = pct(target, currentPrice);

  let signal, reason, warning = null;

  if (!nearHigh) {
    signal = "WAIT";
    reason = `Price is ${fmt(Math.abs(distFromHigh), 1)}% below recent ${CONFIG.HIGH_LOOKBACK_DAYS}-day high — not in breakout zone yet.`;
  } else if (!strongRS) {
    signal = "WAIT";
    reason = `Near high but relative strength vs NIFTY is weak (${relStrength != null ? fmt(relStrength, 1) + "%" : "unknown"}) — wait for RS to improve.`;
  } else if (!volumeBreakout) {
    signal = "WAIT";
    reason = `Near high with good RS but volume is only ${fmt(lastVol / avgVol, 2)}× average — need ${CONFIG.BREAKOUT_VOLUME_X}× for confirmed breakout.`;
  } else {
    signal = "BUY";
    reason = `Breaking near ${CONFIG.HIGH_LOOKBACK_DAYS}-day high (${fmtINR(recentHigh)}) with ${fmt(lastVol / avgVol, 1)}× volume. RS vs NIFTY: +${fmt(relStrength, 1)}%`;
    if (riskPct > 6) warning = `Stop is ${fmt(riskPct, 1)}% away — wide risk. Size down.`;
  }

  return {
    signal, reason, warning, algo: "BREAKOUT",
    currentPrice, currentDate,
    entryPrice: +currentPrice.toFixed(2),
    stopPrice:  +stopPrice.toFixed(2),
    target:     +target.toFixed(2),
    riskPct:    +riskPct.toFixed(2),
    targetPct:  +targetPct.toFixed(2),
    rr:         +CONFIG.MIN_RR.toFixed(2),
    recentHigh: +recentHigh.toFixed(2),
    relStrength: relStrength != null ? +relStrength.toFixed(2) : null,
    volumeRatio: +(lastVol / avgVol).toFixed(2),
  };
}

// ─── ALGO 3: ORB LEVELS (VOLATILE) ───────────────────────────────────────────

async function getORBLevels() {
  // Fetch today's 1-min or 5-min intraday candles for NIFTY
  try {
    const now    = new Date();
    const open   = new Date();
    open.setUTCHours(3, 45, 0, 0); // 09:15 IST
    const raw = await yahooFinance.chart(CONFIG.NIFTY_SYMBOL, {
      period1: open, period2: now, interval: "5m",
    });
    const candles = normalizeYahooResponse(raw);
    if (!candles || candles.length < 3) return null;

    // First 15 min = first 3 × 5-min candles
    const orbCandles = candles.slice(0, Math.ceil(CONFIG.ORB_MINUTES / 5));
    const orbHigh    = Math.max(...orbCandles.map((c) => c.high));
    const orbLow     = Math.min(...orbCandles.map((c) => c.low));
    const orbRange   = orbHigh - orbLow;
    return { orbHigh: +orbHigh.toFixed(2), orbLow: +orbLow.toFixed(2), orbRange: +orbRange.toFixed(2) };
  } catch {
    return null;
  }
}

// ─── FORMAT TELEGRAM MESSAGES ─────────────────────────────────────────────────

function regimeMessage(regimeData, algo) {
  const icons = { BULLISH: "🚀", BEARISH: "🔴", SIDEWAYS: "📊", VOLATILE: "⚠️", UNKNOWN: "❓" };
  const algoLabel = { BULLISH: "Breakout Scanner", BEARISH: "Stay Cash", SIDEWAYS: "S/R Scanner", VOLATILE: "ORB Levels (Intraday)" };
  return (
`${icons[regimeData.regime]} <b>MARKET REGIME: ${regimeData.regime}</b>
━━━━━━━━━━━━━━━━━━━━
NIFTY : ${fmtINR(regimeData.niftyPrice)}
EMA20 : ${regimeData.ema20}  |  EMA50 : ${regimeData.ema50}
Slope : ${regimeData.ema20Slope}%  |  ATR Ratio : ${regimeData.atrRatio}x
━━━━━━━━━━━━━━━━━━━━
📌 ${sanitize(regimeData.reason)}
🔧 Running : ${algoLabel[regimeData.regime] ?? algo}`
  );
}

function buyMessageSR(symbol, r, isBearish = false) {
  const name = symbol.replace(".NS", "");
  const bearishTag = isBearish ? " ⚠️ BEARISH MKT" : "";
  return (
`🟢 <b>${name} — BUY  [S/R${bearishTag}]</b>
━━━━━━━━━━━━━━━━━━━━
📅 ${r.currentDate}   💰 CMP: ${fmtINR(r.currentPrice)}
🎯 Entry  : ${fmtINR(r.entryPrice)}  (GTT limit order)
🛑 Stop   : ${fmtINR(r.stopPrice)}
✅ Target : ${fmtINR(r.target)}
📊 Risk   : ${r.riskPct}%   📈 Upside: ${r.targetPct}%   ⚖️ R:R: 1:${r.rr}
🔵 Support    : ${fmtINR(r.support?.price)} (${r.support?.touches}× touched${r.support?.volConfirmed ? ", vol ✓" : ""})
🔴 Resistance : ${r.resistance ? fmtINR(r.resistance.price) : "Not identified"}
━━━━━━━━━━━━━━━━━━━━
📌 ${sanitize(r.reason)}${r.warning ? `\n⚠️ ${sanitize(r.warning)}` : ""}
📋 Set GTT limit at ${fmtINR(r.entryPrice)} | Max hold: 20 days`
  );
}

function buyMessageBreakout(symbol, r) {
  const name = symbol.replace(".NS", "");
  return (
`🟢 <b>${name} — BUY  [BREAKOUT]</b>
━━━━━━━━━━━━━━━━━━━━
📅 ${r.currentDate}   💰 CMP: ${fmtINR(r.currentPrice)}
🎯 Entry  : ${fmtINR(r.entryPrice)}  (buy at market / limit)
🛑 Stop   : ${fmtINR(r.stopPrice)}
✅ Target : ${fmtINR(r.target)}
📊 Risk   : ${r.riskPct}%   📈 Upside: ${r.targetPct}%   ⚖️ R:R: 1:${r.rr}
📉 ${r.currentDate} High  : ${fmtINR(r.recentHigh)}
📊 Volume Ratio   : ${r.volumeRatio}× average
💪 RS vs NIFTY    : ${r.relStrength != null ? `+${r.relStrength}%` : "—"}
━━━━━━━━━━━━━━━━━━━━
📌 ${sanitize(r.reason)}${r.warning ? `\n⚠️ ${sanitize(r.warning)}` : ""}
📋 Enter on breakout candle close | Trailing stop recommended`
  );
}

function orbMessage(orb) {
  if (!orb) return `⚠️ <b>VOLATILE MARKET — ORB</b>\nCould not fetch intraday data for ORB levels.\nAvoid delivery trades today.`;
  return (
`⚠️ <b>VOLATILE MARKET — ORB LEVELS (Intraday Only)</b>
━━━━━━━━━━━━━━━━━━━━
🔼 ORB High  : ${fmtINR(orb.orbHigh)}
🔽 ORB Low   : ${fmtINR(orb.orbLow)}
📏 ORB Range : ${fmt(orb.orbRange)} pts
━━━━━━━━━━━━━━━━━━━━
📈 Buy  if NIFTY breaks above ${fmtINR(orb.orbHigh)} with volume
📉 Short if NIFTY breaks below ${fmtINR(orb.orbLow)} with volume
🛑 Stop : opposite ORB level
⚠️ Delivery trades NOT recommended today — ATR is elevated
📋 Intraday only. Exit before 13:30 IST.`
  );
}

function bearishMessage() {
  return (
`🔴 <b>MARKET REGIME: BEARISH</b>
━━━━━━━━━━━━━━━━━━━━
⛔ No delivery trades today.
Market is in a downtrend. Buying into a falling market
is the fastest way to lose capital.
━━━━━━━━━━━━━━━━━━━━
✅ Action: Stay cash.
Review your existing positions — consider trimming longs.
Better setups will come when trend reverses.`
  );
}

function summaryMessage(date, regime, buys, total) {
  const lines = [
    `📊 <b>Scan Complete — ${date}</b>`,
    `Regime : ${regime}`,
    `Scanned: ${total} stocks`,
    "",
  ];
  if (buys.length) {
    lines.push(`🟢 BUY signals (${buys.length}):`);
    buys.forEach((r) => {
      lines.push(`  • ${r.symbol.replace(".NS","")} — entry ${fmtINR(r.entryPrice)} | stop ${fmtINR(r.stopPrice)} | target ${fmtINR(r.target)}`);
    });
  } else {
    lines.push("🔍 No BUY signals today.");
    lines.push("Wait for better setups — cash is a position.");
  }
  lines.push("");
  lines.push("⚠️ Always verify on chart. Use a stop loss.");
  return lines.join("\n");
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
  const hdr  = "═".repeat(68);
  const div  = "─".repeat(68);
  const date = new Date().toISOString().slice(0, 10);

  console.log(hdr);
  console.log("  NSE Regime-Based Smart Scanner");
  console.log(hdr);
  console.log(`  Date    : ${date}  |  Stocks: ${STOCKS.length}`);
  console.log(div);

  // ── Validate token ──
  if (TELEGRAM.BOT_TOKEN === "PASTE_YOUR_BOT_TOKEN_HERE") {
    console.error("[ERROR] Paste your Telegram bot token into the TELEGRAM config.");
    process.exit(1);
  }

  // ── Step 1: Detect regime ──
  process.stdout.write("  Detecting market regime ... ");
  const niftyCandles = await fetchDailyCandles(CONFIG.NIFTY_SYMBOL, CONFIG.LOOKBACK_DAYS);
  if (!niftyCandles || niftyCandles.length < 60) {
    console.error("Failed to fetch NIFTY data.");
    process.exit(1);
  }
  const regimeData = detectRegime(niftyCandles);
  console.log(`${regimeData.regime} — ${regimeData.reason}`);
  console.log(div);

  // ── Send regime to Telegram ──
  const algoName = { BULLISH: "BREAKOUT", BEARISH: "STAY CASH", SIDEWAYS: "S/R", VOLATILE: "ORB" };
  await sendTelegram(regimeMessage(regimeData, algoName[regimeData.regime]));
  await sleep(500);

  // ── Step 2: Handle each regime ──

  // BEARISH — still scan but with warning, use S/R algo (only strong stocks survive)
  if (regimeData.regime === "BEARISH") {
    console.log("  🔴 BEARISH regime — scanning for stocks bucking the trend...");
    await sendTelegram(bearishMessage());
    await sleep(500);
    // Fall through to scan with S/R algo + bearish warning flag
  }

  // VOLATILE — send ORB levels, no delivery scan
  if (regimeData.regime === "VOLATILE") {
    console.log("  ⚠️  VOLATILE regime — fetching ORB levels for intraday...");
    const orb = await getORBLevels();
    if (orb) console.log(`  ORB High: ${fmtINR(orb.orbHigh)}  |  ORB Low: ${fmtINR(orb.orbLow)}`);
    await sendTelegram(orbMessage(orb));
    console.log("  No delivery scan in volatile conditions.");
    console.log(hdr);
    return;
  }

  // BULLISH or SIDEWAYS — scan stocks
  const regime  = regimeData.regime;
  const results = [];

  for (const symbol of STOCKS) {
    const scanIcon = regime === "BULLISH" ? "🚀" : regime === "BEARISH" ? "🔴" : "📊";
    process.stdout.write(`  ${scanIcon} ${symbol.padEnd(18)} ... `);
    await sleep(CONFIG.FETCH_DELAY_MS);

    const candles = await fetchDailyCandles(symbol, CONFIG.LOOKBACK_DAYS);
    if (!candles || candles.length < 20) {
      console.log("❌  Not enough data");
      results.push({ symbol, signal: "ERROR", error: "Not enough data" });
      continue;
    }

    let result;
    if (regime === "BULLISH") {
      result = runBreakoutScanner(candles, symbol, niftyCandles);
    } else {
      // SIDEWAYS or BEARISH — use S/R scanner
      // In BEARISH, only stocks AT strong support with volume are worth considering
      result = runSRScanner(candles, symbol);
      // Extra filter in bearish: require volume confirmation, tighten R:R
      if (regime === "BEARISH" && result.signal === "BUY") {
        if (!result.support?.volConfirmed) {
          result.signal = "WAIT";
          result.reason = `[BEARISH MARKET] ${result.reason} — skipping: volume not confirmed. Need stronger signal in downtrend.`;
        } else {
          result.warning = (result.warning ? result.warning + " " : "") +
            "BEARISH market — use 50% of normal position size. Tighter stop.";
        }
      }
    }
    result.symbol = symbol;
    results.push(result);

    const icon = result.signal === "BUY" ? "🟢" : result.signal === "WAIT" ? "🟡" : "🔴";
    console.log(`${icon} ${result.signal.padEnd(6)}  entry: ${fmtINR(result.entryPrice)}  stop: ${fmtINR(result.stopPrice)}  target: ${fmtINR(result.target)}`);

    // Send BUY signals immediately to Telegram
    if (result.signal === "BUY") {
      const msg = regime === "BULLISH"
        ? buyMessageBreakout(symbol, result)
        : buyMessageSR(symbol, result, regime === "BEARISH");
      await sendTelegram(msg);
      await sleep(300);
    }
  }

  // ── Summary ──
  const buys   = results.filter((r) => r.signal === "BUY");
  const waits  = results.filter((r) => r.signal === "WAIT");
  const avoids = results.filter((r) => r.signal === "AVOID");

  console.log();
  console.log(hdr);
  const algoUsed = regime === "BULLISH" ? "BREAKOUT" : "S/R (bearish filter applied)";
  console.log(`  REGIME: ${regime}  |  ALGO: ${regime === "BULLISH" ? "BREAKOUT" : "S/R"}`);
  console.log(hdr);
  if (buys.length)   console.log(`  🟢 BUY   : ${buys.map((r)   => r.symbol.replace(".NS","")).join("  |  ")}`);
  if (waits.length)  console.log(`  🟡 WAIT  : ${waits.map((r)  => r.symbol.replace(".NS","")).join("  |  ")}`);
  if (avoids.length) console.log(`  🔴 AVOID : ${avoids.map((r) => r.symbol.replace(".NS","")).join("  |  ")}`);
  if (!buys.length)  console.log("  No BUY signals today.");
  console.log(hdr);

  await sendTelegram(summaryMessage(date, regime, buys, STOCKS.length));
  console.log("  ✅ Alerts sent to Telegram.");
  console.log(hdr);
}

run().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
