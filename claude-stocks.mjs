/**
 * NSE Multi-Stock Intraday Scanner
 * ---------------------------------
 * Scans a list of stocks simultaneously and prints a ranked
 * summary of LONG / SHORT / AVOID signals.
 *
 * Usage: node nifty-scanner.mjs
 */

import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

// ─── STOCK LIST ───────────────────────────────────────────────────────────────
// Add or remove symbols here. NSE stocks = SYMBOL.NS
// Indices: NIFTY 50 = ^NSEI, Bank Nifty = ^NSEBANK

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
  TIMEFRAME_MINUTES: 5,
  LOOKBACK_MINUTES: 75,
  DIRECTION_UP_THRESHOLD: 0.6,
  DIRECTION_DOWN_THRESHOLD: 0.4,
  VOLATILITY_MULTIPLIER: 1.5,
  IST_OFFSET_MS: 5.5 * 60 * 60 * 1000,
  MARKET_OPEN_HOUR_UTC: 3,
  MARKET_OPEN_MIN_UTC: 45,
  TARGET_DATE: null, // "YYYY-MM-DD" for historical, null = live

  ENTRY_WINDOW_START_H: 9,
  ENTRY_WINDOW_START_M: 30,
  ENTRY_WINDOW_END_H: 13,
  ENTRY_WINDOW_END_M: 30,
  HARD_EXIT_H: 14,
  HARD_EXIT_M: 30,
  EXPIRY_ENTRY_CUTOFF_H: 11,
  EXPIRY_ENTRY_CUTOFF_M: 0,
  EXPIRY_HARD_EXIT_H: 13,
  EXPIRY_HARD_EXIT_M: 0,

  // Delay between fetches in ms — avoids Yahoo rate limiting
  FETCH_DELAY_MS: 300,
};

const REQUIRED_CANDLES = Math.ceil(
  CONFIG.LOOKBACK_MINUTES / CONFIG.TIMEFRAME_MINUTES,
);

// ─── UTILITIES ────────────────────────────────────────────────────────────────

const VALID_YAHOO_INTERVALS = [1, 2, 5, 15, 30, 60, 90];

function resolveYahooInterval(m) {
  if (VALID_YAHOO_INTERVALS.includes(m)) return `${m}m`;
  const s = [...VALID_YAHOO_INTERVALS].reverse().find((v) => v < m);
  return s ? `${s}m` : "5m";
}

function formatIST(input) {
  const ms =
    input == null
      ? Date.now()
      : input instanceof Date
        ? input.getTime()
        : typeof input === "number" && input < 1e12
          ? input * 1000
          : typeof input === "number"
            ? input
            : new Date(input).getTime();
  return (
    new Date(ms + CONFIG.IST_OFFSET_MS)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " IST"
  );
}

function nowIST() {
  const ist = new Date(Date.now() + CONFIG.IST_OFFSET_MS);
  return {
    h: ist.getUTCHours(),
    m: ist.getUTCMinutes(),
    s: ist.getUTCSeconds(),
    dayOfWeek: ist.getUTCDay(),
    totalMinutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

function sessionDate() {
  if (CONFIG.TARGET_DATE) {
    const [y, m, d] = CONFIG.TARGET_DATE.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return new Date();
}

function marketOpenUTC() {
  const b = sessionDate();
  return new Date(
    Date.UTC(
      b.getUTCFullYear(),
      b.getUTCMonth(),
      b.getUTCDate(),
      CONFIG.MARKET_OPEN_HOUR_UTC,
      CONFIG.MARKET_OPEN_MIN_UTC,
      0,
    ),
  );
}

function marketCloseUTC() {
  const b = sessionDate();
  return new Date(
    Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), 10, 0, 0),
  );
}

function safeNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function toMins(h, m) {
  return h * 60 + m;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  if (Array.isArray(raw) && raw[0]?.timestamp)
    return buildCandlesFromTimestamps(
      raw[0].timestamp,
      raw[0].indicators?.quote?.[0],
    );
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

function filterSessionCandles(candles) {
  const openMs = marketOpenUTC().getTime();
  const closeMs = CONFIG.TARGET_DATE ? marketCloseUTC().getTime() : Date.now();
  return candles.filter(
    (c) => c.time * 1000 >= openMs && c.time * 1000 <= closeMs,
  );
}

// ─── ANALYSIS ─────────────────────────────────────────────────────────────────

function analyzeDirection(candles) {
  if (candles.length < 2)
    return { direction: "SIDEWAYS", upRatio: 0, upCount: 0, comparisons: 0 };
  let upCount = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) upCount++;
  }
  const comparisons = candles.length - 1;
  const upRatio = upCount / comparisons;
  const direction =
    upRatio > CONFIG.DIRECTION_UP_THRESHOLD
      ? "BULLISH"
      : upRatio < CONFIG.DIRECTION_DOWN_THRESHOLD
        ? "BEARISH"
        : "SIDEWAYS";
  return { direction, upRatio, upCount, comparisons };
}

function analyzeVolatility(candles) {
  if (candles.length < 2)
    return {
      volatility: "NORMAL",
      lastRange: null,
      avgRange: null,
      ratio: null,
    };
  const ranges = candles.map((c) => c.high - c.low);
  const priorRanges = ranges.slice(0, -1);
  const avgRange = priorRanges.reduce((a, b) => a + b, 0) / priorRanges.length;
  const lastRange = ranges[ranges.length - 1];
  const ratio = avgRange > 0 ? lastRange / avgRange : 1;
  return {
    volatility: ratio > CONFIG.VOLATILITY_MULTIPLIER ? "VOLATILE" : "NORMAL",
    lastRange,
    avgRange,
    ratio,
  };
}

// ─── ALERT ENGINE ─────────────────────────────────────────────────────────────

function evaluateAlert(direction, volatility, ist) {
  const now = ist.totalMinutes;
  const isExpiry = ist.dayOfWeek === 4;

  const entryStart = toMins(
    CONFIG.ENTRY_WINDOW_START_H,
    CONFIG.ENTRY_WINDOW_START_M,
  );
  const entryEnd = toMins(CONFIG.ENTRY_WINDOW_END_H, CONFIG.ENTRY_WINDOW_END_M);
  const hardExit = toMins(CONFIG.HARD_EXIT_H, CONFIG.HARD_EXIT_M);
  const expiryEntry = toMins(
    CONFIG.EXPIRY_ENTRY_CUTOFF_H,
    CONFIG.EXPIRY_ENTRY_CUTOFF_M,
  );
  const expiryExit = toMins(
    CONFIG.EXPIRY_HARD_EXIT_H,
    CONFIG.EXPIRY_HARD_EXIT_M,
  );

  if (isExpiry && now >= expiryExit)
    return {
      alert: "EXIT_NOW",
      signal: "🔴 EXIT NOW",
      reason: "Expiry >13:00",
    };
  if (now >= hardExit)
    return {
      alert: "EXIT_NOW",
      signal: "🔴 EXIT NOW",
      reason: "Past hard exit time",
    };
  if (volatility === "VOLATILE")
    return {
      alert: "EXIT_NOW",
      signal: "🔴 EXIT/AVOID",
      reason: "VOLATILE — range spiked",
    };
  if (now < entryStart)
    return { alert: "AVOID", signal: "⚪ AVOID", reason: "Before 09:30" };
  if (isExpiry && now >= expiryEntry)
    return {
      alert: "AVOID",
      signal: "⚪ AVOID",
      reason: "Expiry entry cutoff",
    };
  if (now >= entryEnd)
    return { alert: "AVOID", signal: "⚪ AVOID", reason: "After 13:30" };
  if (direction === "SIDEWAYS")
    return { alert: "AVOID", signal: "⚪ AVOID", reason: "SIDEWAYS — no edge" };

  const expiryWarn = isExpiry ? " ⚠️ Expiry" : "";

  if (direction === "BULLISH")
    return {
      alert: "LONG_ENTRY",
      signal: "🟢 LONG",
      reason: `BULLISH_NORMAL${expiryWarn}`,
    };
  if (direction === "BEARISH")
    return {
      alert: "SHORT_ENTRY",
      signal: "🔴 SHORT",
      reason: `BEARISH_NORMAL${expiryWarn}`,
    };

  return { alert: "WATCH", signal: "🟡 WATCH", reason: "Conditions unclear" };
}

// ─── PER-SYMBOL FETCH + ANALYSE ───────────────────────────────────────────────

async function analyzeSymbol(symbol, interval, period1, period2, ist) {
  let raw;
  try {
    raw = await yahooFinance.chart(symbol, { period1, period2, interval });
  } catch (err) {
    return { symbol, error: err.message.slice(0, 60) };
  }

  const allCandles = normalizeYahooResponse(raw);
  if (!allCandles) return { symbol, error: "Could not parse response" };

  const intradayCandles = filterSessionCandles(allCandles);
  if (intradayCandles.length === 0)
    return { symbol, error: "No intraday candles" };

  const isHistorical = Boolean(CONFIG.TARGET_DATE);
  const completedCandles = isHistorical
    ? intradayCandles
    : intradayCandles.slice(0, -1);
  const liveCandle = intradayCandles[intradayCandles.length - 1];
  const analysisCandles = completedCandles.slice(-REQUIRED_CANDLES);

  if (analysisCandles.length < 2)
    return { symbol, error: "Not enough candles yet" };

  const { direction, upRatio } = analyzeDirection(analysisCandles);
  const { volatility, lastRange, avgRange, ratio } = analyzeVolatility([
    ...analysisCandles,
    liveCandle,
  ]);
  const { alert, signal, reason } = evaluateAlert(direction, volatility, ist);

  return {
    symbol,
    close: liveCandle.close,
    direction,
    volatility,
    state: `${direction}_${volatility}`,
    upRatio,
    lastRange,
    avgRange,
    volRatio: ratio,
    alert,
    signal,
    reason,
    candles: analysisCandles.length,
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
  const hdr = "═".repeat(72);
  const div = "─".repeat(72);

  const isHistorical = Boolean(CONFIG.TARGET_DATE);
  const interval = resolveYahooInterval(CONFIG.TIMEFRAME_MINUTES);
  const period1 = marketOpenUTC();
  const period2 = isHistorical ? marketCloseUTC() : new Date();
  const ist = isHistorical
    ? (() => {
        const [y, mo, d] = CONFIG.TARGET_DATE.split("-").map(Number);
        return {
          h: 13,
          m: 0,
          s: 0,
          dayOfWeek: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(),
          totalMinutes: 13 * 60,
        };
      })()
    : nowIST();

  console.log(hdr);
  console.log("  NSE Intraday Scanner  |  Multi-Stock Alert Engine");
  console.log(hdr);
  console.log(
    `  Timeframe  : ${CONFIG.TIMEFRAME_MINUTES}m  |  Lookback: ${CONFIG.LOOKBACK_MINUTES}min  |  Stocks: ${STOCKS.length}`,
  );
  console.log(
    `  Mode       : ${isHistorical ? `HISTORICAL — ${CONFIG.TARGET_DATE}` : `LIVE — ${formatIST(new Date())}`}`,
  );
  console.log(`  Scanning   : ${STOCKS.join("  ")}`);
  console.log(div);

  // ── Fetch all symbols with small delay to avoid rate limiting ──
  const results = [];
  for (const symbol of STOCKS) {
    process.stdout.write(`  Fetching ${symbol.padEnd(18)} ... `);
    const result = await analyzeSymbol(symbol, interval, period1, period2, ist);
    if (result.error) {
      console.log(`❌  ${result.error}`);
    } else {
      console.log(`✓  ${result.signal}`);
    }
    results.push(result);
    await sleep(CONFIG.FETCH_DELAY_MS);
  }

  // ── Sort: LONG first, then SHORT, then WATCH, then AVOID, errors last ──
  const ORDER = {
    LONG_ENTRY: 0,
    SHORT_ENTRY: 1,
    WATCH: 2,
    AVOID: 3,
    EXIT_NOW: 4,
  };
  const sorted = [...results].sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (!a.error && b.error) return -1;
    return (ORDER[a.alert] ?? 5) - (ORDER[b.alert] ?? 5);
  });

  // ── Summary table ──
  console.log();
  console.log(hdr);
  console.log("  SCAN RESULTS");
  console.log(hdr);
  console.log(
    "  " +
      "SYMBOL".padEnd(16) +
      "SIGNAL".padEnd(16) +
      "STATE".padEnd(22) +
      "CLOSE".padEnd(10) +
      "REASON",
  );
  console.log(div);

  for (const r of sorted) {
    if (r.error) {
      console.log(
        `  ${r.symbol.padEnd(16)}${"❌ ERROR".padEnd(16)}${"-".padEnd(22)}${"-".padEnd(10)}${r.error}`,
      );
      continue;
    }
    const sym = r.symbol.replace(".NS", "").padEnd(16);
    const sig = r.signal.padEnd(16);
    const state = r.state.padEnd(22);
    const close = r.close.toFixed(2).padEnd(10);
    console.log(`  ${sym}${sig}${state}${close}${r.reason}`);
  }

  console.log(div);

  // ── Actionable summary ──
  const longs = sorted.filter((r) => r.alert === "LONG_ENTRY");
  const shorts = sorted.filter((r) => r.alert === "SHORT_ENTRY");
  const exits = sorted.filter((r) => r.alert === "EXIT_NOW");

  console.log();
  if (longs.length)
    console.log(
      `  🟢 LONG  : ${longs.map((r) => r.symbol.replace(".NS", "")).join("  |  ")}`,
    );
  if (shorts.length)
    console.log(
      `  🔴 SHORT : ${shorts.map((r) => r.symbol.replace(".NS", "")).join("  |  ")}`,
    );
  if (exits.length)
    console.log(
      `  🚨 EXIT  : ${exits.map((r) => r.symbol.replace(".NS", "")).join("  |  ")}`,
    );
  if (!longs.length && !shorts.length && !exits.length)
    console.log("  ⚪ No actionable signals right now.");

  console.log();
  console.log(
    "  ── Reminder ────────────────────────────────────────────────────",
  );
  console.log("  These are CONDITION alerts, not guarantees.");
  console.log(
    "  Always check the chart. Use a stop loss. Never size too large.",
  );
  console.log(hdr);
}

run().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
