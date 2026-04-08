import os
import json
import requests
import anthropic
from datetime import datetime, timezone

TWITTER_API_KEY   = os.environ["TWITTERAPI_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
TELEGRAM_TOKEN    = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID  = os.environ["TELEGRAM_CHAT_ID"]

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
"""

def get_tweet_by_id(tweet_id: str) -> dict:
    url = "https://api.twitterapi.io/twitter/tweets"
    headers = {"X-API-Key": TWITTER_API_KEY}
    params = {"tweet_ids": tweet_id}
    try:
        response = requests.get(url, headers=headers, params=params, timeout=15)
        data = response.json()
        tweets = data.get("tweets", [])
        return tweets[0] if tweets else {}
    except Exception as e:
        print(f"Error fetching tweet {tweet_id}: {e}")
        return {}

def generate_content(tweet_text: str, author: str, mode: str) -> str:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    
    mode_instructions = {
        "post": f'Create a standalone tweet inspired by this tweet from @{author}. Do NOT copy it. Create original content with your own angle. Max 280 characters. No hashtags unless very relevant.\nTweet: "{tweet_text}"',
        "reply": f'Write a reply to this tweet from @{author}. Be engaging, add value or insight. Max 280 characters.\nTweet: "{tweet_text}"',
        "quote": f'Write a quote tweet comment for this tweet from @{author}. Short, punchy, adds your perspective. Max 200 characters.\nTweet: "{tweet_text}"',
        "summary": f'Summarize this tweet from @{author} as a thread starter. Format: "Alpha you might have missed 🧵" style. First tweet only, max 280 characters.\nTweet: "{tweet_text}"',
    }
    
    prompt = mode_instructions.get(mode, mode_instructions["post"])
    
    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=300,
        messages=[{
            "role": "user",
            "content": f"{PERSONA}\n\n{prompt}\n\nRespond with ONLY the tweet text, nothing else."
        }]
    )
    return message.content[0].text.strip()

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

def answer_callback(callback_query_id: str, text: str = ""):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/answerCallbackQuery"
    requests.post(url, json={"callback_query_id": callback_query_id, "text": text}, timeout=10)

def get_pending_callbacks():
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates"
    params = {"timeout": 5, "allowed_updates": ["callback_query"]}
    try:
        response = requests.get(url, params=params, timeout=15)
        return response.json().get("result", [])
    except:
        return []

def mark_update_processed(update_id: int):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates"
    requests.get(url, params={"offset": update_id + 1, "timeout": 1}, timeout=10)

def load_pending_tweets() -> dict:
    try:
        with open("pending_tweets.json", "r") as f:
            return json.load(f)
    except:
        return {}

def save_pending_tweets(data: dict):
    with open("pending_tweets.json", "w") as f:
        json.dump(data, f)

def process_callbacks():
    updates = get_pending_callbacks()
    
    if not updates:
        print("No pending callbacks.")
        return
    
    pending = load_pending_tweets()
    
    for update in updates:
        callback = update.get("callback_query", {})
        if not callback:
            continue
        
        callback_id   = callback.get("id")
        callback_data = callback.get("data", "")
        
        parts = callback_data.split("|")
        if len(parts) < 3:
            continue
        
        action, tweet_id, author = parts[0], parts[1], parts[2]
        
        answer_callback(callback_id, "Processing...")
        
        if action == "skip":
            send_telegram(f"⏭ Skipped tweet from @{author}")
            if tweet_id in pending:
                del pending[tweet_id]
        
        elif action in ["post", "reply", "quote", "summary"]:
            # Get tweet text
            tweet_text = pending.get(tweet_id, {}).get("text", "")
            
            if not tweet_text:
                # Fetch from API
                tweet_data = get_tweet_by_id(tweet_id)
                tweet_text = tweet_data.get("text", "No text found")
                pending[tweet_id] = {"text": tweet_text, "author": author}
            
            # Generate content
            generated = generate_content(tweet_text, author, action)
            tweet_url  = f"https://x.com/{author}/status/{tweet_id}"
            
            mode_labels = {
                "post":    "📝 POST",
                "reply":   "💬 REPLY",
                "quote":   "🔁 QUOTE+POST",
                "summary": "📊 SUMMARY",
            }
            
            # Build result message
            if action == "reply":
                instruction = f"\n\n<b>👉 Go to:</b> {tweet_url}\n<b>Reply with:</b>"
            elif action == "quote":
                instruction = f"\n\n<b>👉 Quote this tweet:</b> {tweet_url}\n<b>Add comment:</b>"
            else:
                instruction = "\n\n<b>👉 Copy and post to X:</b>"
            
            message = (
                f"━━━━━━━━━━━━━━━━━━\n"
                f"✅ <b>{mode_labels[action]} READY</b>\n"
                f"━━━━━━━━━━━━━━━━━━\n\n"
                f"{generated}"
                f"{instruction}\n"
            )
            
            keyboard = {
                "inline_keyboard": [[
                    {"text": "🔄 Regenerate", "callback_data": f"{action}|{tweet_id}|{author}"},
                    {"text": "✅ Done",        "callback_data": f"done|{tweet_id}|{author}"},
                ]]
            }
            
            send_telegram(message, keyboard)
        
        elif action == "done":
            send_telegram(f"🚀 Posted! Great content @kazao_zao 👊")
            if tweet_id in pending:
                del pending[tweet_id]
        
        mark_update_processed(update["update_id"])
    
    save_pending_tweets(pending)
    print(f"Processed {len(updates)} callbacks.")

if __name__ == "__main__":
    print(f"[{datetime.now(timezone.utc).isoformat()}] Callback handler started")
    process_callbacks()
