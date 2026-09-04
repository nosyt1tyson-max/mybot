# 🇮🇳 Indian TTS + Professional Music Bot — Railway V3

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
- Every TTS message starts with the Discord server display name, e.g. `Tyson said: ...`
- Soft natural Indian female voice option
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


## V3 — Voice attribution + 24/7 VC

Set these Railway Variables if you want the bot to stay in a specific voice channel:

```text
TWENTY_FOUR_SEVEN=true
STAY_VC_CHANNEL_ID=YOUR_VOICE_CHANNEL_ID
```

The bot will reconnect after a voice disconnect when the process is still running.

### Voice attribution

If Tyson writes:

`hello bhai kya haal hai`

the bot speaks:

`Tyson said: hello bhai kya haal hai`

If Royal writes:

`namaste`

the bot speaks:

`Royal said: namaste`

It uses the member's server display name, so nicknames are respected.

### Soft female voice

Use `/tts` with `Soft Female India` for a natural, soft Indian female neural voice. Sexual/moaning effects are not part of the bot.

### Discord buttons

Discord buttons require interaction handlers; the V3 help panel is branded and the command responses use professional embeds. The core controls remain available as slash/prefix commands so they work reliably.

### Required Discord setting

Enable **Message Content Intent** for prefix commands.


## V4 voice + music polish
- TTS attribution is generated in one place, so it says `Name said:` only once.
- Common Roman-Hindi/Hinglish words are normalized to Devanagari before Hindi TTS.
- Hindi is selected automatically for common Hinglish sentences.
- The voice remains a soft, natural Indian female voice.
- Music controls are kept clean and branded; individual YouTube/source limitations can still affect a track.


## V7 Music + 24/7 fixes
- Music now pipes a fresh yt-dlp audio stream directly into FFmpeg instead of relying on a previously fetched GoogleVideo URL.
- Multiple YouTube player clients are tried automatically.
- Current yt-dlp EJS support is enabled in the Railway image.
- New `!247 on` / `!247 off` and `/247` controls.
- Set `STAY_VC_CHANNEL_ID` in Railway for automatic 24/7 voice.
- 24/7 can also be enabled per server with `!247 on` after the channel ID is configured.
