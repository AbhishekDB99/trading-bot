/**
 * NIFTY 50 Intraday Market State Observer
 * ----------------------------------------
 * Pure observation engine - NO trading logic.
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
  TIMEFRAME_MINUTES: 5, // ← change to 1, 15, 30, etc.
  LOOKBACK_MINUTES: 75, // how far back to look intraday
  DIRECTION_UP_THRESHOLD: 0.6, // >60% up candles → BULLISH
  DIRECTION_DOWN_THRESHOLD: 0.4, // <40% up candles → BEARISH
  VOLATILITY_MULTIPLIER: 1.5, // last candle range > 1.5× avg → VOLATILE
  MARKET_OPEN_HOUR_IST: 9,
  MARKET_OPEN_MIN_IST: 15,
  IST_OFFSET_MS: 5.5 * 60 * 60 * 1000,
};

// Derived
const REQUIRED_CANDLES = Math.ceil(
  CONFIG.LOOKBACK_MINUTES / CONFIG.TIMEFRAME_MINUTES,
);

// ─── YAHOO INTERVAL MAP ──────────────────────────────────────────────────────

const VALID_YAHOO_INTERVALS = [1, 2, 5, 15, 30, 60, 90];

function resolveYahooInterval(minutes) {
  // Yahoo only accepts specific interval values; pick nearest valid one
  const match = VALID_YAHOO_INTERVALS.find((v) => v === minutes);
  if (match) return `${match}m`;
  // fallback: pick the closest smaller valid interval
  const smaller = [...VALID_YAHOO_INTERVALS].reverse().find((v) => v < minutes);
  const interval = smaller ? `${smaller}m` : "5m";
  console.warn(
    `[WARN] TIMEFRAME_MINUTES=${minutes} is not a valid Yahoo interval. ` +
      `Using ${interval} instead. Valid options: ${VALID_YAHOO_INTERVALS.join(", ")}m`,
  );
  return interval;
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function nowIST() {
  return new Date(Date.now() + CONFIG.IST_OFFSET_MS);
}

function todayMarketOpenUTC() {
  const ist = nowIST();
  // Build today's 09:15 IST as UTC
  const open = new Date(
    Date.UTC(
      ist.getUTCFullYear(),
      ist.getUTCMonth(),
      ist.getUTCDate(),
      CONFIG.MARKET_OPEN_HOUR_IST,
      CONFIG.MARKET_OPEN_MIN_IST,
      0,
    ) - CONFIG.IST_OFFSET_MS,
  );
  return open;
}

function formatIST(dateOrEpoch) {
  const d =
    typeof dateOrEpoch === "number"
      ? new Date(dateOrEpoch * 1000)
      : dateOrEpoch;
  return (
    new Date(d.getTime() + CONFIG.IST_OFFSET_MS)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " IST"
  );
}

// ─── DATA NORMALIZER ─────────────────────────────────────────────────────────
// Handles all known Yahoo Finance response shapes defensively.

function normalizeYahooResponse(raw) {
  // Shape A: unwrapped { timestamp, indicators: { quote } }
  if (raw && Array.isArray(raw.timestamp) && raw.indicators?.quote) {
    return buildCandles(raw.timestamp, raw.indicators.quote[0]);
  }

  // Shape B: nested { chart: { result: [ { timestamp, indicators } ] } }
  if (raw?.chart?.result?.length) {
    const r = raw.chart.result[0];
    if (r?.timestamp && r?.indicators?.quote) {
      return buildCandles(r.timestamp, r.indicators.quote[0]);
    }
  }

  // Shape C: sometimes yahoo-finance2 returns result directly as array
  if (Array.isArray(raw) && raw[0]?.timestamp) {
    const r = raw[0];
    return buildCandles(r.timestamp, r.indicators?.quote?.[0]);
  }

  return null; // unrecognised shape
}

function buildCandles(timestamps, quote) {
  if (!timestamps || !quote) return null;

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i];
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i] ?? 0;

    // Skip any candle with null/undefined OHLC
    if (
      time == null ||
      open == null ||
      high == null ||
      low == null ||
      close == null
    ) {
      continue;
    }

    candles.push({ time, open, high, low, close, volume });
  }

  return candles.length > 0 ? candles : null;
}

// ─── FILTER TO TODAY INTRADAY ─────────────────────────────────────────────────

function filterTodayIntraday(candles) {
  const marketOpenUTC = todayMarketOpenUTC();
  const nowUTC = new Date();

  return candles.filter((c) => {
    const ts = new Date(c.time * 1000);
    return ts >= marketOpenUTC && ts <= nowUTC;
  });
}

// ─── DIRECTION ANALYSIS ──────────────────────────────────────────────────────
// Based purely on consecutive candle close comparisons.

function analyzeDirection(candles) {
  if (candles.length < 2) return { direction: "SIDEWAYS", upRatio: null };

  let upCount = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) upCount++;
  }

  const comparisons = candles.length - 1;
  const upRatio = upCount / comparisons;

  let direction;
  if (upRatio > CONFIG.DIRECTION_UP_THRESHOLD) {
    direction = "BULLISH";
  } else if (upRatio < CONFIG.DIRECTION_DOWN_THRESHOLD) {
    direction = "BEARISH";
  } else {
    direction = "SIDEWAYS";
  }

  return { direction, upRatio, upCount, comparisons };
}

// ─── VOLATILITY ANALYSIS ─────────────────────────────────────────────────────
// Last candle range vs average range of lookback window.

function analyzeVolatility(candles) {
  if (candles.length < 2)
    return { volatility: "NORMAL", lastRange: null, avgRange: null };

  const ranges = candles.map((c) => c.high - c.low);
  const avgRange =
    ranges.slice(0, -1).reduce((a, b) => a + b, 0) / (ranges.length - 1);
  const lastRange = ranges[ranges.length - 1];

  const volatility =
    lastRange > CONFIG.VOLATILITY_MULTIPLIER * avgRange ? "VOLATILE" : "NORMAL";

  return { volatility, lastRange, avgRange };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log("═".repeat(55));
  console.log("  NIFTY 50 Intraday Market State Observer");
  console.log("═".repeat(55));
  console.log(`  Symbol       : ${CONFIG.symbol}`);
  console.log(`  Timeframe    : ${CONFIG.TIMEFRAME_MINUTES}m`);
  console.log(`  Lookback     : ${CONFIG.LOOKBACK_MINUTES} minutes`);
  console.log(`  Required     : ${REQUIRED_CANDLES} candles`);
  console.log(`  Current IST  : ${formatIST(new Date())}`);
  console.log("─".repeat(55));

  const interval = resolveYahooInterval(CONFIG.TIMEFRAME_MINUTES);

  // Fetch last 1 day of intraday data
  let raw;
  try {
    raw = await yahooFinance.chart(CONFIG.symbol, {
      period1: todayMarketOpenUTC(),
      period2: new Date(),
      interval,
    });
  } catch (err) {
    console.error(`[ERROR] Yahoo Finance fetch failed: ${err.message}`);
    if (
      err.message?.includes("Not Found") ||
      err.message?.includes("No fundamentals")
    ) {
      console.error(
        "[HINT] Symbol may be invalid or market is closed/no data today.",
      );
    }
    process.exit(1);
  }

  // Normalize to flat candle array
  const allCandles = normalizeYahooResponse(raw);

  if (!allCandles) {
    console.error("[ERROR] Could not parse Yahoo Finance response.");
    console.error(
      "[DEBUG] Raw response shape:",
      JSON.stringify(Object.keys(raw ?? {})),
    );
    console.error(
      "[HINT] Market may be closed, or Yahoo returned an unexpected format.",
    );
    process.exit(1);
  }

  // Filter to today's session only
  const intradayCandles = filterTodayIntraday(allCandles);

  if (intradayCandles.length === 0) {
    console.error("[ERROR] No intraday candles found for today.");
    console.error(
      "[HINT] Market may not have opened yet, or no data available for today.",
    );
    console.error(`[INFO] Total raw candles received: ${allCandles.length}`);
    if (allCandles.length > 0) {
      console.error(
        `[INFO] First raw candle time: ${formatIST(allCandles[0].time)}`,
      );
      console.error(
        `[INFO] Last  raw candle time: ${formatIST(allCandles[allCandles.length - 1].time)}`,
      );
    }
    process.exit(1);
  }

  // Take most recent N candles (skip last potentially incomplete candle)
  // The last candle in an ongoing session may be partial — we drop it for direction,
  // but use it for volatility (range check of the current candle is intentional).
  const completedCandles = intradayCandles.slice(0, -1); // all but last
  const analysisCandles = completedCandles.slice(-REQUIRED_CANDLES);
  const lastCandle = intradayCandles[intradayCandles.length - 1]; // potentially live

  console.log(`  Intraday candles fetched  : ${intradayCandles.length}`);
  console.log(`  Completed candles         : ${completedCandles.length}`);
  console.log(
    `  Used for analysis         : ${analysisCandles.length} (max ${REQUIRED_CANDLES})`,
  );
  console.log(
    `  First candle time         : ${formatIST(intradayCandles[0].time)}`,
  );
  console.log(
    `  Last completed candle     : ${formatIST(completedCandles[completedCandles.length - 1]?.time ?? 0)}`,
  );
  console.log(`  Current (live) candle     : ${formatIST(lastCandle.time)}`);
  console.log("─".repeat(55));

  if (analysisCandles.length < 2) {
    console.warn(
      `[WARN] Not enough completed candles for analysis. ` +
        `Need at least 2, got ${analysisCandles.length}.`,
    );
    console.warn(
      "[HINT] Market may have just opened or lookback window is too large.",
    );
    process.exit(0);
  }

  if (analysisCandles.length < REQUIRED_CANDLES) {
    console.warn(
      `[WARN] Only ${analysisCandles.length}/${REQUIRED_CANDLES} required candles available. ` +
        `Analysis will proceed with available data.`,
    );
  }

  // ── Direction (on completed candles only) ──
  const { direction, upRatio, upCount, comparisons } =
    analyzeDirection(analysisCandles);

  // ── Volatility (include live candle as "last" for range check) ──
  const volatilityCandles = [...analysisCandles, lastCandle];
  const { volatility, lastRange, avgRange } =
    analyzeVolatility(volatilityCandles);

  // ── Combined state ──
  const state = `${direction}_${volatility}`;

  // ── Output ──
  console.log(`  Direction  : ${direction}`);
  console.log(
    `    ↳ Up closes : ${upCount}/${comparisons} (${(upRatio * 100).toFixed(1)}%)`,
  );
  console.log(`  Volatility : ${volatility}`);
  console.log(
    `    ↳ Last range : ${lastRange?.toFixed(2)} | Avg range : ${avgRange?.toFixed(2)}` +
      ` | Ratio : ${(lastRange / avgRange).toFixed(2)}x`,
  );
  console.log("─".repeat(55));
  console.log(`  ★ MARKET STATE : ${state}`);
  console.log("═".repeat(55));

  return state;
}

run().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
