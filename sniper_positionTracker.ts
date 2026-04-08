import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { sendAlert } from './telegram';
import { recordSL, recordTP } from './riskGuard';
import { config } from './config';
import { logTrade } from './tradeLog';
import type { Asset } from './config';

const TRACKER_FILE = path.join(process.cwd(), 'positions-tracker.json');

interface TrackedPosition {
  asset:           string;
  side:            'long' | 'short';
  entryPrice:      number;
  size:            number;
  tpPrice?:        number;
  slPrice?:        number;
  openedAt:        number;
  positionPubkey?: string;
}

interface TrackerState { positions: Record<string, TrackedPosition>; }

function readTracker(): TrackerState {
  if (!fs.existsSync(TRACKER_FILE)) return { positions: {} };
  try { return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8')); }
  catch { return { positions: {} }; }
}

function writeTracker(s: TrackerState) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(s, null, 2));
}

// ── Midpoint detection — proven dari Claude + GPT agent ──────────────────────
function detectCloseReason(
  pos: TrackedPosition, exitPrice: number
): { closeReason: 'TP' | 'SL' | 'UNKNOWN'; pnlUsd: number } {
  const { collateralUsdc, leverage } = config.trading;
  const entry = pos.entryPrice;
  const sl    = pos.slPrice;
  const tp    = pos.tpPrice;
  const fallback = -(collateralUsdc * 0.02);

  if (!sl || !tp || entry <= 0) return { closeReason: 'UNKNOWN', pnlUsd: fallback };

  const calcPnL = (at: number) => {
    const pct = pos.side === 'long'
      ? ((at - entry) / entry) * 100 * leverage
      : ((entry - at) / entry) * 100 * leverage;
    return (collateralUsdc * pct) / 100;
  };

  // Strategy 1: exact
  if (exitPrice > 0) {
    if (pos.side === 'long') {
      if (exitPrice >= tp) return { closeReason: 'TP', pnlUsd: calcPnL(tp) };
      if (exitPrice <= sl) return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
    } else {
      if (exitPrice <= tp) return { closeReason: 'TP', pnlUsd: calcPnL(tp) };
      if (exitPrice >= sl) return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
    }
  }

  // Strategy 2: midpoint
  if (exitPrice > 0) {
    const midTp = (entry + tp) / 2;
    const midSl = (entry + sl) / 2;
    if (pos.side === 'long') {
      if (exitPrice > midTp) { logger.info(`${pos.asset} → TP via midpoint`); return { closeReason: 'TP', pnlUsd: calcPnL(tp) }; }
      if (exitPrice < midSl) { logger.info(`${pos.asset} → SL via midpoint`); return { closeReason: 'SL', pnlUsd: calcPnL(sl) }; }
    } else {
      if (exitPrice < midTp) { logger.info(`${pos.asset} → TP via midpoint`); return { closeReason: 'TP', pnlUsd: calcPnL(tp) }; }
      if (exitPrice > midSl) { logger.info(`${pos.asset} → SL via midpoint`); return { closeReason: 'SL', pnlUsd: calcPnL(sl) }; }
    }
  }

  // Strategy 3: fallback SL
  logger.warn(`${pos.asset} close reason unknown — assuming SL`);
  return { closeReason: 'SL', pnlUsd: calcPnL(sl) };
}

function getExitPrice(asset: string, prices: Record<string, number>): number {
  if (prices[asset]) return prices[asset];
  const aliases: Record<string, string> = { 'WBTC': 'BTC', 'BTC': 'WBTC', 'WETH': 'ETH', 'ETH': 'WETH' };
  return prices[aliases[asset] ?? ''] ?? 0;
}

export async function detectClosedPositions(
  currentPositions: any[],
  marketPrices: Record<string, number> = {}
): Promise<void> {
  const state    = readTracker();
  const prevKeys = Object.keys(state.positions);
  if (prevKeys.length === 0) return;

  const currentKeys = new Set(currentPositions.map((p: any) => p.positionPubkey || p.asset));

  for (const key of prevKeys) {
    if (currentKeys.has(key)) continue;
    const pos      = state.positions[key];
    const exitPrice = getExitPrice(pos.asset, marketPrices);
    const { closeReason, pnlUsd } = detectCloseReason(pos, exitPrice);
    const now      = new Date();
    const duration = Math.round((now.getTime() - pos.openedAt) / 60_000);
    const pnlStr   = `${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(3)}`;
    const emoji    = pos.side === 'long' ? '🟢' : '🔴';
    const rEmoji   = closeReason === 'TP' ? '🎯' : '🛑';

    await sendAlert(
      `${emoji} *CLOSED: ${pos.asset} ${pos.side.toUpperCase()}* _(Sniper)_\n` +
      `${rEmoji} Reason: \`${closeReason}\`\n` +
      `Entry: \`$${pos.entryPrice.toLocaleString()}\`\n` +
      (exitPrice > 0 ? `Exit ~: \`$${exitPrice.toLocaleString()}\`\n` : '') +
      `TP: \`$${pos.tpPrice?.toLocaleString() ?? '—'}\`  SL: \`$${pos.slPrice?.toLocaleString() ?? '—'}\`\n` +
      `PnL: \`${pnlStr}\` ${pnlUsd >= 0 ? '✅' : '❌'}\n` +
      `Duration: \`${duration} min\``
    );

    logTrade({
      id: `${pos.openedAt}-${pos.asset}-${pos.side}`, agent: 'sniper',
      asset: pos.asset, side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: exitPrice || (closeReason === 'TP' ? (pos.tpPrice ?? 0) : (pos.slPrice ?? 0)),
      entryTime: new Date(pos.openedAt).toISOString(), exitTime: now.toISOString(),
      durationMin: duration, slPrice: pos.slPrice ?? null, tpPrice: pos.tpPrice ?? null,
      closeReason, pnlUsd, collateral: config.trading.collateralUsdc, leverage: config.trading.leverage,
    });

    const signal = pos.side === 'long' ? 'LONG' : 'SHORT';
    if (closeReason === 'TP') recordTP(pos.asset as Asset, signal);
    else await recordSL(pos.asset as Asset, signal, Math.abs(pnlUsd));

    delete state.positions[key];
  }
  writeTracker(state);
}

export function updateTrackedPositions(currentPositions: any[]): void {
  const state = readTracker();
  for (const pos of currentPositions) {
    const key = pos.positionPubkey || pos.asset;
    if (state.positions[key]) continue;
    state.positions[key] = {
      asset: pos.asset, side: pos.side,
      entryPrice: pos.entryPriceUsd ?? pos.markPriceUsd ?? 0,
      size: pos.sizeUsd ?? 0,
      tpPrice: pos.tpsl?.find((t: any) => t.type === 'tp')?.triggerPriceUsd,
      slPrice: pos.tpsl?.find((t: any) => t.type === 'sl')?.triggerPriceUsd,
      openedAt: Date.now(), positionPubkey: pos.positionPubkey,
    };
    logger.debug(`Tracking ${pos.asset} ${pos.side}`);
  }
  writeTracker(state);
}
