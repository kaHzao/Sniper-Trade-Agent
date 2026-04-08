# 🤖 Kazao Alpha Agent

AI-powered Solana CT content agent for @kazao_zao

## What it does
- Monitors Solana CT accounts every hour
- Sends new tweets to Telegram for approval
- Generates content (Post / Reply / Quote / Summary) using Claude AI
- You approve → copy paste to X

## Stack
- **Twitterapi.io** — monitor accounts
- **Claude API** — generate content
- **Telegram Bot** — approval interface
- **GitHub Actions** — scheduler (free)

## Monitored Accounts
- @JupiterExchange
- @toly
- @rajgokal
- @weremeow
- @kashdhanda

## Setup
1. Add GitHub Secrets (see below)
2. Push code to repo
3. GitHub Actions runs automatically

## Required Secrets
```
ANTHROPIC_API_KEY
TWITTERAPI_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

## Cost
~$3.50-5.50/month total
