/**
 * NSE Stock Scanner — Delivery + Intraday
 * ----------------------------------------
 * Scans stocks using Support/Resistance levels (daily candles)
 * and sends alerts to Telegram.
 *
 * Setup:
 *   1. npm install yahoo-finance2 node-fetch
 *   2. Paste your Telegram Bot Token below
 *   3. node scanner.mjs
 */

import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();
import https from "https";

// ─── TELEGRAM CONFIG ─────────────────────────────────────────────────────────

const TELEGRAM = {
  BOT_TOKEN: "8601847341:AAGO6KGVDjM1nLcV4ds72e7IVv_GIYSKoY4", // ← paste your token here
  // CHAT_ID: "5975650526",
  CHAT_ID: "-1003595507367",
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
  NIFTY_SYMBOL: "^NSEI",
  LOOKBACK_DAYS: 90, // days of daily candle history to fetch

  // Support/Resistance detection
  SWING_LOOKBACK: 5, // candles each side to confirm a swing point
  SR_ZONE_PCT: 0.015, // 1.5% — merge levels this close together into one zone
  MIN_TOUCHES: 2, // minimum touches to call a level valid
  NEAR_LEVEL_PCT: 0.02, // 2% — price is "at" a level if within this %
  VOLUME_CONFIRM_X: 1.3, // bounce volume must be 1.3× average to confirm

  // Trade levels
  ENTRY_BUFFER_PCT: 0.005, // enter 0.5% above support (limit order buffer)
  STOP_BUFFER_PCT: 0.008, // stop 0.8% below support
  MIN_RR: 1.5, // minimum risk:reward to flag as BUY

  FETCH_DELAY_MS: 400,
};

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM.CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM.BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            console.error(`[TELEGRAM ERROR] ${parsed.description}`);
          }
          resolve(parsed);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", (err) => {
      console.error(`[TELEGRAM NETWORK ERROR] ${err.message}`);
      resolve(null); // don't crash scanner on telegram failure
    });

    req.write(body);
    req.end();
  });
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function safeNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function pct(a, b) {
  return ((a - b) / b) * 100;
}
function fmt(n, d = 2) {
  return n != null ? Number(n).toFixed(d) : "—";
}
function fmtINR(n) {
  return n != null ? `₹${Number(n).toFixed(2)}` : "—";
}

function formatDate(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function avgVolume(candles) {
  const vols = candles.map((c) => c.volume).filter((v) => v > 0);
  return vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 1;
}

// ─── NORMALIZER ───────────────────────────────────────────────────────────────

function normalizeYahooResponse(raw) {
  if (!raw) return null;
  if (Array.isArray(raw.quotes) && raw.quotes.length > 0)
    return buildCandlesFromQuotes(raw.quotes);
  if (Array.isArray(raw.timestamp) && raw.indicators?.quote)
    return buildCandlesFromTimestamps(raw.timestamp, raw.indicators.quote[0]);
  if (raw.chart?.result?.length) {
    const r = raw.chart.result[0];
    if (r?.timestamp && r?.indicators?.quote)
      return buildCandlesFromTimestamps(r.timestamp, r.indicators.quote[0]);
  }
  return null;
}

function buildCandlesFromQuotes(quotes) {
  const candles = [];
  for (const q of quotes) {
    const dateVal = q.date ?? q.timestamp;
    if (!dateVal) continue;
    const time =
      dateVal instanceof Date
        ? dateVal.getTime() / 1000
        : typeof dateVal === "number" && dateVal > 1e12
          ? dateVal / 1000
          : typeof dateVal === "number"
            ? dateVal
            : new Date(dateVal).getTime() / 1000;
    const open = safeNum(q.open),
      high = safeNum(q.high);
    const low = safeNum(q.low),
      close = safeNum(q.close) ?? safeNum(q.adjclose);
    const volume = safeNum(q.volume) ?? 0;
    if (
      !isFinite(time) ||
      open == null ||
      high == null ||
      low == null ||
      close == null
    )
      continue;
    if (open === 0 && high === 0 && low === 0 && close === 0) continue;
    candles.push({ time, open, high, low, close, volume });
  }
  return candles.length > 0 ? candles : null;
}

function buildCandlesFromTimestamps(timestamps, quote) {
  if (!timestamps || !quote) return null;
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i];
    const open = safeNum(quote.open?.[i]),
      high = safeNum(quote.high?.[i]);
    const low = safeNum(quote.low?.[i]),
      close = safeNum(quote.close?.[i]);
    const volume = safeNum(quote.volume?.[i]) ?? 0;
    if (
      time == null ||
      open == null ||
      high == null ||
      low == null ||
      close == null
    )
      continue;
    candles.push({ time, open, high, low, close, volume });
  }
  return candles.length > 0 ? candles : null;
}

// ─── SUPPORT / RESISTANCE DETECTION ─────────────────────────────────────────
//
// Step 1: Find swing lows (support) and swing highs (resistance)
//         A swing low  = candle[i].low  is lower than N candles on each side
//         A swing high = candle[i].high is higher than N candles on each side
//
// Step 2: Cluster nearby levels (within SR_ZONE_PCT) into a single zone
//         This prevents treating ₹140 and ₹141 as two separate levels
//
// Step 3: Count how many times price came back and touched each level
//         A "touch" = any candle's low (for support) came within SR_ZONE_PCT
//
// Step 4: Confirm with volume — if the bounce candle had above-avg volume,
//         the level is stronger

function findSwingPoints(candles) {
  const N = CONFIG.SWING_LOOKBACK;
  const supports = [];
  const resistances = [];

  for (let i = N; i < candles.length - N; i++) {
    // Swing low: lowest low in a window of 2N+1 candles
    const isSwingLow = candles
      .slice(i - N, i + N + 1)
      .every((c, idx) => idx === N || candles[i].low <= c.low);

    // Swing high: highest high in a window
    const isSwingHigh = candles
      .slice(i - N, i + N + 1)
      .every((c, idx) => idx === N || candles[i].high >= c.high);

    if (isSwingLow)
      supports.push({
        price: candles[i].low,
        index: i,
        volume: candles[i].volume,
      });
    if (isSwingHigh)
      resistances.push({
        price: candles[i].high,
        index: i,
        volume: candles[i].volume,
      });
  }

  return { supports, resistances };
}

function clusterLevels(points) {
  if (!points.length) return [];

  // Sort by price
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const refPrice = current[0].price;
    const thisPrice = sorted[i].price;
    // If within zone %, merge into current cluster
    if (Math.abs(thisPrice - refPrice) / refPrice <= CONFIG.SR_ZONE_PCT) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  // Represent each cluster by its average price and total touches
  return clusters.map((cluster) => ({
    price: cluster.reduce((a, b) => a + b.price, 0) / cluster.length,
    touches: cluster.length,
    maxVol: Math.max(...cluster.map((c) => c.volume)),
  }));
}

function countTouchesAndVolume(candles, levelPrice, isSupport) {
  const avgVol = avgVolume(candles);
  let touches = 0;
  let volConfirmed = false;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const near =
      Math.abs((isSupport ? c.low : c.high) - levelPrice) / levelPrice <=
      CONFIG.SR_ZONE_PCT;

    if (near) {
      touches++;
      // Volume confirmation: bounce candle (next candle after touch) has high volume
      if (i + 1 < candles.length) {
        const bouncCandle = candles[i + 1];
        if (bouncCandle.volume >= avgVol * CONFIG.VOLUME_CONFIRM_X) {
          volConfirmed = true;
        }
      }
    }
  }

  return { touches, volConfirmed };
}

function detectSRLevels(candles) {
  const { supports, resistances } = findSwingPoints(candles);

  // Cluster raw swing points
  const suppClusters = clusterLevels(supports);
  const resClusters = clusterLevels(resistances);

  // Enrich with touch counts and volume confirmation
  const enriched = (clusters, isSupport) =>
    clusters
      .map((lvl) => {
        const { touches, volConfirmed } = countTouchesAndVolume(
          candles,
          lvl.price,
          isSupport,
        );
        return { ...lvl, touches, volConfirmed, isSupport };
      })
      .filter((lvl) => lvl.touches >= CONFIG.MIN_TOUCHES);

  return {
    supports: enriched(suppClusters, true),
    resistances: enriched(resClusters, false),
  };
}

// ─── TRADE DECISION ───────────────────────────────────────────────────────────

function evaluateDeliveryTrade(candles, symbol) {
  const currentPrice = candles[candles.length - 1].close;
  const currentDate = formatDate(candles[candles.length - 1].time);
  const avgVol = avgVolume(candles);
  const lastVol = candles[candles.length - 1].volume;

  const { supports, resistances } = detectSRLevels(candles);

  if (!supports.length) {
    return {
      signal: "AVOID",
      reason: "No clear support levels found in last 90 days.",
    };
  }

  // Sort supports descending — closest support below price first
  const suppBelow = supports
    .filter((s) => s.price < currentPrice * 1.02) // allow slight overshoot
    .sort((a, b) => b.price - a.price);

  // Sort resistances ascending — closest resistance above price first
  const resAbove = resistances
    .filter((r) => r.price > currentPrice * 0.98)
    .sort((a, b) => a.price - b.price);

  if (!suppBelow.length) {
    return {
      signal: "AVOID",
      reason:
        "Price is below all known support levels — no floor. Don't buy a falling stock.",
      supports,
      resistances,
    };
  }

  const nearestSupport = suppBelow[0];
  const nearestResistance = resAbove[0] ?? null;

  // How far is current price from nearest support?
  const distFromSupport = pct(currentPrice, nearestSupport.price); // positive = above support

  // Entry, stop, target
  const entryPrice = nearestSupport.price * (1 + CONFIG.ENTRY_BUFFER_PCT);
  const stopPrice = nearestSupport.price * (1 - CONFIG.STOP_BUFFER_PCT);
  const riskPerUnit = entryPrice - stopPrice;
  const riskPct = pct(entryPrice, stopPrice);

  // Target = next resistance, or R:R based, whichever is closer (conservative)
  const rrTarget = entryPrice + riskPerUnit * CONFIG.MIN_RR;
  const natTarget = nearestResistance ? nearestResistance.price : null;
  const target =
    natTarget && natTarget > entryPrice
      ? Math.min(natTarget, rrTarget) > entryPrice
        ? Math.min(natTarget, rrTarget)
        : rrTarget
      : rrTarget;
  const targetPct = pct(target, entryPrice);
  const rr = targetPct / Math.abs(riskPct);

  // ── Signal decision ──────────────────────────────────────────────────────

  // Price is AT support right now (within NEAR_LEVEL_PCT)
  const atSupport = distFromSupport <= CONFIG.NEAR_LEVEL_PCT * 100;

  // Price is extended above support — wait for pullback
  const extended = distFromSupport > 8;

  // Support is strong
  const strongSupp = nearestSupport.touches >= CONFIG.MIN_TOUCHES;
  const volConfirmed = nearestSupport.volConfirmed;

  // R:R acceptable
  const rrOK = rr >= CONFIG.MIN_RR;

  let signal,
    reason,
    warning = null;

  if (extended) {
    signal = "WAIT";
    reason = `Price is ${fmt(distFromSupport, 1)}% above nearest support ₹${fmt(nearestSupport.price)} — extended. Set a limit order and wait for pullback.`;
  } else if (!strongSupp) {
    signal = "WAIT";
    reason = `Support at ₹${fmt(nearestSupport.price)} has only ${nearestSupport.touches} touch(es) — not strong enough yet. Wait for one more confirmation.`;
  } else if (!rrOK) {
    signal = "WAIT";
    reason = `R:R is only ${fmt(rr, 2)} — below minimum ${CONFIG.MIN_RR}. Target too close to entry or stop too wide.`;
  } else if (atSupport && strongSupp) {
    signal = "BUY";
    reason = `Price is at support ₹${fmt(nearestSupport.price)} (${nearestSupport.touches} touches${volConfirmed ? ", volume confirmed" : ""}). Entry zone is valid.`;
    if (!volConfirmed)
      warning = "Volume not confirmed on bounce — size down, watch carefully.";
  } else {
    signal = "WAIT";
    reason = `Price is ${fmt(distFromSupport, 1)}% above support. Good level at ₹${fmt(nearestSupport.price)} — set limit order there.`;
  }

  return {
    signal,
    reason,
    warning,
    currentPrice,
    currentDate,
    nearestSupport,
    nearestResistance,
    entryPrice: Number(entryPrice.toFixed(2)),
    stopPrice: Number(stopPrice.toFixed(2)),
    target: Number(target.toFixed(2)),
    riskPct: Number(riskPct.toFixed(2)),
    targetPct: Number(targetPct.toFixed(2)),
    rr: Number(rr.toFixed(2)),
    distFromSupport: Number(distFromSupport.toFixed(1)),
    supports,
    resistances,
    lastVol,
    avgVol,
  };
}

// ─── FORMAT TELEGRAM MESSAGE ─────────────────────────────────────────────────

function formatTelegramMessage(symbol, result, niftyTrend) {
  const name = symbol.replace(".NS", "");

  if (result.error) {
    return `❌ <b>${name}</b> — Error: ${result.error}`;
  }

  const icon =
    result.signal === "BUY" ? "🟢" : result.signal === "WAIT" ? "🟡" : "🔴";

  const niftyWarn =
    niftyTrend === "DOWNTREND"
      ? "\n⚠️ <b>NIFTY is in downtrend</b> — reduce size by 50%"
      : "";

  const suppStr = result.nearestSupport
    ? `${fmtINR(result.nearestSupport.price)} (${result.nearestSupport.touches}× touched${result.nearestSupport.volConfirmed ? ", vol ✓" : ""})`
    : "—";

  const resStr = result.nearestResistance
    ? `${fmtINR(result.nearestResistance.price)} (${result.nearestResistance.touches}× touched)`
    : "Not identified";

  if (result.signal === "BUY") {
    return `${icon} <b>${name} — BUY SIGNAL</b>
━━━━━━━━━━━━━━━━━━━━
📅 Date       : ${result.currentDate}
💰 CMP        : ${fmtINR(result.currentPrice)}

🎯 Entry Zone : ${fmtINR(result.entryPrice)} (limit order)
🛑 Stop Loss  : ${fmtINR(result.stopPrice)}
✅ Target     : ${fmtINR(result.target)}

📊 Risk       : ${result.riskPct}%
📈 Upside     : ${result.targetPct}%
⚖️  R:R        : 1 : ${result.rr}

🔵 Support    : ${suppStr}
🔴 Resistance : ${resStr}
━━━━━━━━━━━━━━━━━━━━
📌 ${result.reason}${result.warning ? `\n⚠️ ${result.warning}` : ""}${niftyWarn}
━━━━━━━━━━━━━━━━━━━━
📋 <b>Action:</b> Set GTT limit order at ${fmtINR(result.entryPrice)}
   Stop at ${fmtINR(result.stopPrice)} | Exit in max 20 days`;
  }

  if (result.signal === "WAIT") {
    return `${icon} <b>${name} — WAIT</b>
━━━━━━━━━━━━━━━━━━━━
📅 Date       : ${result.currentDate}
💰 CMP        : ${fmtINR(result.currentPrice)}
🔵 Support    : ${suppStr}
🎯 Set limit  : ${fmtINR(result.entryPrice)}
🛑 Stop Loss  : ${fmtINR(result.stopPrice)}
✅ Target     : ${fmtINR(result.target)}
━━━━━━━━━━━━━━━━━━━━
📌 ${result.reason}${niftyWarn}`;
  }

  // AVOID
  return `${icon} <b>${name} — AVOID</b>
━━━━━━━━━━━━━━━━━━━━
📅 Date  : ${result.currentDate}
💰 CMP   : ${fmtINR(result.currentPrice)}
━━━━━━━━━━━━━━━━━━━━
📌 ${result.reason}`;
}

// ─── FETCH ONE SYMBOL ─────────────────────────────────────────────────────────

async function fetchAndAnalyze(symbol) {
  const period2 = new Date();
  const period1 = new Date(
    period2.getTime() - CONFIG.LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  let raw;
  try {
    raw = await yahooFinance.chart(symbol, {
      period1,
      period2,
      interval: "1d",
    });
  } catch (err) {
    return { symbol, error: err.message.slice(0, 80) };
  }

  const candles = normalizeYahooResponse(raw);
  if (!candles) return { symbol, error: "Could not parse Yahoo response" };
  if (candles.length < 20)
    return {
      symbol,
      error: `Only ${candles.length} candles — need at least 20`,
    };

  const result = evaluateDeliveryTrade(candles, symbol);
  result.symbol = symbol;
  return result;
}

// ─── NIFTY TREND (simple — EMA20 vs EMA50) ───────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++)
    ema = closes[i] * k + ema * (1 - k);
  return ema;
}

async function getNiftyTrend() {
  try {
    const period2 = new Date();
    const period1 = new Date(period2.getTime() - 90 * 24 * 60 * 60 * 1000);
    const raw = await yahooFinance.chart(CONFIG.NIFTY_SYMBOL, {
      period1,
      period2,
      interval: "1d",
    });
    const candles = normalizeYahooResponse(raw);
    if (!candles || candles.length < 55) return "UNKNOWN";
    const closes = candles.map((c) => c.close);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    return ema20 > ema50 ? "UPTREND" : ema20 < ema50 ? "DOWNTREND" : "FLAT";
  } catch {
    return "UNKNOWN";
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
  const hdr = "═".repeat(68);
  const div = "─".repeat(68);
  const date = new Date().toISOString().slice(0, 10);

  console.log(hdr);
  console.log("  NSE Delivery Scanner  |  Support & Resistance  |  Telegram");
  console.log(hdr);
  console.log(`  Stocks : ${STOCKS.length}  |  Date: ${date}`);
  console.log(div);

  // ── Validate token ──
  if (TELEGRAM.BOT_TOKEN === "PASTE_YOUR_BOT_TOKEN_HERE") {
    console.error(
      "[ERROR] Paste your Telegram bot token into the TELEGRAM config at the top of this file.",
    );
    process.exit(1);
  }

  // ── NIFTY trend ──
  process.stdout.write("  Checking NIFTY trend ... ");
  const niftyTrend = await getNiftyTrend();
  console.log(niftyTrend);
  await sleep(CONFIG.FETCH_DELAY_MS);

  // ── Send scan header to Telegram ──
  await sendTelegram(
    `📡 <b>NSE Delivery Scan — ${date}</b>
NIFTY: ${niftyTrend === "UPTREND" ? "🟢 UPTREND" : niftyTrend === "DOWNTREND" ? "🔴 DOWNTREND" : "🟡 FLAT/UNKNOWN"}
Scanning ${STOCKS.length} stocks...`,
  );

  // ── Scan each stock ──
  const results = [];

  for (const symbol of STOCKS) {
    process.stdout.write(`  Analysing ${symbol.padEnd(18)} ... `);
    await sleep(CONFIG.FETCH_DELAY_MS);

    const result = await fetchAndAnalyze(symbol);
    result.symbol = symbol;

    if (result.error) {
      console.log(`❌  ${result.error}`);
    } else {
      const icon =
        result.signal === "BUY" ? "🟢" : result.signal === "WAIT" ? "🟡" : "🔴";
      console.log(
        `${icon} ${result.signal.padEnd(6)}  entry: ${fmtINR(result.entryPrice)}  stop: ${fmtINR(result.stopPrice)}  target: ${fmtINR(result.target)}`,
      );
    }

    results.push(result);

    // Send individual alert to Telegram
    const msg = formatTelegramMessage(symbol, result, niftyTrend);
    await sendTelegram(msg);
    await sleep(300); // Telegram rate limit
  }

  // ── Summary ──
  const buys = results.filter((r) => r.signal === "BUY");
  const waits = results.filter((r) => r.signal === "WAIT");
  const avoids = results.filter((r) => r.signal === "AVOID" && !r.error);
  const errors = results.filter((r) => r.error);

  console.log();
  console.log(hdr);
  console.log("  SUMMARY");
  console.log(hdr);
  if (buys.length)
    console.log(
      `  🟢 BUY  (${buys.length})  : ${buys.map((r) => r.symbol.replace(".NS", "")).join("  |  ")}`,
    );
  if (waits.length)
    console.log(
      `  🟡 WAIT (${waits.length})  : ${waits.map((r) => r.symbol.replace(".NS", "")).join("  |  ")}`,
    );
  if (avoids.length)
    console.log(
      `  🔴 AVOID(${avoids.length})  : ${avoids.map((r) => r.symbol.replace(".NS", "")).join("  |  ")}`,
    );
  if (errors.length)
    console.log(
      `  ❌ ERROR(${errors.length})  : ${errors.map((r) => r.symbol.replace(".NS", "")).join("  |  ")}`,
    );
  console.log(hdr);

  // ── Send summary to Telegram ──
  const summaryLines = [
    `📊 <b>Scan Complete — ${date}</b>`,
    `NIFTY: ${niftyTrend}`,
    "",
  ];
  if (buys.length)
    summaryLines.push(
      `🟢 BUY  : ${buys.map((r) => r.symbol.replace(".NS", "")).join(", ")}`,
    );
  if (waits.length)
    summaryLines.push(
      `🟡 WAIT : ${waits.map((r) => r.symbol.replace(".NS", "")).join(", ")}`,
    );
  if (avoids.length)
    summaryLines.push(
      `🔴 AVOID: ${avoids.map((r) => r.symbol.replace(".NS", "")).join(", ")}`,
    );
  summaryLines.push("");
  summaryLines.push("⚠️ These are condition alerts, not guarantees.");
  summaryLines.push("Always verify on chart. Use a stop loss.");

  await sendTelegram(summaryLines.join("\n"));

  console.log();
  console.log("  ✅ All alerts sent to Telegram.");
  console.log(hdr);
}

run().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
