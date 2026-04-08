import os
import json
import requests
import anthropic
from datetime import datetime, timezone

# ── CONFIG ──────────────────────────────────────────────
TWITTER_API_KEY   = os.environ["TWITTERAPI_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
TELEGRAM_TOKEN    = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID  = os.environ["TELEGRAM_CHAT_ID"]

ACCOUNTS_TO_MONITOR = [
    "JupiterExchange",
    "toly",
    "rajgokal",
    "weremeow",
    "kashdhanda",
]

PERSONA = """
You are a social media manager for @kazao_zao on Crypto Twitter (CT).

Persona: The Quiet Alpha Hunter
- Calm & insightful, never over-hype
- Bullish but always with a reason
- Style: English mixed with CT slang, chill vibes
- Tone: "few understand this" energy
- Never use excessive emojis or all caps
- Keep it concise, punchy, and confident

CT Slang to use naturally:
gm, few, probably nothing, quietly, ngmi/wagmi, wen, ser, based, nfa, LFG, alpha, CT, degen

Examples of your writing style:
- "Jupiter just hit $2B volume. quietly becoming the backbone of Solana DeFi. few paying attention. gm 🌅"
- "new protocol just dropped their point system. early users always win. probably nothing 👀"
- "this is the move ser. nfa but the on-chain data doesn't lie."
"""

# ── TWITTER API ──────────────────────────────────────────
def get_user_tweets(username: str, max_results: int = 5) -> list:
    url = "https://api.twitterapi.io/twitter/user/last_tweets"
    headers = {"X-API-Key": TWITTER_API_KEY}
    params = {"userName": username, "count": max_results}
    
    try:
        response = requests.get(url, headers=headers, params=params, timeout=15)
        data = response.json()
        tweets = data.get("tweets", [])
        return tweets
    except Exception as e:
        print(f"Error fetching tweets for {username}: {e}")
        return []

# ── LOAD & SAVE SEEN TWEETS ──────────────────────────────
def load_seen_ids() -> set:
    try:
        with open("seen_ids.json", "r") as f:
            return set(json.load(f))
    except:
        return set()

def save_seen_ids(seen_ids: set):
    # Keep only last 1000 IDs to avoid file growing too large
    ids_list = list(seen_ids)[-1000:]
    with open("seen_ids.json", "w") as f:
        json.dump(ids_list, f)

# ── CLAUDE CONTENT GENERATOR ────────────────────────────
def generate_content(tweet_text: str, author: str, mode: str) -> str:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    
    mode_instructions = {
        "post": f"""
Create a standalone tweet inspired by this tweet from @{author}.
Do NOT copy it. Create original content with your own angle.
Max 280 characters. No hashtags unless very relevant.
Tweet to write about: "{tweet_text}"
""",
        "reply": f"""
Write a reply to this tweet from @{author}.
Be engaging, add value or insight. Max 280 characters.
Original tweet: "{tweet_text}"
""",
        "quote": f"""
Write a quote tweet comment for this tweet from @{author}.
Short, punchy, adds your perspective. Max 200 characters.
(The original tweet will be attached automatically)
Original tweet: "{tweet_text}"
""",
        "summary": f"""
Summarize this tweet from @{author} as a thread starter.
Format: "Alpha you might have missed 🧵" style.
First tweet only, max 280 characters.
Tweet: "{tweet_text}"
"""
    }
    
    prompt = mode_instructions.get(mode, mode_instructions["post"])
    
    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=300,
        messages=[
            {
                "role": "user",
                "content": f"{PERSONA}\n\n{prompt}\n\nRespond with ONLY the tweet text, nothing else."
            }
        ]
    )
    
    return message.content[0].text.strip()

# ── TELEGRAM ─────────────────────────────────────────────
def send_telegram(text: str, reply_markup: dict = None):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
    }
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    
    try:
        requests.post(url, json=payload, timeout=10)
    except Exception as e:
        print(f"Telegram error: {e}")

def send_tweet_notification(tweet: dict, author: str):
    tweet_id   = tweet.get("id") or tweet.get("tweet_id", "")
    tweet_text = tweet.get("text", "")
    tweet_url  = f"https://x.com/{author}/status/{tweet_id}"
    
    # Truncate long tweets for display
    display_text = tweet_text[:200] + "..." if len(tweet_text) > 200 else tweet_text
    
    message = (
        f"━━━━━━━━━━━━━━━━━━\n"
        f"📢 <b>NEW TWEET</b>\n\n"
        f"👤 <b>@{author}</b>\n"
        f"🕐 Just now\n\n"
        f"{display_text}\n\n"
        f"🔗 <a href='{tweet_url}'>View Tweet</a>\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"Mau dijadikan apa?"
    )
    
    keyboard = {
        "inline_keyboard": [
            [
                {"text": "📝 Post",        "callback_data": f"post|{tweet_id}|{author}"},
                {"text": "💬 Reply",       "callback_data": f"reply|{tweet_id}|{author}"},
            ],
            [
                {"text": "🔁 Quote+Post",  "callback_data": f"quote|{tweet_id}|{author}"},
                {"text": "📊 Summary",     "callback_data": f"summary|{tweet_id}|{author}"},
            ],
            [
                {"text": "❌ Skip",        "callback_data": f"skip|{tweet_id}|{author}"},
            ]
        ]
    }
    
    send_telegram(message, keyboard)

# ── MAIN ─────────────────────────────────────────────────
def main():
    print(f"[{datetime.now(timezone.utc).isoformat()}] Agent started")
    
    seen_ids = load_seen_ids()
    new_tweets_found = 0
    
    for account in ACCOUNTS_TO_MONITOR:
        print(f"Checking @{account}...")
        tweets = get_user_tweets(account, max_results=5)
        
        for tweet in tweets:
            tweet_id = str(tweet.get("id") or tweet.get("tweet_id", ""))
            
            if not tweet_id or tweet_id in seen_ids:
                continue
            
            # New tweet found!
            new_tweets_found += 1
            seen_ids.add(tweet_id)
            print(f"  New tweet from @{account}: {tweet_id}")
            
            # Send to Telegram for approval
            send_tweet_notification(tweet, account)
    
    save_seen_ids(seen_ids)
    print(f"Done. Found {new_tweets_found} new tweets.")

if __name__ == "__main__":
    main()
