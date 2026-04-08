import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const LOG_FILE = path.join(process.cwd(), 'trade-log.json');

export interface TradeRecord {
  id:          string;
  agent:       'claude' | 'gpt' | 'sniper';
  asset:       string;
  side:        'long' | 'short';
  entryPrice:  number;
  exitPrice:   number;
  entryTime:   string;
  exitTime:    string;
  durationMin: number;
  slPrice:     number | null;
  tpPrice:     number | null;
  closeReason: 'TP' | 'SL' | 'MANUAL' | 'UNKNOWN';
  pnlUsd:      number;
  collateral:  number;
  leverage:    number;
}

interface LogState {
  trades:    TradeRecord[];
  updatedAt: string;
}

function readLog(): LogState {
  if (!fs.existsSync(LOG_FILE)) return { trades: [], updatedAt: new Date().toISOString() };
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); }
  catch { return { trades: [], updatedAt: new Date().toISOString() }; }
}

function writeLog(state: LogState) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(LOG_FILE, JSON.stringify(state, null, 2));
}

export function logTrade(trade: TradeRecord): void {
  const state  = readLog();
  const exists = state.trades.some(t => t.id === trade.id);
  if (exists) { logger.debug(`Trade ${trade.id} already logged`); return; }
  state.trades.push(trade);
  writeLog(state);
  logger.info(`Trade logged: SNIPER ${trade.side.toUpperCase()} ${trade.asset} ${trade.closeReason} ${trade.pnlUsd >= 0 ? '+' : ''}$${trade.pnlUsd.toFixed(3)}`);
}

export function getAllTrades(): TradeRecord[] {
  return readLog().trades;
}
