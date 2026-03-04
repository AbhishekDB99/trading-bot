/**
 * NIFTY 50 Intraday Market State Observer
 * ----------------------------------------
 * Pure observation engine — NO trading logic.
 * Analyzes real intraday data from Yahoo Finance (^NSEI).
 *
 * Outputs:
 *   Direction  : BULLISH | BEARISH | SIDEWAYS
 *   Volatility : VOLATILE | NORMAL
 *   State      : e.g. BEARISH_NORMAL
 */

import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: "^NSEI",
  TIMEFRAME_MINUTES: 5, // ← change to 1, 15, 30, 60 etc.
  LOOKBACK_MINUTES: 75, // how far back to look intraday
  DIRECTION_UP_THRESHOLD: 0.6, // >60% up candles → BULLISH
  DIRECTION_DOWN_THRESHOLD: 0.4, // <40% up candles → BEARISH
  VOLATILITY_MULTIPLIER: 1.5, // last candle range > 1.5× avg → VOLATILE
  IST_OFFSET_MS: 5.5 * 60 * 60 * 1000,
  MARKET_OPEN_HOUR_UTC: 3, // 09:15 IST = 03:45 UTC
  MARKET_OPEN_MIN_UTC: 45,
};

const REQUIRED_CANDLES = Math.ceil(
  CONFIG.LOOKBACK_MINUTES / CONFIG.TIMEFRAME_MINUTES,
);

// ─── YAHOO INTERVAL MAP ──────────────────────────────────────────────────────

const VALID_YAHOO_INTERVALS = [1, 2, 5, 15, 30, 60, 90];

function resolveYahooInterval(minutes) {
  if (VALID_YAHOO_INTERVALS.includes(minutes)) return `${minutes}m`;
  const smaller = [...VALID_YAHOO_INTERVALS].reverse().find((v) => v < minutes);
  const interval = smaller ? `${smaller}m` : "5m";
  console.warn(
    `[WARN] TIMEFRAME_MINUTES=${minutes} not valid for Yahoo. ` +
      `Using ${interval}. Valid: ${VALID_YAHOO_INTERVALS.join(", ")}m`,
  );
  return interval;
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function formatIST(input) {
  const ms =
    input == null
      ? Date.now()
      : input instanceof Date
        ? input.getTime()
        : typeof input === "number" && input < 1e12
          ? input * 1000 // epoch seconds
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

function todayMarketOpenUTC() {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      CONFIG.MARKET_OPEN_HOUR_UTC,
      CONFIG.MARKET_OPEN_MIN_UTC,
      0,
    ),
  );
}

function safeNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// ─── DATA NORMALIZER ─────────────────────────────────────────────────────────
// Handles ALL known yahoo-finance2 response shapes.

function normalizeYahooResponse(raw) {
  if (!raw) return { candles: null, shape: "null" };

  // ── Shape 1 (modern yahoo-finance2 v2): { meta, quotes: [{date,open,high,low,close,volume}] }
  if (Array.isArray(raw.quotes) && raw.quotes.length > 0) {
    const candles = buildCandlesFromQuotes(raw.quotes);
    return { candles, shape: "meta+quotes" };
  }

  // ── Shape 2 (legacy): { timestamp, indicators: { quote: [{}] } }
  if (Array.isArray(raw.timestamp) && raw.indicators?.quote) {
    const candles = buildCandlesFromTimestamps(
      raw.timestamp,
      raw.indicators.quote[0],
    );
    return { candles, shape: "timestamp+indicators" };
  }

  // ── Shape 3 (nested): { chart: { result: [{ timestamp, indicators }] } }
  if (raw.chart?.result?.length) {
    const r = raw.chart.result[0];
    if (r?.timestamp && r?.indicators?.quote) {
      const candles = buildCandlesFromTimestamps(
        r.timestamp,
        r.indicators.quote[0],
      );
      return { candles, shape: "chart.result" };
    }
  }

  // ── Shape 4 (array wrapper): [{ timestamp, indicators }]
  if (Array.isArray(raw) && raw[0]?.timestamp) {
    const r = raw[0];
    const candles = buildCandlesFromTimestamps(
      r.timestamp,
      r.indicators?.quote?.[0],
    );
    return { candles, shape: "array[0]" };
  }

  return {
    candles: null,
    shape: `unknown(keys:${Object.keys(raw).join(",")})`,
  };
}

// Shape 1 builder — quotes array has pre-parsed OHLCV objects
function buildCandlesFromQuotes(quotes) {
  const candles = [];
  for (const q of quotes) {
    const dateVal = q.date ?? q.timestamp;
    if (!dateVal) continue;

    // Normalise date to epoch-seconds regardless of input type
    const time =
      dateVal instanceof Date
        ? dateVal.getTime() / 1000
        : typeof dateVal === "number" && dateVal > 1e12
          ? dateVal / 1000
          : typeof dateVal === "number"
            ? dateVal
            : new Date(dateVal).getTime() / 1000;

    const open = safeNum(q.open);
    const high = safeNum(q.high);
    const low = safeNum(q.low);
    const close = safeNum(q.close) ?? safeNum(q.adjclose);
    const volume = safeNum(q.volume) ?? 0;

    if (
      !isFinite(time) ||
      open == null ||
      high == null ||
      low == null ||
      close == null
    )
      continue;

    // Yahoo sometimes emits a zero-filled ghost candle for a bar that hasn't
    // closed yet (all OHLC = 0). Skip it — it's not real data.
    if (open === 0 && high === 0 && low === 0 && close === 0) continue;

    candles.push({ time, open, high, low, close, volume });
  }
  return candles.length > 0 ? candles : null;
}

// Shape 2/3/4 builder — parallel timestamp + quote arrays
function buildCandlesFromTimestamps(timestamps, quote) {
  if (!timestamps || !quote) return null;
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i];
    const open = safeNum(quote.open?.[i]);
    const high = safeNum(quote.high?.[i]);
    const low = safeNum(quote.low?.[i]);
    const close = safeNum(quote.close?.[i]);
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

// ─── FILTER TO TODAY'S INTRADAY SESSION ──────────────────────────────────────

function filterTodayIntraday(candles) {
  const marketOpenMs = todayMarketOpenUTC().getTime();
  const nowMs = Date.now();
  return candles.filter((c) => {
    const tsMs = c.time * 1000;
    return tsMs >= marketOpenMs && tsMs <= nowMs;
  });
}

// ─── DIRECTION: consecutive close comparisons ─────────────────────────────────

function analyzeDirection(candles) {
  if (candles.length < 2) {
    return { direction: "SIDEWAYS", upRatio: 0, upCount: 0, comparisons: 0 };
  }
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

// ─── VOLATILITY: last candle range vs average range ───────────────────────────

function analyzeVolatility(candles) {
  if (candles.length < 2) {
    return {
      volatility: "NORMAL",
      lastRange: null,
      avgRange: null,
      ratio: null,
    };
  }
  const ranges = candles.map((c) => c.high - c.low);
  const priorRanges = ranges.slice(0, -1);
  const avgRange = priorRanges.reduce((a, b) => a + b, 0) / priorRanges.length;
  const lastRange = ranges[ranges.length - 1];
  const ratio = avgRange > 0 ? lastRange / avgRange : 1;

  const volatility =
    ratio > CONFIG.VOLATILITY_MULTIPLIER ? "VOLATILE" : "NORMAL";
  return { volatility, lastRange, avgRange, ratio };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
  const hdr = "═".repeat(55);
  const div = "─".repeat(55);

  console.log(hdr);
  console.log("  NIFTY 50 Intraday Market State Observer");
  console.log(hdr);
  console.log(`  Symbol       : ${CONFIG.symbol}`);
  console.log(`  Timeframe    : ${CONFIG.TIMEFRAME_MINUTES}m`);
  console.log(
    `  Lookback     : ${CONFIG.LOOKBACK_MINUTES} min  →  ${REQUIRED_CANDLES} candles needed`,
  );
  console.log(`  Current IST  : ${formatIST(new Date())}`);
  console.log(div);

  const interval = resolveYahooInterval(CONFIG.TIMEFRAME_MINUTES);
  const period1 = todayMarketOpenUTC();
  const period2 = new Date();

  // ── Fetch ──
  let raw;
  try {
    raw = await yahooFinance.chart(CONFIG.symbol, {
      period1,
      period2,
      interval,
    });
  } catch (err) {
    console.error(`[ERROR] Yahoo Finance fetch failed: ${err.message}`);
    if (/not found|no fundamentals|404/i.test(err.message)) {
      console.error("[HINT] Symbol may be invalid, or NSE data unavailable.");
    }
    process.exit(1);
  }

  // ── Normalize ──
  const { candles: allCandles, shape } = normalizeYahooResponse(raw);
  console.log(`  Response shape detected  : ${shape}`);

  if (!allCandles) {
    console.error(
      "[ERROR] Could not extract candles from Yahoo Finance response.",
    );
    console.error(
      `[DEBUG] Top-level keys : ${Object.keys(raw ?? {}).join(", ")}`,
    );
    console.error(
      "[HINT] Market may be closed, or Yahoo data format has changed again.",
    );
    console.error(
      "[DEBUG] Full raw sample:",
      JSON.stringify(raw).slice(0, 400),
    );
    process.exit(1);
  }

  // ── Filter to today's session ──
  const intradayCandles = filterTodayIntraday(allCandles);

  if (intradayCandles.length === 0) {
    console.error("[ERROR] No intraday candles found for today's session.");
    console.error(`[INFO] Total raw candles : ${allCandles.length}`);
    if (allCandles.length > 0) {
      console.error(
        `[INFO] First raw candle : ${formatIST(allCandles[0].time)}`,
      );
      console.error(
        `[INFO] Last  raw candle : ${formatIST(allCandles[allCandles.length - 1].time)}`,
      );
    }
    console.error(
      "[HINT] Market may not have opened yet, or all data is from a prior session.",
    );
    process.exit(1);
  }

  // ── Split: completed candles vs live (potentially partial) candle ──
  // Live candle is excluded from direction (close may be mid-formation),
  // but included in volatility (detecting a current range spike is intentional).
  const completedCandles = intradayCandles.slice(0, -1);
  const liveCandle = intradayCandles[intradayCandles.length - 1];
  const analysisCandles = completedCandles.slice(-REQUIRED_CANDLES);

  console.log(`  Raw candles total        : ${allCandles.length}`);
  console.log(`  Today's intraday candles : ${intradayCandles.length}`);
  console.log(`  Completed candles        : ${completedCandles.length}`);
  console.log(
    `  Used for analysis        : ${analysisCandles.length} / ${REQUIRED_CANDLES} required`,
  );
  console.log(
    `  Session open candle      : ${formatIST(intradayCandles[0].time)}`,
  );
  if (completedCandles.length > 0) {
    const last = completedCandles[completedCandles.length - 1];
    console.log(
      `  Last completed candle    : ${formatIST(last.time)}  close=${last.close.toFixed(2)}`,
    );
  }
  console.log(
    `  Live (partial) candle    : ${formatIST(liveCandle.time)}  close=${liveCandle.close.toFixed(2)}`,
  );
  console.log(div);

  if (analysisCandles.length < 2) {
    console.warn(
      `[WARN] Only ${analysisCandles.length} completed candle(s) — need at least 2.`,
    );
    console.warn(
      "[HINT] Market may have just opened. Try again in a few minutes.",
    );
    process.exit(0);
  }

  if (analysisCandles.length < REQUIRED_CANDLES) {
    console.warn(
      `[WARN] Partial window: ${analysisCandles.length}/${REQUIRED_CANDLES} candles. ` +
        `Analysis proceeds with available data.`,
    );
  }

  // ── Direction ──
  const { direction, upRatio, upCount, comparisons } =
    analyzeDirection(analysisCandles);

  // ── Volatility ──
  const { volatility, lastRange, avgRange, ratio } = analyzeVolatility([
    ...analysisCandles,
    liveCandle,
  ]);

  // ── Result ──
  const state = `${direction}_${volatility}`;

  console.log(`  Direction   : ${direction}`);
  console.log(
    `    ↳ Up closes : ${upCount} / ${comparisons}  (${(upRatio * 100).toFixed(1)}%)`,
  );
  console.log(
    `    ↳ Thresholds: BULLISH > ${CONFIG.DIRECTION_UP_THRESHOLD * 100}%  |  BEARISH < ${CONFIG.DIRECTION_DOWN_THRESHOLD * 100}%`,
  );
  console.log(`  Volatility  : ${volatility}`);
  console.log(`    ↳ Last range : ${lastRange?.toFixed(2)}`);
  console.log(`    ↳ Avg range  : ${avgRange?.toFixed(2)}`);
  console.log(
    `    ↳ Ratio      : ${ratio?.toFixed(2)}×  (threshold ${CONFIG.VOLATILITY_MULTIPLIER}×)`,
  );
  console.log(div);
  console.log(`  ★  MARKET STATE : ${state}`);
  console.log(hdr);

  return state;
}

run().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
