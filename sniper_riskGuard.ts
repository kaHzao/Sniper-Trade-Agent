import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { sendAlert } from './telegram';
import type { Asset } from './config';

const GUARD_FILE = path.join(process.cwd(), 'risk-guard.json');

// ── Sniper risk config — lebih ketat karena leverage 3x ──────────────────────
export const MAX_TRADES_PER_DAY   = 1;    // max 1 trade per asset per hari
export const MAX_DAILY_LOSS       = 2.25; // $15 × 3x × 5% = $2.25
export const MAX_LOSS_PER_ASSET   = 0.90; // max loss per asset per hari
export const MAX_CONSEC_LOSS      = 2;    // block setelah 2x SL
export const CONSEC_BLOCK_HOURS   = 48;   // block 48 jam (lebih lama dari Claude/GPT)
export const COOLDOWN_HOURS       = 4;    // cooldown setelah 1 SL

interface AssetGuard {
  tradesToday:       number;
  lossToday:         number;
  lastSLTime?:       number;
  longConsecLoss:    number;
  shortConsecLoss:   number;
  longBlockedUntil?:  number;
  shortBlockedUntil?: number;
}

interface GuardState {
  date:           string;
  assets:         Record<string, AssetGuard>;
  totalLossToday: number;
}

function readGuard(): GuardState {
  const today = new Date().toISOString().split('T')[0];
  if (!fs.existsSync(GUARD_FILE)) return { date: today, assets: {}, totalLossToday: 0 };
  try {
    const state = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf-8')) as GuardState;
    if (state.date !== today) {
      const newAssets: Record<string, AssetGuard> = {};
      for (const [asset, g] of Object.entries(state.assets)) {
        newAssets[asset] = {
          tradesToday: 0, lossToday: 0,
          longConsecLoss:    g.longConsecLoss    || 0,
          shortConsecLoss:   g.shortConsecLoss   || 0,
          longBlockedUntil:  g.longBlockedUntil,
          shortBlockedUntil: g.shortBlockedUntil,
        };
      }
      return { date: today, assets: newAssets, totalLossToday: 0 };
    }
    return state;
  } catch { return { date: today, assets: {}, totalLossToday: 0 }; }
}

function writeGuard(state: GuardState) {
  fs.writeFileSync(GUARD_FILE, JSON.stringify(state, null, 2));
}

function getAsset(state: GuardState, asset: Asset): AssetGuard {
  if (!state.assets[asset]) {
    state.assets[asset] = { tradesToday: 0, lossToday: 0, longConsecLoss: 0, shortConsecLoss: 0 };
  }
  return state.assets[asset];
}

export interface GuardCheck { allowed: boolean; reason?: string; }

export function canTrade(asset: Asset, signal: 'LONG' | 'SHORT'): GuardCheck {
  const state = readGuard();
  const g     = getAsset(state, asset);
  const now   = Date.now();

  if (state.totalLossToday >= MAX_DAILY_LOSS)
    return { allowed: false, reason: `Daily loss limit ($${state.totalLossToday.toFixed(2)}/$${MAX_DAILY_LOSS}) — STOP` };

  if (g.lossToday >= MAX_LOSS_PER_ASSET)
    return { allowed: false, reason: `Max loss ${asset} today ($${g.lossToday.toFixed(2)}/$${MAX_LOSS_PER_ASSET})` };

  if (g.tradesToday >= MAX_TRADES_PER_DAY)
    return { allowed: false, reason: `Max 1 trade/asset/day — ${asset} sudah trade hari ini` };

  if (signal === 'LONG' && g.longBlockedUntil && now < g.longBlockedUntil) {
    const h = ((g.longBlockedUntil - now) / 3600000).toFixed(1);
    return { allowed: false, reason: `LONG ${asset} blocked ${CONSEC_BLOCK_HOURS}h — ${h}h remaining` };
  }
  if (signal === 'SHORT' && g.shortBlockedUntil && now < g.shortBlockedUntil) {
    const h = ((g.shortBlockedUntil - now) / 3600000).toFixed(1);
    return { allowed: false, reason: `SHORT ${asset} blocked ${CONSEC_BLOCK_HOURS}h — ${h}h remaining` };
  }
  if (g.lastSLTime) {
    const hrs = (now - g.lastSLTime) / 3600000;
    if (hrs < COOLDOWN_HOURS) {
      const rem = (COOLDOWN_HOURS - hrs).toFixed(1);
      return { allowed: false, reason: `Cooldown ${asset}: ${rem}h remaining after SL` };
    }
  }
  return { allowed: true };
}

export async function recordSL(asset: Asset, signal: 'LONG' | 'SHORT', pnlUsd: number): Promise<void> {
  const state = readGuard();
  const g     = getAsset(state, asset);
  const loss  = Math.abs(pnlUsd);
  const now   = Date.now();

  g.lossToday          = (g.lossToday || 0) + loss;
  g.lastSLTime         = now;
  state.totalLossToday = (state.totalLossToday || 0) + loss;

  if (signal === 'LONG') {
    g.longConsecLoss = (g.longConsecLoss || 0) + 1;
    if (g.longConsecLoss >= MAX_CONSEC_LOSS) {
      g.longBlockedUntil = now + CONSEC_BLOCK_HOURS * 3600000;
      g.longConsecLoss   = 0;
      const msg = `⛔ *LONG ${asset} BLOCKED* _(Sniper)_\n${MAX_CONSEC_LOSS}x consecutive SL\nBlocked: ${CONSEC_BLOCK_HOURS}h`;
      await sendAlert(msg);
    }
  } else {
    g.shortConsecLoss = (g.shortConsecLoss || 0) + 1;
    if (g.shortConsecLoss >= MAX_CONSEC_LOSS) {
      g.shortBlockedUntil = now + CONSEC_BLOCK_HOURS * 3600000;
      g.shortConsecLoss   = 0;
      const msg = `⛔ *SHORT ${asset} BLOCKED* _(Sniper)_\n${MAX_CONSEC_LOSS}x consecutive SL\nBlocked: ${CONSEC_BLOCK_HOURS}h`;
      await sendAlert(msg);
    }
  }
  writeGuard(state);
}

export function recordTP(asset: Asset, signal: 'LONG' | 'SHORT'): void {
  const state = readGuard();
  const g     = getAsset(state, asset);
  if (signal === 'LONG')  g.longConsecLoss  = 0;
  else                    g.shortConsecLoss = 0;
  writeGuard(state);
}

export function recordTradeOpened(asset: Asset): void {
  const state = readGuard();
  const g     = getAsset(state, asset);
  g.tradesToday = (g.tradesToday || 0) + 1;
  writeGuard(state);
}

export function getDailyStatus(): string {
  const state = readGuard();
  const now   = Date.now();
  const lines = [`Sniper Daily (${state.date}) | Loss: $${state.totalLossToday.toFixed(2)}/$${MAX_DAILY_LOSS}`];
  for (const [asset, g] of Object.entries(state.assets)) {
    const lb = g.longBlockedUntil  && now < g.longBlockedUntil  ? `L-blocked ${((g.longBlockedUntil  - now)/3600000).toFixed(1)}h` : '';
    const sb = g.shortBlockedUntil && now < g.shortBlockedUntil ? `S-blocked ${((g.shortBlockedUntil - now)/3600000).toFixed(1)}h` : '';
    const blocks = [lb, sb].filter(Boolean).join(' | ');
    lines.push(`${asset}: ${g.tradesToday} trade | loss $${(g.lossToday||0).toFixed(2)} | L:${g.longConsecLoss||0} S:${g.shortConsecLoss||0}${blocks ? ' | '+blocks : ''}`);
  }
  return lines.join('\n');
}
