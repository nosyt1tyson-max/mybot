# 🇮🇳 Indian TTS + Professional Music Bot — Railway

## FIXED VERSION 2.0

This version specifically fixes the voice startup error:

`Cannot find module '@discordjs/opus'`

The project now includes `@discordjs/opus` and installs the required native build tools in Docker.

### Features

**TTS**
- `/tts text:hello language:auto`
- Hindi India voice: `hi-IN-SwaraNeural`
- English India voice: `en-IN-NeerjaNeural`
- Auto detects Devanagari Hindi
- Prefix: `!tts hello bhai`

**Music**
- `/play song`
- `/pause`
- `/resume`
- `/skip`
- `/stop`
- `/queue`
- `/volume`
- `/join`
- `/leave`
- Prefix equivalents

**Prefix**
- Default: `!`
- `/prefix prefix:.`
- Then: `.play arijit singh`
- Then: `.tts namaste bhai`
- Only members with Manage Server can change it.

## IMPORTANT: Discord Developer Portal

Because prefix commands read message text, you MUST enable:

**Developer Portal → Your Application → Bot → Privileged Gateway Intents → Message Content Intent → ON**

Also keep the bot permissions:
- View Channels
- Send Messages
- Connect
- Speak

Scopes when inviting:
- `bot`
- `applications.commands`

## GitHub

Upload these files to the ROOT of the repository:

```text
index.js
package.json
Dockerfile
railway.toml
.env.example
.gitignore
.dockerignore
README.md
```

Do NOT upload your real `.env` or Discord token.

## Railway Variables

Add:

```text
DISCORD_TOKEN=YOUR_REAL_BOT_TOKEN
GUILD_ID=YOUR_SERVER_ID
BOT_STATUS=🇮🇳 Hindi TTS • Music
DEFAULT_PREFIX=!
```

`GUILD_ID` is recommended for fast slash-command registration.

## Railway

Create Project → Deploy from GitHub Repo → choose repository.

Railway will use the included Dockerfile.

No PORT variable is required because this is a Discord gateway bot, not a web server.

## What the Docker image installs

- Node.js 24
- FFmpeg
- Python 3
- yt-dlp
- edge-tts
- build tools for `@discordjs/opus`

## Music source note

The bot uses yt-dlp + FFmpeg. A particular video can still be unavailable if the source blocks playback, changes its requirements, or the track is region/age restricted. The bot catches these errors instead of crashing.

## Prefix note

Prefix settings are stored in memory. They remain active while the Railway process is running, but a full restart/redeploy resets them to `DEFAULT_PREFIX`.

For permanent prefix settings across restarts, add a database later.
