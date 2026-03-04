import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

/**
 * Fetch last N daily candles for Nifty50
 */
// async function fetchNiftyCandles(days = 1) {
//   const now = new Date();
//   const past = new Date();
//   past.setDate(now.getDate() - days);

//   const result = await yahooFinance.chart("^NSEI", {
//     period1: past, // ✅ Date object
//     period2: now, // ✅ Date object
//     interval: "1d",
//   });

//   return result.quotes.map((q) => ({
//     open: q.open,
//     high: q.high,
//     low: q.low,
//     close: q.close,
//   }));
// }

async function fetchNiftyCandlesUntil(endDate, days = 30) {
  const end = new Date(endDate);
  const start = new Date(end);
  start.setDate(end.getDate() - days);

  const result = await yahooFinance.chart("^NSEI", {
    period1: start,
    period2: end,
    interval: "1d",
  });

  return result.quotes.map((q) => ({
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
  }));
}

/**
 * Market state analyzer (observation only)
 */
function analyzeTrend(candles) {
  if (candles.length < 20) {
    throw new Error("Not enough data");
  }

  const returns = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    returns.push((curr - prev) / prev);
  }

  const positive = returns.filter((r) => r > 0).length;
  const negative = returns.filter((r) => r < 0).length;
  const directionBias = Math.abs(positive - negative) / returns.length;

  const ranges = candles.map((c) => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const recentRange = ranges.slice(-5).reduce((a, b) => a + b, 0) / 5;

  const volatilityExpanding = recentRange > avgRange * 1.2;

  if (directionBias > 0.6 && !volatilityExpanding) {
    return {
      state: "TRENDING",
      bias: positive > negative ? "UP" : "DOWN",
    };
  }

  if (directionBias < 0.3 && !volatilityExpanding) {
    return {
      state: "RANGING",
      bias: "NEUTRAL",
    };
  }

  return {
    state: "VOLATILE",
    bias: "UNSTABLE",
  };
}

/**
 * Run observer
 */
(async function run() {
  try {
    const candles = await fetchNiftyCandlesUntil("2026-02-03", 30);
    const state = analyzeTrend(candles);

    console.log("📊 NIFTY50 MARKET STATE");
    console.log("----------------------");
    console.log(state);
  } catch (err) {
    console.error("Error:", err.message);
  }
})();
