# Indian Discord TTS + Music Bot — V11 FINAL

## What changed
The previous YouTube/yt-dlp playback path has been removed from the music path. The bot now searches JioSaavn-compatible sources, gets a direct audio CDN URL, downloads the audio locally, and gives the file to Discord voice. This avoids the Railway YouTube bot-check that was breaking playback.

JioSaavn's public/unofficial API ecosystem documents search-by-song-name and returned download links; the exact upstream API can change, so the bot includes a second API fallback.

## Commands
- `!play <song>` — search and play music
- `!t <text>` — Indian Hindi/English TTS
- `!247 on <voice-channel-id>` / `!247 off` — 24/7 voice
- `/play`, `/tts`, `/247`, `/pause`, `/resume`, `/skip`, `/stop`, `/queue`, `/volume`

## Railway variables
- `DISCORD_TOKEN` — required
- `DEFAULT_PREFIX=!`
- `TWENTY_FOUR_SEVEN=true` — automatically reconnect after Railway restart
- `STAY_VC_CHANNEL_ID=<voice channel id>` — voice channel for 24/7

## Music behavior
The bot shows `PREPARING` first. It only changes to `NOW PLAYING` after the audio file has actually been downloaded and submitted to the Discord AudioPlayer.

## Important
The music source is an unofficial JioSaavn integration, not an official JioSaavn developer API. Upstream availability can change. No third-party service can honestly guarantee 100% uptime forever.
