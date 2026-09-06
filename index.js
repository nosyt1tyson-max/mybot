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

const YT_CLIENTS = ["mweb", "tv", "android_vr", "web_embedded"];
const POT_URL = process.env.YTDLP_POT_URL || "http://127.0.0.1:4416";

async function ytExec(args, timeout = 120000) {
  const common = [
    "--no-playlist",
    "--no-warnings",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
    "--extractor-args", `youtubepot-bgutilhttp:base_url=${POT_URL}`
  ];
  let lastError;
  for (const client of YT_CLIENTS) {
    try {
      return await exec("yt-dlp", [
        ...common,
        "--extractor-args", `youtube:player_client=${client}`,
        ...args
      ], timeout);
    } catch (e) {
      lastError = e;
      console.error(`⚠️ yt-dlp ${client} failed: ${(e.stderr || e.message || "").toString().slice(-1200)}`);
    }
  }
  throw lastError || new Error("YouTube extraction failed.");
}

async function mediaInfo(query) {
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  const out = await ytExec(["--dump-single-json", "--skip-download", target]);
  const data = JSON.parse(out);
  return data.entries?.[0] || data;
}

async function downloadAudio(webpageUrl, title) {
  const safe = String(title || "track").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 70) || "track";
  const base = path.join(os.tmpdir(), `discord-music-${crypto.randomUUID()}-${safe}`);
  const output = `${base}.%(ext)s`;
  const out = await ytExec([
    "--format", "bestaudio/best",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--output", output,
    webpageUrl
  ], 240000);

  const candidates = [
    `${base}.mp3`,
    ...fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(path.basename(base) + "."))
      .map(f => path.join(os.tmpdir(), f))
  ];
  const file = candidates.find(f => fs.existsSync(f) && fs.statSync(f).size > 10000);
  if (!file) throw new Error(`Audio file was not created. ${out.slice(-500)}`);
  return file;
}

async function playNext(guildId) {
  const state = getState(guildId);
  if (state.current || !state.items.length) return;

  const item = state.items.shift();
  state.current = item;
  const generation = state.generation;

  try {
    console.log(`🎵 Preparing: ${item.title}`);
    const file = await downloadAudio(item.webpage_url, item.title);
    if (generation !== state.generation) {
      fs.rmSync(file, { force: true });
      state.current = null;
      return;
    }

    item.file = file;
    const resource = createAudioResource(file, { inlineVolume: true });
    resource.volume.setVolume(state.volume / 100);
    state.player.play(resource);
    console.log(`▶️ Music playing: ${item.title}`);
  } catch (e) {
    console.error("❌ Music stream failed:", e.message);
    state.current = null;
    setTimeout(() => playNext(guildId), 500);
  }
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
    state.current = null;
    state.generation++;
    state.player.stop(true);
    if (state.current?.file) fs.rmSync(state.current.file, { force: true });
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
    const url = info.webpage_url || info.original_url;
    if (!url) throw new Error("Could not find that song.");

    state.items.push({
      title: info.title || "Unknown",
      webpage_url: url,
      duration: info.duration || 0
    });

    const position = state.items.length + (state.current ? 1 : 0);
    playNext(guildId).catch(console.error);

    return reply({ embeds: [embed("🎵 NOW PLAYING • MUSIC", `**${info.title || "Unknown"}**\nQueue position: **${position}**\n\nUse the controls below for quick playback.`)], components: [musicButtons(guildId)] });
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
    state.current = null;
    state.generation++;
    state.player.stop(true);
    if (state.current?.file) fs.rmSync(state.current.file, { force: true });
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
