# 🇮🇳 Indian TTS + Music Bot — Railway V9

Professional Discord bot with:
- Hindi + Indian English neural TTS
- `!t <text>` TTS with server display-name attribution
- Hinglish normalization
- YouTube music search/playback
- Pause / Resume / Skip / Stop / Queue buttons
- Real playback status: PREPARING → NOW PLAYING, or MUSIC FAILED with the actual error
- Current yt-dlp EJS support
- bgutil PO-token provider support for modern YouTube restrictions
- HLS/m3u8 preference for the current `web_safari` client path
- 24/7 voice reconnect mode
- Railway Docker deployment

## Railway Variables

Required:
- `DISCORD_TOKEN`

Optional:
- `GUILD_ID`
- `DEFAULT_PREFIX=!`
- `BOT_STATUS=🇮🇳 Indian Voice • Music`
- `TWENTY_FOUR_SEVEN=false`
- `STAY_VC_CHANNEL_ID=`
- `YTDLP_POT_URL=http://127.0.0.1:4416`

## Commands

Slash:
- `/play`
- `/pause`
- `/resume`
- `/skip`
- `/stop`
- `/queue`
- `/volume`
- `/join`
- `/leave`
- `/tts`
- `/247`
- `/prefix`

Prefix (default `!`):
- `!play <song>`
- `!pause`, `!resume`, `!skip`, `!stop`, `!queue`
- `!t <text>`
- `!join`, `!leave`
- `!247 on` / `!247 off`
- `!help`

## 24/7

Set:
`TWENTY_FOUR_SEVEN=true`
`STAY_VC_CHANNEL_ID=YOUR_VOICE_CHANNEL_ID`

Then redeploy. The bot will join that voice channel and reconnect after a disconnect.

## Important YouTube note

YouTube changes anti-bot and Proof-of-Origin requirements over time. This version uses current yt-dlp/EJS support, the bgutil PO-token provider, and a `web_safari` HLS-first extraction path. No third-party bot can guarantee that every YouTube video will always be playable if YouTube blocks a particular source/IP.
