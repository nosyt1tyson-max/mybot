# 🇮🇳 Indian TTS + Music Discord Bot

A Railway-ready Discord bot with:

- 🇮🇳 Hindi neural TTS: `hi-IN-SwaraNeural`
- 🇮🇳 Indian English neural TTS: `en-IN-NeerjaNeural`
- 🤖 Auto language selection for Hindi/English
- 🎵 Music search/playback using yt-dlp + FFmpeg
- ▶️ Play / pause / resume / skip / stop
- 📜 Queue
- 🔊 Volume
- 🔌 Automatic voice reconnect handling
- ☁️ Docker-based Railway deployment
- 🔐 Token stored only in Railway Variables

## Commands

`/join` — Join your current voice channel.

`/leave` — Leave and clear everything.

`/tts text:<message> language:<auto|hi|en>` — Speak in Indian Hindi/English.

`/play query:<song name or URL>` — Search and play music.

`/pause`

`/resume`

`/skip`

`/stop`

`/queue`

`/volume percent:<1-100>`

## 1. Create the Discord bot

1. Open the Discord Developer Portal.
2. Create an Application.
3. Open **Bot** and create the bot user.
4. Copy the bot token once. Do NOT put the real token into GitHub.
5. Invite the bot using OAuth2 URL Generator.
6. Select scopes:
   - `bot`
   - `applications.commands`
7. Give it these permissions:
   - View Channels
   - Send Messages
   - Connect
   - Speak

## 2. GitHub

Upload every file/folder from this project to the root of your GitHub repository.

Do NOT upload `.env`.

## 3. Railway

1. Create a new Railway project.
2. Choose **Deploy from GitHub repo**.
3. Select this repository.
4. Railway will detect the Dockerfile.
5. Open the service → **Variables**.
6. Add:

`DISCORD_TOKEN` = your real Discord bot token

Optional:

`GUILD_ID` = your Discord server ID

`BOT_STATUS` = Hindi TTS + Music

If you set GUILD_ID, slash commands are registered specifically to that server and normally appear quickly. If you leave it empty, commands are registered globally.

Do not manually set Railway's PORT; this bot does not need a web server.

## 4. Discord permissions

The bot must be able to:
- View the voice channel
- Connect
- Speak

For text commands, it needs:
- View Channel
- Send Messages

## Important music note

Music websites can change their playback restrictions at any time. This project uses yt-dlp and FFmpeg instead of hard-coding a fragile website API. If a particular YouTube track is blocked by the source, the bot will report the playback error in Railway logs.

## Railway stability

The Dockerfile installs:
- Node.js 24
- FFmpeg
- Python
- edge-tts
- yt-dlp

This avoids depending on a system FFmpeg/yt-dlp installation already being present on Railway.

## Local test

Install Docker, then:

`docker build -t indian-discord-bot .`

Run with:

`docker run --rm -e DISCORD_TOKEN="YOUR_TOKEN" -e GUILD_ID="YOUR_SERVER_ID" indian-discord-bot`

Never commit your actual token.
