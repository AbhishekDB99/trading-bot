import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

/* =========================
   CONFIG
========================= */

const SYMBOL = "^NSEI";
const TIMEFRAME_MINUTES = 5;
const LOOKBACK_MINUTES = 75;

/* =========================
   HELPERS
========================= */

function requiredCandles() {
  return Math.floor(LOOKBACK_MINUTES / TIMEFRAME_MINUTES);
}

function getTodayISTRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(9, 15, 0, 0);
  return { period1: start, period2: now };
}

/* =========================
   YAHOO RESPONSE NORMALIZER
========================= */

function extractChartData(raw) {
  // Case 1: Direct format
  if (raw?.timestamp && raw?.indicators?.quote?.[0]) {
    return raw;
  }

  // Case 2: Wrapped format (most common for NSE)
  if (raw?.chart?.result?.[0]) {
    return raw.chart.result[0];
  }

  throw new Error("Yahoo Finance returned no usable chart data");
}

function normalizeCandles(raw) {
  const chart = extractChartData(raw);

  const quote = chart.indicators.quote[0];
  const timestamps = chart.timestamp;

  const candles = [];

  for (let i = 0; i < timestamps.length; i++) {
    if (
      quote.open[i] == null ||
      quote.high[i] == null ||
      quote.low[i] == null ||
      quote.close[i] == null
    )
      continue;

    candles.push({
      time: new Date(timestamps[i] * 1000),
      open: quote.open[i],
      high: quote.high[i],
      low: quote.low[i],
      close: quote.close[i],
      volume: quote.volume?.[i] ?? 0,
    });
  }

  return candles;
}

/* =========================
   MARKET LOGIC
========================= */

function detectDirection(candles) {
  let up = 0;
  let down = 0;

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) up++;
    else if (candles[i].close < candles[i - 1].close) down++;
  }

  const total = up + down;
  if (total === 0) return "SIDEWAYS";

  const ratio = up / total;
  if (ratio > 0.6) return "BULLISH";
  if (ratio < 0.4) return "BEARISH";
  return "SIDEWAYS";
}

function detectVolatility(candles) {
  const ranges = candles.map((c) => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const lastRange = ranges[ranges.length - 1];

  return lastRange > avgRange * 1.5 ? "VOLATILE" : "NORMAL";
}

function analyzeIntradayTrend(candles) {
  const needed = requiredCandles();

  if (candles.length < needed) {
    throw new Error(
      `Not enough candles (needed ${needed}, got ${candles.length})`,
    );
  }

  const recent = candles.slice(-needed);

  const direction = detectDirection(recent);
  const volatility = detectVolatility(recent);

  return {
    symbol: SYMBOL,
    timeframe: `${TIMEFRAME_MINUTES}m`,
    mode: "INTRADAY",
    candlesAnalyzed: recent.length,
    direction,
    volatility,
    marketState: `${direction}_${volatility}`,
  };
}

/* =========================
   EXECUTION
========================= */

async function run() {
  try {
    const { period1, period2 } = getTodayISTRange();

    const raw = await yahooFinance.chart(SYMBOL, {
      interval: `${TIMEFRAME_MINUTES}m`,
      period1,
      period2,
    });

    const candles = normalizeCandles(raw);

    console.log("Needed candles:", requiredCandles());
    console.log("Available candles:", candles.length);

    const result = analyzeIntradayTrend(candles);

    console.log("\n📊 NIFTY50 INTRADAY MARKET STATE");
    console.log("--------------------------------");
    console.log(result);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

run();
