require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType
} = require("@discordjs/voice");

const { spawn, execFile } = require("node:child_process");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const TOKEN = process.env.DISCORD_TOKEN;
const DEFAULT_PREFIX = process.env.DEFAULT_PREFIX || "!";
const TWENTY_FOUR_SEVEN = String(process.env.TWENTY_FOUR_SEVEN || "false").toLowerCase() === "true";
const STAY_VC_CHANNEL_ID = process.env.STAY_VC_CHANNEL_ID || "";
const PREFIXES = new Map();

const TTS_VOICES = {
  hindi: "hi-IN-SwaraNeural",
  english: "en-IN-NeerjaNeural",
  // Soft female Indian voice; sexual/moaning effects are intentionally not used.
  soft: "en-IN-NeerjaNeural"
};

function displayName(member) {
  return member?.displayName || member?.user?.globalName || member?.user?.username || "Someone";
}

function attributedText(member, text) {
  const clean = String(text || '').replace(/^\s*[^:]{1,80}\s+said\s*:\s*/i, '').trim();
  return `${displayName(member)} said: ${clean}`;
}

if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing. Add it in Railway > Variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const slashCommands = [
  new SlashCommandBuilder().setName("help").setDescription("Show all bot commands."),
  new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel."),
  new SlashCommandBuilder().setName("leave").setDescription("Leave voice and clear the queue."),
  new SlashCommandBuilder()
    .setName("tts").setDescription("Speak Hindi/English in an Indian neural voice.")
    .addStringOption(o => o.setName("text").setDescription("Text to speak").setRequired(true).setMaxLength(1000))
    .addStringOption(o => o.setName("language").setDescription("Voice language").addChoices(
      { name: "Auto", value: "auto" },
      { name: "Hindi India", value: "hi" },
      { name: "English India", value: "en" },
      { name: "Soft Female India", value: "soft" }
    )),
  new SlashCommandBuilder()
    .setName("play").setDescription("Search and play music.")
    .addStringOption(o => o.setName("query").setDescription("Song name or URL").setRequired(true).setMaxLength(300)),
  new SlashCommandBuilder().setName("pause").setDescription("Pause music."),
  new SlashCommandBuilder().setName("resume").setDescription("Resume music."),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current song."),
  new SlashCommandBuilder().setName("stop").setDescription("Stop music and clear the queue."),
  new SlashCommandBuilder().setName("queue").setDescription("Show the music queue."),
  new SlashCommandBuilder()
    .setName("volume").setDescription("Set music volume.")
    .addIntegerOption(o => o.setName("percent").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName("prefix").setDescription("Set this server's prefix.")
    .addStringOption(o => o.setName("prefix").setDescription("1-3 characters, e.g. ! or .").setRequired(true).setMaxLength(3))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("247").setDescription("Keep the bot connected to a voice channel 24/7.")
    .addBooleanOption(o => o.setName("enabled").setDescription("Enable or disable 24/7 voice.").setRequired(true))
    .addChannelOption(o => o.setName("channel").setDescription("Voice channel to stay in (optional when enabling)."))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c => c.toJSON());

const states = new Map();

function getPrefix(guildId) {
  return PREFIXES.get(guildId) || DEFAULT_PREFIX;
}

function getState(guildId) {
  if (!states.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });

    const state = {
      player,
      ttsPlayer: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
      items: [],
      current: null,
      volume: 80,
      connection: null,
      voiceChannelId: null,
      ttsBusy: false,
      generation: 0,
      auto247: false,
      auto247ChannelId: null
    };

    states.set(guildId, state);

    player.on(AudioPlayerStatus.Idle, () => {
      const old = state.current;
      state.current = null;
      if (old?.file) fs.rmSync(old.file, { force: true });
      playNext(guildId).catch(e => console.error("playNext:", e));
    });

    player.on("error", err => {
      console.error("❌ Audio player error:", err);
      const old = state.current;
      state.current = null;
      if (old?.file) fs.rmSync(old.file, { force: true });
      playNext(guildId).catch(e => console.error("playNext:", e));
    });

    state.ttsPlayer.on(AudioPlayerStatus.Idle, () => {
      state.ttsBusy = false;
    });
    state.ttsPlayer.on("error", err => {
      console.error("❌ TTS audio player error:", err);
      state.ttsBusy = false;
    });
  }
  return states.get(guildId);
}

function embed(title, description) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setTimestamp()
    .setFooter({ text: "🇮🇳 Indian TTS • Music" });
}

function getVoiceChannel(member) {
  const channel = member?.voice?.channel;
  if (!channel) throw new Error("Join a voice channel first.");
  return channel;
}

function connect(interactionOrMember) {
  const member = interactionOrMember.member || interactionOrMember;
  const channel = getVoiceChannel(member);
  const guildId = interactionOrMember.guildId || member.guild.id;
  const state = getState(guildId);

  let connection = getVoiceConnection(guildId);
  if (connection && state.voiceChannelId && state.voiceChannelId !== channel.id) {
    try { connection.destroy(); } catch {}
    connection = null;
    state.connection = null;
  }

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: member.guild.voiceAdapterCreator,
      selfDeaf: false
    });
    state.voiceChannelId = channel.id;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Do not create a second connection. Reuse this guild's state only.
      try {
        await Promise.race([
          new Promise(resolve => connection.once(VoiceConnectionStatus.Ready, resolve)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("voice reconnect timeout")), 7000))
        ]);
      } catch {
        try { connection.destroy(); } catch {}
        if (state.connection === connection) state.connection = null;
        if (state.voiceChannelId === channel.id && TWENTY_FOUR_SEVEN) {
          setTimeout(() => ensure24x7Guild(guildId).catch(console.error), 3000);
        }
      }
    });
  }

  state.connection = connection;
  state.voiceChannelId = channel.id;
  connection.subscribe(state.player);
  connection.subscribe(state.ttsPlayer);
  return { channel, state, connection };
}
function exec(command, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 15 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout.trim());
    });
  });
}


// ---------------- MUSIC ENGINE ----------------
// Primary: direct JioSaavn native API via maintained client.
// Fallbacks: public JioSaavn API proxies.
// We never display NOW PLAYING until a real audio file has been downloaded.
let saavnClientPromise = null;

async function getSaavnClient() {
  if (!saavnClientPromise) {
    saavnClientPromise = import("jiosaavn-api-client").then(mod => {
      const Client = mod.JioSaavnClient || mod.default?.JioSaavnClient;
      if (!Client) throw new Error("JioSaavn client module did not expose JioSaavnClient.");
      return new Client({
        baseUrl: "https://www.jiosaavn.com/api.php",
        timeoutMs: 12000
      });
    });
  }
  return saavnClientPromise;
}

const MUSIC_APIS = [
  "https://jiosaavn-api-privatecvc2.vercel.app/result/",
  "https://saavnapi-nine.vercel.app/result/",
  "https://saavn.dev/api/search/songs"
];

async function fetchJson(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://www.jiosaavn.com/"
      }
    });
    if (!r.ok) throw new Error(`Music API HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function bitrateValue(x) {
  const n = Number(String(x?.bitrate ?? x?.quality ?? "").replace(/\D/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizeSong(s, sourceName = "JioSaavn") {
  if (!s) return null;
  const rawLinks = [
    ...(Array.isArray(s.downloadLinks) ? s.downloadLinks : []),
    ...(Array.isArray(s.downloadUrl) ? s.downloadUrl : []),
  ].filter(x => x?.url);

  const links = rawLinks
    .map(x => ({ url: x.url, bitrate: bitrateValue(x) }))
    .sort((a, b) => b.bitrate - a.bitrate);

  const artist =
    s.artists?.primary?.map(a => a.name).filter(Boolean).join(", ") ||
    s.primaryArtists ||
    s.artist ||
    s.subtitle ||
    "Unknown Artist";

  const images = Array.isArray(s.images) ? s.images : [];
  const legacyImage = Array.isArray(s.image) ? s.image.at(-1)?.url : (typeof s.image === "string" ? s.image : null);

  return {
    id: s.id || s.songId || s.e_songid || null,
    title: s.title || s.name || s.song || "Unknown",
    artist,
    duration: Number(s.durationSeconds || s.duration || 0),
    image: images.at(-1)?.url || s.image_url || legacyImage || null,
    audioUrls: links.map(x => x.url),
    audioUrl: links[0]?.url || s.media_url || s.url || null,
    webpageUrl: s.url || s.perma_url || null,
    source: sourceName
  };
}

async function searchSaavnNative(query) {
  const client = await getSaavnClient();
  const result = await client.searchSongs({ query, limit: 5, page: 0 });
  if (!result?.success) throw new Error(result?.message || "Native JioSaavn search failed.");
  const first = result.data?.results?.[0];
  if (!first?.id) throw new Error("Native JioSaavn search returned no song.");

  const full = await client.getSongsById({ ids: [first.id] });
  if (!full?.success) throw new Error(full?.message || "Could not fetch full song details.");
  const song = normalizeSong(full.data?.[0], "JioSaavn Native");
  if (!song?.audioUrl) throw new Error("Native JioSaavn returned no playable audio URL.");
  return song;
}

function pickProxySongs(data) {
  const raw =
    data?.data?.results ||
    data?.data?.data ||
    data?.results ||
    data?.data ||
    data?.songs ||
    [];
  return Array.isArray(raw) ? raw : [];
}

async function searchSaavnProxy(query) {
  const encoded = encodeURIComponent(query);
  let last;
  for (const base of MUSIC_APIS) {
    try {
      const separator = base.includes("?") ? "&" : "?";
      const key = base.includes("saavn.dev") ? "query" : "query";
      const data = await fetchJson(`${base}${separator}${key}=${encoded}`);
      const list = pickProxySongs(data);
      for (const raw of list.slice(0, 5)) {
        const song = normalizeSong(raw, "JioSaavn Fallback");
        if (song?.audioUrl) return song;
      }
      throw new Error("No playable result from this API.");
    } catch (e) {
      last = e;
      console.error(`⚠️ Music fallback failed (${base}): ${e.message}`);
    }
  }
  throw last || new Error("No playable music result found.");
}

async function searchSaavn(query) {
  let nativeError;
  try {
    return await searchSaavnNative(query);
  } catch (e) {
    nativeError = e;
    console.error(`⚠️ Native JioSaavn failed: ${e.message}`);
  }
  try {
    return await searchSaavnProxy(query);
  } catch (e) {
    throw new Error(`Music search failed. Native: ${nativeError?.message || "unknown"} | Fallback: ${e.message}`);
  }
}

async function downloadRemoteAudio(url, title) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Invalid audio URL.");
  const safe = String(title || "track").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 70) || "track";
  const file = path.join(os.tmpdir(), `discord-music-${crypto.randomUUID()}-${safe}.audio`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        "Accept": "audio/*,*/*;q=0.8",
        "Referer": "https://www.jiosaavn.com/"
      }
    });
    if (!r.ok || !r.body) throw new Error(`Audio CDN HTTP ${r.status}`);
    const fh = fs.createWriteStream(file);
    await new Promise((resolve, reject) => {
      fh.on("error", reject);
      fh.on("finish", resolve);
      Readable.fromWeb(r.body).on("error", reject).pipe(fh);
    });
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size < 10000) throw new Error(`Audio CDN returned only ${size} bytes.`);
    return file;
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadAudio(song) {
  const urls = [...new Set([...(song.audioUrls || []), song.audioUrl].filter(Boolean))];
  let last;
  for (const url of urls) {
    try {
      return await downloadRemoteAudio(url, song.title);
    } catch (e) {
      last = e;
      console.error(`⚠️ Audio URL failed: ${e.message}`);
    }
  }
  throw last || new Error("No downloadable audio URL.");
}

async function mediaInfo(query) {
  return searchSaavn(query);
}

function cleanText(text) {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function normalizeHinglish(text) {
  let s = String(text || '').trim();
  const map = [
    [/\b(kya|kia)\b/gi, 'क्या'], [/\b(kyu|kyun)\b/gi, 'क्यों'],
    [/\b(kaise|kese)\b/gi, 'कैसे'], [/\b(haan|han)\b/gi, 'हाँ'],
    [/\b(nahi|nai|nahin)\b/gi, 'नहीं'], [/\b(acha|accha)\b/gi, 'अच्छा'],
    [/\b(bhai|bro)\b/gi, 'भाई'], [/\b(yaar|yar)\b/gi, 'यार'],
    [/\b(abhi)\b/gi, 'अभी'], [/\b(aisa|aesa)\b/gi, 'ऐसा'],
    [/\b(aise|ese)\b/gi, 'ऐसे'], [/\b(mera|mere|meri)\b/gi, 'मेरा'],
    [/\b(tum|tu)\b/gi, 'तुम'], [/\b(aap|apka|aapka|apko|aapko)\b/gi, 'आप'],
    [/\b(hum|ham)\b/gi, 'हम'], [/\b(karo|kr)\b/gi, 'करो'],
    [/\b(karna)\b/gi, 'करना'], [/\b(raha)\b/gi, 'रहा'],
    [/\b(rahi)\b/gi, 'रही'], [/\b(rahe)\b/gi, 'रहे'],
    [/\b(hai|he)\b/gi, 'है'], [/\b(tha|thaa)\b/gi, 'था'],
    [/\b(thi|thee)\b/gi, 'थी'], [/\b(bohat|bahut)\b/gi, 'बहुत'],
    [/\b(mujhe)\b/gi, 'मुझे'], [/\b(tujhe)\b/gi, 'तुझे'],
    [/\b(yaha|yahan)\b/gi, 'यहाँ'], [/\b(waha|wahan)\b/gi, 'वहाँ'],
    [/\b(kuch)\b/gi, 'कुछ'], [/\b(sab)\b/gi, 'सब'], [/\b(aur)\b/gi, 'और'],
    [/\b(phir)\b/gi, 'फिर'], [/\b(bol)\b/gi, 'बोल'], [/\b(samajh)\b/gi, 'समझ']
  ];
  for (const [rx, rep] of map) s = s.replace(rx, rep);
  return s;
}

function voiceFor(language, text) {
  if (language === "hi") return TTS_VOICES.hindi;
  if (language === "en" || language === "soft") return TTS_VOICES.soft;
  return /[\u0900-\u097F]/.test(text) ? TTS_VOICES.hindi : TTS_VOICES.english;
}

async function ttsFile(text, language) {
  text = cleanText(text);
  if (!text) throw new Error("Text is empty.");
  const spokenText = /[\u0900-\u097F]/.test(text) ? text : normalizeHinglish(text);
  const voice = voiceFor(language, spokenText);
  const file = path.join(os.tmpdir(), `tts-${crypto.randomUUID()}.mp3`);

  await exec("edge-tts", [
    "--voice", voice,
    "--text", spokenText,
    "--write-media", file
  ], 70000);

  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
    throw new Error("TTS audio was not created.");
  }
  return { file, voice };
}

function playFile(guildId, file) {
  const state = getState(guildId);
  const resource = createAudioResource(file, { inlineVolume: true });
  resource.volume.setVolume(1);
  state.ttsBusy = true;
  state.ttsPlayer.play(resource);
}

function musicButtons(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`music:pause:${guildId}`).setLabel("Pause").setEmoji("⏸️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:resume:${guildId}`).setLabel("Resume").setEmoji("▶️").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`music:skip:${guildId}`).setLabel("Skip").setEmoji("⏭️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`music:stop:${guildId}`).setLabel("Stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`music:queue:${guildId}`).setLabel("Queue").setEmoji("📜").setStyle(ButtonStyle.Secondary)
  );
}
async function commandHelp(target) {
  const p = getPrefix(target.guildId);
  const e = embed("🇮🇳 INDIAN VOICE • MUSIC", 
`**Professional Voice & Music System**

🎙️ **Voice attribution:** every TTS message starts with the sender's server name — e.g. **“Tyson said: …”**
🎧 **Soft female option:** natural Indian female neural voice.

**Slash Commands**
\`/tts\` — Hindi/English Indian voice
\`/play\` — Play/search music
\`/pause\` • \`/resume\` • \`/skip\`
\`/stop\` • \`/queue\` • \`/volume\`
\`/join\` • \`/leave\`
\`/prefix\` — Change server prefix

**Prefix Commands**
\`${p}t <text>\`
\`${p}play <song>\`
\`${p}pause\` • \`${p}resume\` • \`${p}skip\`
\`${p}stop\` • \`${p}queue\`
\`${p}join\` • \`${p}leave\`
\`${p}help\`
\`${p}247 on/off\` — 24/7 voice (Manage Server)

**Music:** JioSaavn search + direct audio CDN
**Indian voices:** Hindi India + English India`);
  return e;
}

async function handleAction(name, guildId, member, args, reply) {
  const state = getState(guildId);

  if (name === "help") return reply({ embeds: [await commandHelp({ guildId })] });

  if (name === "join") {
    const { channel } = connect({ member, guildId });
    return reply({ embeds: [embed("🔊 Voice Connected", `Joined **${channel.name}**.`)] });
  }

  if (name === "leave") {
    state.items = [];
    const oldCurrent = state.current;
    state.current = null;
    state.generation++;
    state.player.stop(true);
    if (oldCurrent?.file) fs.rmSync(oldCurrent.file, { force: true });
    const c = getVoiceConnection(guildId);
    if (c) c.destroy();
    state.connection = null;
    return reply({ embeds: [embed("👋 Disconnected", "Left voice and cleared the queue.")] });
  }

  if (name === "tts") {
    const text = args.text;
    const language = args.language || "auto";
    const { channel, state: st } = connect({ member, guildId });
    const spoken = attributedText(member, text);
    const { file, voice } = await ttsFile(spoken, language);
    try {
      playFile(guildId, file);
      return reply({ embeds: [embed("🗣️ TTS Playing", `**Voice:** \`${voice}\`\n**Channel:** ${channel.name}\n**Text:** ${text.slice(0, 800)}`)] });
    } finally {
      setTimeout(() => fs.rmSync(file, { force: true }), 120000);
    }
  }

  if (name === "play") {
    const query = args.query;
    connect({ member, guildId });
    const info = await mediaInfo(query);
    if (!info.audioUrl) throw new Error("Could not find a playable audio stream.");

    state.items.push({
      title: info.title || "Unknown",
      audioUrl: info.audioUrl,
      audioUrls: info.audioUrls || [info.audioUrl],
      webpageUrl: info.webpageUrl,
      artist: info.artist,
      duration: info.duration || 0,
      image: info.image,
      source: info.source
    });

    const position = state.items.length + (state.current ? 1 : 0);
    const msg = await reply({ embeds: [embed("⏳ PREPARING • MUSIC", `**${info.title || "Unknown"}**\n\nDownloading the audio from the music source…\nI will only show **Now Playing** after the audio file is actually ready.`)], components: [musicButtons(guildId)] });
    playNext(guildId, msg, info.title || "Unknown").catch(err => console.error("playNext:", err));
    return msg;
  }

  if (name === "pause") {
    const ok = state.player.pause();
    return reply({ embeds: [embed("⏸️ Paused", ok ? "Music paused." : "Nothing is playing.")] });
  }

  if (name === "resume") {
    const ok = state.player.unpause();
    return reply({ embeds: [embed("▶️ Resumed", ok ? "Music resumed." : "Nothing is paused.")] });
  }

  if (name === "skip") {
    const ok = state.player.stop();
    return reply({ embeds: [embed("⏭️ Skipped", ok ? "Skipped current track." : "Nothing is playing.")] });
  }

  if (name === "stop") {
    state.items = [];
    const oldCurrent = state.current;
    state.current = null;
    state.generation++;
    state.player.stop(true);
    if (oldCurrent?.file) fs.rmSync(oldCurrent.file, { force: true });
    return reply({ embeds: [embed("⏹️ Stopped", "Music stopped and queue cleared.")] });
  }

  if (name === "queue") {
    const lines = [];
    if (state.current) lines.push(`▶️ **Now:** ${state.current.title}`);
    state.items.slice(0, 10).forEach((x, i) => lines.push(`${i + 1}. ${x.title}`));
    return reply({ embeds: [embed("📜 Music Queue", lines.length ? lines.join("\n") : "Queue is empty.")] });
  }

  if (name === "volume") {
    const n = Number(args.percent);
    state.volume = n;
    return reply({ embeds: [embed("🔊 Volume", `Volume set to **${n}%**.`)] });
  }

  if (name === "247") {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new Error("You need **Manage Server** permission to change 24/7 mode.");
    }
    const enabled = Boolean(args.enabled);
    const requested = args.channelId || STAY_VC_CHANNEL_ID || null;
    if (!enabled) {
      state.auto247 = false;
      state.auto247ChannelId = null;
      return reply({ embeds: [embed("🛑 24/7 Voice Disabled", "The bot will no longer auto-reconnect to a voice channel.")] });
    }
    const channelId = requested;
    if (!channelId) throw new Error("Select a voice channel, or set STAY_VC_CHANNEL_ID in Railway Variables.");
    const channel = messageChannel(guildId, channelId);
    if (!channel || !channel.isVoiceBased()) throw new Error("That channel is not a voice channel.");
    state.auto247 = true;
    state.auto247ChannelId = channel.id;
    await ensure24x7Guild(guildId, channel.id);
    return reply({ embeds: [embed("✅ 24/7 Voice Enabled", `I will stay connected to **${channel.name}** and reconnect if disconnected.`)] });
  }

  if (name === "prefix") {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new Error("You need **Manage Server** permission to change the prefix.");
    }
    const p = args.prefix;
    if (!p || p.length > 3 || /\s/.test(p)) throw new Error("Prefix must be 1-3 characters with no spaces.");
    PREFIXES.set(guildId, p);
    return reply({ embeds: [embed("⚙️ Prefix Updated", `New prefix: **${p}**\nExample: \`${p}play song\``)] });
  }

  throw new Error("Unknown command. Use `/help`.");
}


function messageChannel(guildId, channelId) {
  const guild = client.guilds.cache.get(guildId);
  return guild?.channels?.cache?.get(channelId) || null;
}


async function ensure24x7Guild(guildId, overrideChannelId = null) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const state = getState(guildId);
  const channelId = overrideChannelId || state.auto247ChannelId || (TWENTY_FOUR_SEVEN ? STAY_VC_CHANNEL_ID : "");
  if (!channelId || (!state.auto247 && !TWENTY_FOUR_SEVEN)) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) {
    console.error(`❌ 24/7 channel not found or not voice: ${channelId}`);
    return;
  }

  const existing = getVoiceConnection(guildId);
  if (existing && state.voiceChannelId === channel.id) {
    state.connection = existing;
    existing.subscribe(state.player);
    existing.subscribe(state.ttsPlayer);
    return;
  }
  if (existing) { try { existing.destroy(); } catch {} }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false
  });
  state.connection = connection;
  state.voiceChannelId = channel.id;
  state.auto247ChannelId = channel.id;
  connection.subscribe(state.player);
  connection.subscribe(state.ttsPlayer);
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        new Promise(resolve => connection.once(VoiceConnectionStatus.Ready, resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("voice reconnect timeout")), 7000))
      ]);
    } catch {
      try { connection.destroy(); } catch {}
      setTimeout(() => ensure24x7Guild(guildId, channel.id).catch(console.error), 3000);
    }
  });
  console.log(`✅ 24/7 VC connected: ${guild.name} / ${channel.name}`);
}

async function start24x7Voice() {
  for (const guild of client.guilds.cache.values()) {
    const state = getState(guild.id);
    if (TWENTY_FOUR_SEVEN && STAY_VC_CHANNEL_ID) {
      state.auto247 = true;
      state.auto247ChannelId = STAY_VC_CHANNEL_ID;
    }
    await ensure24x7Guild(guild.id);
  }
}
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: process.env.BOT_STATUS || "🇮🇳 Hindi TTS • Music", type: ActivityType.Listening }],
    status: "online"
  });

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID)
      : Routes.applicationCommands(client.user.id);

    await rest.put(route, { body: slashCommands });
    console.log(process.env.GUILD_ID
      ? `✅ Slash commands registered in ${process.env.GUILD_ID}`
      : "✅ Global slash commands registered");
  } catch (e) {
    console.error("❌ Slash command registration failed:", e);
  }

  await start24x7Voice();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.guildId) return;

  if (interaction.isButton()) {
    const [kind, action, guildId] = interaction.customId.split(":");
    if (kind !== "music" || guildId !== interaction.guildId) return;
    try {
      const state = getState(guildId);
      if (action === "pause") state.player.pause();
      else if (action === "resume") state.player.unpause();
      else if (action === "skip") state.player.stop();
      else if (action === "stop") { if (state.current?.file) fs.rmSync(state.current.file, { force: true }); state.items = []; state.current = null; state.generation++; state.player.stop(true); }
      else if (action === "queue") {
        const lines = [];
        if (state.current) lines.push(`▶️ **Now:** ${state.current.title}`);
        state.items.slice(0, 10).forEach((x, i) => lines.push(`${i + 1}. ${x.title}`));
        return interaction.reply({ embeds: [embed("📜 Music Queue", lines.length ? lines.join("\n") : "Queue is empty.")], ephemeral: true });
      }
      return interaction.reply({ content: `✅ ${action === "pause" ? "Music paused." : action === "resume" ? "Music resumed." : action === "skip" ? "Skipped." : "Music stopped."}`, ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `❌ ${e.message || "Action failed."}`, ephemeral: true }).catch(() => {});
    }
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply();
    const args = {};

    if (interaction.commandName === "tts") {
      args.text = interaction.options.getString("text", true);
      args.language = interaction.options.getString("language") || "auto";
    } else if (interaction.commandName === "play") {
      args.query = interaction.options.getString("query", true);
    } else if (interaction.commandName === "volume") {
      args.percent = interaction.options.getInteger("percent", true);
    } else if (interaction.commandName === "prefix") {
      args.prefix = interaction.options.getString("prefix", true);
    } else if (interaction.commandName === "247") {
      args.enabled = interaction.options.getBoolean("enabled", true);
      const channel = interaction.options.getChannel("channel");
      args.channelId = channel?.id || null;
    }

    await handleAction(interaction.commandName, interaction.guildId, interaction.member, args, payload =>
      interaction.editReply(payload)
    );
  } catch (e) {
    console.error(e);
    const msg = `❌ ${e.message || "Something went wrong."}`;
    if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  const prefix = getPrefix(message.guild.id);
  if (!message.content.startsWith(prefix)) return;

  const body = message.content.slice(prefix.length).trim();
  if (!body) return;

  const parts = body.split(/\s+/);
  const cmd = parts.shift().toLowerCase();
  const rest = parts.join(" ");

  try {
    if (cmd === "help") return message.reply({ embeds: [await commandHelp(message)] });

    if (cmd === "t" || cmd === "tts") {
      if (!rest) throw new Error(`Usage: \`${prefix}tts hello bhai kya haal hai\``);
      return handleAction("tts", message.guild.id, message.member, {
        text: rest, language: "auto"
      }, p => message.reply(p));
    }

    if (cmd === "play") {
      if (!rest) throw new Error(`Usage: \`${prefix}play song name\``);
      return handleAction("play", message.guild.id, message.member, {
        query: rest
      }, p => message.reply(p));
    }

    if (["join", "leave", "pause", "resume", "skip", "stop", "queue"].includes(cmd)) {
      return handleAction(cmd, message.guild.id, message.member, {}, p => message.reply(p));
    }

    if (cmd === "volume") {
      const n = Number(parts[0]);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`Usage: \`${prefix}volume 80\``);
      return handleAction("volume", message.guild.id, message.member, { percent: n }, p => message.reply(p));
    }

    if (cmd === "247") {
      const mode = (parts[0] || "").toLowerCase();
      if (!mode || !["on", "off"].includes(mode)) throw new Error(`Usage: \`${prefix}247 on [voice-channel-id]\` or \`${prefix}247 off\``);
      return handleAction("247", message.guild.id, message.member, {
        enabled: mode === "on",
        channelId: parts[1] || null
      }, p => message.reply(p));
    }

    if (cmd === "prefix") {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error("You need Manage Server permission.");
      }
      const p = parts[0];
      return handleAction("prefix", message.guild.id, message.member, { prefix: p }, p2 => message.reply(p2));
    }
  } catch (e) {
    console.error("Prefix command:", e);
    await message.reply(`❌ ${e.message || "Something went wrong."}`).catch(() => {});
  }
});

process.on("unhandledRejection", e => console.error("UNHANDLED:", e));
process.on("uncaughtException", e => console.error("UNCAUGHT:", e));

client.login(TOKEN);
