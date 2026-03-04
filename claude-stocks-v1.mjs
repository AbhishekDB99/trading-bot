/**
 * NIFTY 50 Intraday Market State Observer + Options Alert Engine
 * --------------------------------------------------------------
 * Pure observation + condition-based alerting. NO auto-trading.
 *
 * Market State:
 *   Direction  : BULLISH | BEARISH | SIDEWAYS
 *   Volatility : VOLATILE | NORMAL
 *   Combined   : e.g. BULLISH_NORMAL
 *
 * Alert Output:
 *   CALL_ENTRY / PUT_ENTRY / EXIT_NOW / AVOID / WATCH
 */

import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: "MPHASIS.NS", // NSE stocks → SYMBOL.NS  |  NIFTY 50 → ^NSEI  |  BANKNIFTY → ^NSEBANK
  TIMEFRAME_MINUTES: 5,
  LOOKBACK_MINUTES: 75,
  DIRECTION_UP_THRESHOLD: 0.6,
  DIRECTION_DOWN_THRESHOLD: 0.4,
  VOLATILITY_MULTIPLIER: 1.5,
  IST_OFFSET_MS: 5.5 * 60 * 60 * 1000,
  MARKET_OPEN_HOUR_UTC: 3,
  MARKET_OPEN_MIN_UTC: 45,

  // ── Historical mode ──────────────────────────────────────────────────────
  // Set to "YYYY-MM-DD" to analyse a past session. null = today (live mode).
  TARGET_DATE: null,

  // ── Alert time windows (IST, 24h) ────────────────────────────────────────
  // No alerts before this time — first 15min is too chaotic
  ENTRY_WINDOW_START_H: 9,
  ENTRY_WINDOW_START_M: 30,
  // No NEW entries after this time — theta accelerates on weeklies
  ENTRY_WINDOW_END_H: 13,
  ENTRY_WINDOW_END_M: 30,
  // Hard exit time — get out before this regardless of state
  HARD_EXIT_H: 14,
  HARD_EXIT_M: 30,
  // Expiry day rules apply only if trading options on this symbol
  EXPIRY_ENTRY_CUTOFF_H: 11,
  EXPIRY_ENTRY_CUTOFF_M: 0,
  EXPIRY_HARD_EXIT_H: 13,
  EXPIRY_HARD_EXIT_M: 0,
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
  // Returns { h, m, s, dayOfWeek } in IST
  const ist = new Date(Date.now() + CONFIG.IST_OFFSET_MS);
  return {
    h: ist.getUTCHours(),
    m: ist.getUTCMinutes(),
    s: ist.getUTCSeconds(),
    dayOfWeek: ist.getUTCDay(), // 0=Sun, 1=Mon ... 4=Thu, 5=Fri
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
  const base = sessionDate();
  return new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate(),
      CONFIG.MARKET_OPEN_HOUR_UTC,
      CONFIG.MARKET_OPEN_MIN_UTC,
      0,
    ),
  );
}

function marketCloseUTC() {
  const base = sessionDate();
  return new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate(),
      10,
      0,
      0, // 15:30 IST = 10:00 UTC
    ),
  );
}

function safeNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function toMins(h, m) {
  return h * 60 + m;
}

// ─── ALERT ENGINE ────────────────────────────────────────────────────────────

// ─── DATA NORMALIZER ─────────────────────────────────────────────────────────

function normalizeYahooResponse(raw) {
  if (!raw) return { candles: null, shape: "null" };

  if (Array.isArray(raw.quotes) && raw.quotes.length > 0) {
    return {
      candles: buildCandlesFromQuotes(raw.quotes),
      shape: "meta+quotes",
    };
  }
  if (Array.isArray(raw.timestamp) && raw.indicators?.quote) {
    return {
      candles: buildCandlesFromTimestamps(
        raw.timestamp,
        raw.indicators.quote[0],
      ),
      shape: "timestamp+indicators",
    };
  }
  if (raw.chart?.result?.length) {
    const r = raw.chart.result[0];
    if (r?.timestamp && r?.indicators?.quote) {
      return {
        candles: buildCandlesFromTimestamps(r.timestamp, r.indicators.quote[0]),
        shape: "chart.result",
      };
    }
  }
  if (Array.isArray(raw) && raw[0]?.timestamp) {
    const r = raw[0];
    return {
      candles: buildCandlesFromTimestamps(
        r.timestamp,
        r.indicators?.quote?.[0],
      ),
      shape: "array[0]",
    };
  }
  return {
    candles: null,
    shape: `unknown(keys:${Object.keys(raw).join(",")})`,
  };
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

function filterSessionCandles(candles) {
  const openMs = marketOpenUTC().getTime();
  const closeMs = CONFIG.TARGET_DATE ? marketCloseUTC().getTime() : Date.now();
  return candles.filter((c) => {
    const tsMs = c.time * 1000;
    return tsMs >= openMs && tsMs <= closeMs;
  });
}

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

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
  const hdr = "═".repeat(60);
  const div = "─".repeat(60);

  console.log(hdr);
  console.log("  NSE Intraday  |  Market State + Trade Alert Engine");
  console.log(hdr);
  console.log(`  Symbol     : ${CONFIG.symbol}`);
  console.log(
    `  Timeframe  : ${CONFIG.TIMEFRAME_MINUTES}m  |  Lookback: ${CONFIG.LOOKBACK_MINUTES} min (${REQUIRED_CANDLES} candles)`,
  );
  const modeLabel = CONFIG.TARGET_DATE
    ? `HISTORICAL : ${CONFIG.TARGET_DATE}`
    : `LIVE       : ${formatIST(new Date())}`;
  console.log(`  Mode       : ${modeLabel}`);
  console.log(div);

  const interval = resolveYahooInterval(CONFIG.TIMEFRAME_MINUTES);
  const isHistorical = Boolean(CONFIG.TARGET_DATE);
  const period1 = marketOpenUTC();
  const period2 = isHistorical ? marketCloseUTC() : new Date();

  let raw;
  try {
    raw = await yahooFinance.chart(CONFIG.symbol, {
      period1,
      period2,
      interval,
    });
  } catch (err) {
    console.error(`[ERROR] Yahoo Finance fetch failed: ${err.message}`);
    process.exit(1);
  }

  const { candles: allCandles, shape } = normalizeYahooResponse(raw);
  if (!allCandles) {
    console.error("[ERROR] Could not extract candles.");
    console.error(
      `[DEBUG] Top-level keys: ${Object.keys(raw ?? {}).join(", ")}`,
    );
    process.exit(1);
  }

  const intradayCandles = filterSessionCandles(allCandles);
  if (intradayCandles.length === 0) {
    console.error("[ERROR] No intraday candles for this session.");
    process.exit(1);
  }

  const completedCandles = isHistorical
    ? intradayCandles
    : intradayCandles.slice(0, -1);
  const liveCandle = intradayCandles[intradayCandles.length - 1];
  const analysisCandles = completedCandles.slice(-REQUIRED_CANDLES);

  if (analysisCandles.length < 2) {
    console.warn("[WARN] Not enough candles yet. Market may have just opened.");
    process.exit(0);
  }

  // ── Analysis ──
  const { direction, upRatio, upCount, comparisons } =
    analyzeDirection(analysisCandles);
  const { volatility, lastRange, avgRange, ratio } = analyzeVolatility([
    ...analysisCandles,
    liveCandle,
  ]);
  const state = `${direction}_${volatility}`;

  // ── Market state output ──
  console.log(
    `  Candles    : ${analysisCandles.length}/${REQUIRED_CANDLES} used  |  shape: ${shape}`,
  );
  console.log(
    `  Last close : ${liveCandle.close.toFixed(2)}  @ ${formatIST(liveCandle.time)}`,
  );
  console.log(div);
  console.log(`  DIRECTION  : ${direction}`);
  console.log(
    `    ↳ Up closes : ${upCount}/${comparisons}  (${(upRatio * 100).toFixed(1)}%)`,
  );
  console.log(`  VOLATILITY : ${volatility}`);
  console.log(
    `    ↳ Last range : ${lastRange?.toFixed(2)}  |  Avg : ${avgRange?.toFixed(2)}  |  Ratio : ${ratio?.toFixed(2)}×`,
  );
  console.log(div);
  console.log(`  ★ MARKET STATE : ${state}`);
  console.log(div);

  // ── Alert engine ──
  // In historical mode we evaluate against end-of-session time (15:30)
  // For historical, temporarily override nowIST to return session close time
  let alert;
  if (isHistorical) {
    // Simulate the end of the session for time checks
    const [y, mo, d] = CONFIG.TARGET_DATE.split("-").map(Number);
    const sessionDay = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const fakeNow = {
      h: 13,
      m: 0,
      s: 0,
      dayOfWeek: sessionDay,
      totalMinutes: 13 * 60,
    };
    alert = evaluateAlertWithTime(direction, volatility, state, fakeNow);
  } else {
    alert = evaluateAlertWithTime(direction, volatility, state, nowIST());
  }

  console.log(`  ${alert.signal}`);
  console.log();
  alert.reasons.forEach((r) => console.log(`  ✦ ${r}`));
  if (alert.warnings?.length) {
    console.log();
    alert.warnings.forEach((w) => console.log(`  ${w}`));
  }
  if (alert.guidance?.length) {
    console.log();
    console.log("  ── Trade Guidance ──────────────────────────────────");
    alert.guidance.forEach((g) => console.log(`  ${g}`));
    console.log();
    console.log("  ── Exit When ───────────────────────────────────────");
    console.log("  • State flips against your position or turns VOLATILE");
    console.log("  • Time crosses 13:30 IST");
    console.log("  • Stop loss hit");
  }
  console.log(hdr);
}

// ─── ALERT ENGINE (time-injectable for historical mode) ───────────────────────

function evaluateAlertWithTime(direction, volatility, state, ist) {
  const now = ist.totalMinutes;
  const isExpiry = ist.dayOfWeek === 4;
  const reasons = [];
  const warnings = [];

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
      reasons: ["Expiry day past 13:00 IST."],
      warnings: [],
    };
  if (now >= hardExit)
    return {
      alert: "EXIT_NOW",
      signal: "🔴 EXIT NOW",
      reasons: ["Past hard exit time."],
      warnings: [],
    };
  if (volatility === "VOLATILE")
    return {
      alert: "EXIT_NOW",
      signal: "🔴 EXIT NOW",
      reasons: ["Market VOLATILE — premium spiked."],
      warnings: [],
    };
  if (now < entryStart)
    return {
      alert: "AVOID",
      signal: "⚪ AVOID",
      reasons: ["Before entry window."],
      warnings: [],
    };
  if (isExpiry && now >= expiryEntry)
    return {
      alert: "AVOID",
      signal: "⚪ AVOID",
      reasons: ["Expiry day entry cutoff passed."],
      warnings: [],
    };
  if (now >= entryEnd)
    return {
      alert: "AVOID",
      signal: "⚪ AVOID",
      reasons: ["Entry window closed."],
      warnings: [],
    };
  if (direction === "SIDEWAYS")
    return {
      alert: "AVOID",
      signal: "⚪ AVOID",
      reasons: ["SIDEWAYS — no edge."],
      warnings: [],
    };

  if (isExpiry) warnings.push("⚠️  Expiry day — keep size small, exit tight.");
  if (now >= entryEnd - 30)
    warnings.push("⚠️  Approaching entry cutoff. Smaller size.");

  if (direction === "BULLISH" && volatility === "NORMAL") {
    return {
      alert: "LONG_ENTRY",
      signal: "🟢 LONG ENTRY",
      reasons: [
        "BULLISH_NORMAL — momentum up, volatility normal, within entry window.",
      ],
      warnings,
      guidance: [
        "Action : Consider LONG (buy equity)",
        "Target : Trail with 15min high — book partial at 1:1.5 R:R",
        "Stop   : Below last completed candle low",
        "Exit   : State → BEARISH/VOLATILE, or time > 13:30",
      ],
    };
  }
  if (direction === "BEARISH" && volatility === "NORMAL") {
    return {
      alert: "SHORT_ENTRY",
      signal: "🔴 SHORT ENTRY",
      reasons: [
        "BEARISH_NORMAL — momentum down, volatility normal, within entry window.",
      ],
      warnings,
      guidance: [
        "Action : Consider SHORT (sell equity / futures)",
        "Target : Trail with 15min low — book partial at 1:1.5 R:R",
        "Stop   : Above last completed candle high",
        "Exit   : State → BULLISH/VOLATILE, or time > 13:30",
      ],
    };
  }
  return {
    alert: "WATCH",
    signal: "🟡 WATCH",
    reasons: [`State: ${state} — not clearly aligned.`],
    warnings,
  };
}

run().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
