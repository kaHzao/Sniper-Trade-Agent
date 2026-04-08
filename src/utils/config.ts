import dotenv from 'dotenv';
dotenv.config();

export type Asset = 'SOL' | 'BTC' | 'ETH';
export const ASSETS: Asset[] = ['SOL', 'BTC', 'ETH'];

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId:   process.env.TELEGRAM_CHAT_ID   || '',
  },

  trading: {
    collateralUsdc: parseFloat(process.env.COLLATERAL_USDC || '15'),
    leverage:       parseFloat(process.env.LEVERAGE        || '3'),
    dryRun:         process.env.DRY_RUN !== 'false',
  },

  ta: {
    emaFast:       9,
    emaSlow:       21,
    rsiPeriod:     14,
    rsiBuyMin:     50,
    rsiBuyMax:     70,
    rsiShortMin:   30,
    rsiShortMax:   50,
    atrPeriod:     14,
    atrMultiplier:   1.2,
    atrTpMultiplier: 4.0,
    atrMinPct:       0.008,
    volumeSpike:     2.0,
    crossLookback:   3,
    minConfidence:   80,
    minRR:           3.0,
  },
};
