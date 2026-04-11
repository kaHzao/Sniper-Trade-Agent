import { EMA, RSI, ATR } from 'technicalindicators';
import { config, type Asset, ASSETS } from '../utils/config';
import { logger } from '../utils/logger';

export type Signal       = 'LONG' | 'SHORT' | 'HOLD';
export type MarketRegime = 'TRENDING' | 'SIDEWAYS';

export interface TAResult {
  asset:        Asset;
  signal:       Signal;
  reason:       string;
  confidence:   number;
  currentPrice: number;
  rsi:          number;
  regime:       MarketRegime;
  adx:          number;
  trend1h:      'BULLISH' | 'BEARISH' | 'NEUTRAL';
  suggestedSL:  number;
  suggestedTP:  number;
  slPct:        number;
  tpPct:        number;
  rrRatio:      number;
  crossAge:     number;
  volumeRatio:  number;
  atrPct:       number;
}

interface Candle {
  open: number; high: number; low: number;
  close: number; volume: number;
}

// ─── OKX symbol map ───────────────────────────────────────────────────────────

const OKX_SYMBOL: Record<string, string> = {
  SOL:  'SOL-USDT',
  BTC:  'BTC-USDT',
  WBTC: 'BTC-USDT',
  ETH:  'ETH-USDT',
};

// ─── Fetch OHLCV dari OKX ─────────────────────────────────────────────────────

async function fetchOHLCV(asset: Asset, tf: '15m' | '1h', limit = 100): Promise<Candle[]> {
  const instId = OKX_SYMBOL[asset];
  if (!instId) throw new Error(`Unknown asset: ${asset}`);

  const bar = tf === '15m' ? '15m' : '1H';
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit + 1}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OKX API error: ${res.status}`);

  const json = await res.json() as any;
  if (json.code !== '0') throw new Error(`OKX error: ${json.msg}`);

  // OKX: terbaru → terlama, reverse + buang candle live
  return (json.data as string[][])
    .reverse()
    .slice(0, -1)
    .map(k => ({
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
}

// ─── EMA values ───────────────────────────────────────────────────────────────

function getEMAValues(candles: Candle[]): { fast: number[]; slow: number[] } {
  const closes = candles.map(c => c.close);
  const fast   = EMA.calculate({ period: config.ta.emaFast, values: closes });
  const slow   = EMA.calculate({ period: config.ta.emaSlow, values: closes });
  return { fast, slow };
}

// ─── Fresh EMA cross detection ────────────────────────────────────────────────

function detectFreshCross(
  fast: number[], slow: number[]
): { crossed: boolean; direction: 'UP' | 'DOWN'; age: number } {
  if (fast.length < config.ta.crossLookback + 1 || slow.length < config.ta.crossLookback + 1) {
    return { crossed: false, direction: 'UP', age: 99 };
  }

  for (let age = 1; age <= config.ta.crossLookback; age++) {
    const idx     = fast.length - 1 - age;
    const idxPrev = idx - 1;
    if (idxPrev < 0) continue;

    const currFast = fast[idx];     const currSlow = slow[idx];
    const prevFast = fast[idxPrev]; const prevSlow = slow[idxPrev];

    if (prevFast <= prevSlow && currFast > currSlow) {
      return { crossed: true, direction: 'UP', age };
    }
    if (prevFast >= prevSlow && currFast < currSlow) {
      return { crossed: true, direction: 'DOWN', age };
    }
  }

  return { crossed: false, direction: 'UP', age: 99 };
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

function getRSI(candles: Candle[]): number {
  const arr = RSI.calculate({ period: config.ta.rsiPeriod, values: candles.map(c => c.close) });
  return arr.length ? arr[arr.length - 1] : 50;
}

// ─── ATR ──────────────────────────────────────────────────────────────────────

function getATR(candles: Candle[]): number {
  const arr = ATR.calculate({
    period: config.ta.atrPeriod,
    high:   candles.map(c => c.high),
    low:    candles.map(c => c.low),
    close:  candles.map(c => c.close),
  });
  return arr.length ? arr[arr.length - 1] : candles[candles.length - 1].close * 0.01;
}

// ─── Volume spike ─────────────────────────────────────────────────────────────

function getVolumeRatio(candles: Candle[]): number {
  if (candles.length < 21) return 0;
  const avg = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  if (avg === 0) return 0;
  return candles[candles.length - 1].volume / avg;
}

// ─── Confidence score ─────────────────────────────────────────────────────────

function calcConfidence(
  crossAge:    number,
  rsi:         number,
  signal:      Signal,
  volumeRatio: number,
  atrPct:      number,
): number {
  let score = 0;

  if      (crossAge === 1) score += 35;
  else if (crossAge === 2) score += 25;
  else if (crossAge === 3) score += 15;

  const isLong = signal === 'LONG';
  const rsiOk  = isLong
    ? (rsi >= config.ta.rsiBuyMin  && rsi <= config.ta.rsiBuyMax)
    : (rsi >= config.ta.rsiShortMin && rsi <= config.ta.rsiShortMax);
  if (rsiOk) score += 25;
  else if (isLong ? (rsi >= 45 && rsi <= 75) : (rsi >= 25 && rsi <= 55)) score += 10;

  if      (volumeRatio >= config.ta.volumeSpike) score += 25;
  else if (volumeRatio >= 1.5)                   score += 15;
  else if (volumeRatio >= 1.2)                   score += 5;

  if (atrPct >= config.ta.atrMinPct) score += 15;
  else if (atrPct >= config.ta.atrMinPct * 0.7) score += 5;

  return Math.min(100, score);
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyzeAsset(asset: Asset): Promise<TAResult | null> {
  try {
    logger.info(`Analyzing ${asset}...`);

    const c1h  = await fetchOHLCV(asset, '1h',  80);
    await new Promise(r => setTimeout(r, 500));
    const c15m = await fetchOHLCV(asset, '15m', 60);

    if (c1h.length < 30 || c15m.length < 25) {
      logger.warn(`${asset}: insufficient candles`);
      return null;
    }

    const price = c15m[c15m.length - 1].close;

    const atr1h  = getATR(c1h);
    const atrPct = atr1h / price;

    if (atrPct < config.ta.atrMinPct * 0.5) {
      const reason = `ATR terlalu kecil (${(atrPct*100).toFixed(3)}%) — market sepi`;
      logger.info(`${asset} → HOLD | ${reason}`);
      return makeHold(asset, reason, price, 0, 0, 0);
    }

    const { fast: fast1h, slow: slow1h } = getEMAValues(c1h);
    const cross = detectFreshCross(fast1h, slow1h);

    const currFast = fast1h[fast1h.length - 1];
    const currSlow = slow1h[slow1h.length - 1];
    const trend1h: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
      currFast > currSlow ? 'BULLISH' : currFast < currSlow ? 'BEARISH' : 'NEUTRAL';

    const rsi         = getRSI(c15m);
    const volumeRatio = getVolumeRatio(c15m);

    logger.info(
      `${asset} | cross:${cross.crossed ? cross.direction+'(age:'+cross.age+')' : 'none'} | ` +
      `trend:${trend1h} | RSI:${rsi.toFixed(1)} | vol:${volumeRatio.toFixed(2)}x | ATR:${(atrPct*100).toFixed(3)}%`
    );

    let signal: Signal = 'HOLD';
    let reason = '';

    if (!cross.crossed) {
      reason = `No fresh EMA cross dalam ${config.ta.crossLookback} candle terakhir`;
    } else if (cross.direction === 'UP') {
      if (trend1h !== 'BULLISH') {
        reason = `Bullish cross tapi trend 1h masih ${trend1h}`;
      } else if (rsi < config.ta.rsiBuyMin - 5) {
        reason = `Bullish cross tapi RSI terlalu rendah (${rsi.toFixed(1)})`;
      } else if (rsi > config.ta.rsiBuyMax + 5) {
        reason = `Bullish cross tapi RSI overbought (${rsi.toFixed(1)})`;
      } else if (volumeRatio < 1.2) {
        reason = `Bullish cross tapi volume lemah (${volumeRatio.toFixed(2)}x)`;
      } else {
        signal = 'LONG';
        reason = `Fresh bullish cross (age:${cross.age}) | RSI:${rsi.toFixed(1)} | vol:${volumeRatio.toFixed(2)}x | ATR:${(atrPct*100).toFixed(3)}%`;
      }
    } else {
      if (trend1h !== 'BEARISH') {
        reason = `Bearish cross tapi trend 1h masih ${trend1h}`;
      } else if (rsi > config.ta.rsiShortMax + 5) {
        reason = `Bearish cross tapi RSI terlalu tinggi (${rsi.toFixed(1)})`;
      } else if (rsi < config.ta.rsiShortMin - 5) {
        reason = `Bearish cross tapi RSI oversold (${rsi.toFixed(1)})`;
      } else if (volumeRatio < 1.2) {
        reason = `Bearish cross tapi volume lemah (${volumeRatio.toFixed(2)}x)`;
      } else {
        signal = 'SHORT';
        reason = `Fresh bearish cross (age:${cross.age}) | RSI:${rsi.toFixed(1)} | vol:${volumeRatio.toFixed(2)}x | ATR:${(atrPct*100).toFixed(3)}%`;
      }
    }

    const confidence = signal !== 'HOLD'
      ? calcConfidence(cross.age, rsi, signal, volumeRatio, atrPct)
      : 0;

    if (signal !== 'HOLD' && confidence < config.ta.minConfidence) {
      reason = `Confidence terlalu rendah (${confidence}% < ${config.ta.minConfidence}%) — skip`;
      signal = 'HOLD';
    }

    logger.info(`${asset} → ${signal} | conf:${confidence}% | ${reason}`);

    if (signal === 'HOLD') {
      return makeHold(asset, reason, price, rsi, volumeRatio, atrPct, trend1h, confidence);
    }

    const slDist = atr1h * config.ta.atrMultiplier;
    const tpDist = atr1h * config.ta.atrTpMultiplier;

    const sl = signal === 'LONG' ? price - slDist : price + slDist;
    const tp = signal === 'LONG' ? price + tpDist : price - tpDist;

    if (slDist <= 0 || tpDist <= 0) {
      return makeHold(asset, 'Invalid SL/TP', price, rsi, volumeRatio, atrPct);
    }

    const rr    = tpDist / slDist;
    const slPct = (slDist / price) * 100;
    const tpPct = (tpDist / price) * 100;

    if (rr < config.ta.minRR) {
      return makeHold(asset, `R:R ${rr.toFixed(2)} < ${config.ta.minRR}`, price, rsi, volumeRatio, atrPct, trend1h, confidence);
    }

    return {
      asset, signal, reason, confidence, currentPrice: price,
      rsi, regime: 'TRENDING', adx: 0, trend1h,
      suggestedSL: sl, suggestedTP: tp, slPct, tpPct, rrRatio: rr,
      crossAge: cross.age, volumeRatio, atrPct,
    };

  } catch (err: any) {
    logger.error(`${asset} analysis failed: ${err.message}`);
    return null;
  }
}

function makeHold(
  asset: Asset, reason: string, price: number,
  rsi = 50, volumeRatio = 0, atrPct = 0,
  trend1h: 'BULLISH'|'BEARISH'|'NEUTRAL' = 'NEUTRAL',
  confidence = 0
): TAResult {
  return {
    asset, signal: 'HOLD', reason, confidence, currentPrice: price,
    rsi, regime: 'SIDEWAYS', adx: 0, trend1h,
    suggestedSL: 0, suggestedTP: 0, slPct: 0, tpPct: 0, rrRatio: 0,
    crossAge: 99, volumeRatio, atrPct,
  };
}

export async function analyzeAll(): Promise<TAResult[]> {
  const results: TAResult[] = [];
  for (const asset of ASSETS) {
    const r = await analyzeAsset(asset).catch(() => null);
    if (r) results.push(r);
    await new Promise(res => setTimeout(res, 3000));
  }
  return results;
}
