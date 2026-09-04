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
  ActivityType
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
  return `${displayName(member)} said: ${text}`;
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
      items: [],
      current: null,
      volume: 80,
      connection: null,
      generation: 0
    };

    states.set(guildId, state);

    player.on(AudioPlayerStatus.Idle, () => {
      state.current = null;
      playNext(guildId).catch(e => console.error("playNext:", e));
    });

    player.on("error", err => {
      console.error("❌ Audio player error:", err);
      state.current = null;
      playNext(guildId).catch(e => console.error("playNext:", e));
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
  const state = getState(interactionOrMember.guildId || member.guild.id);

  let connection = getVoiceConnection(member.guild.id);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: member.guild.id,
      adapterCreator: member.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          new Promise(resolve => connection.once(VoiceConnectionStatus.Ready, resolve)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("voice reconnect timeout")), 7000))
        ]);
      } catch {
        try { connection.destroy(); } catch {}
        state.connection = null;
      }
    });
  }

  state.connection = connection;
  connection.subscribe(state.player);
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

async function mediaInfo(query) {
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  const out = await exec("yt-dlp", [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android",
    target
  ], 100000);

  const data = JSON.parse(out);
  return data.entries?.[0] || data;
}

async function audioUrl(webpageUrl) {
  const out = await exec("yt-dlp", [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android",
    webpageUrl
  ], 100000);

  const data = JSON.parse(out);
  const formats = (data.formats || [])
    .filter(f => f.url && f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"))
    .sort((a, b) => (b.abr || 0) - (a.abr || 0));

  if (formats[0]?.url) return formats[0].url;
  if (data.url) return data.url;
  throw new Error("No playable audio stream found.");
}

function ffmpegAudio(url) {
  return spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", url,
    "-vn",
    "-ac", "2",
    "-ar", "48000",
    "-f", "s16le",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

async function playNext(guildId) {
  const state = getState(guildId);
  if (state.current || !state.items.length) return;

  const item = state.items.shift();
  state.current = item;
  const generation = state.generation;

  try {
    const url = await audioUrl(item.webpage_url);
    if (generation !== state.generation) return;

    const ff = ffmpegAudio(url);
    ff.stderr.on("data", d => {
      const s = d.toString().trim();
      if (s) console.error("ffmpeg:", s);
    });

    const resource = createAudioResource(ff.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });
    resource.volume.setVolume(state.volume / 100);
    state.player.play(resource);
  } catch (e) {
    console.error("❌ Music stream failed:", e.message);
    state.current = null;
    setTimeout(() => playNext(guildId), 200);
  }
}

function cleanText(text) {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function voiceFor(language, text) {
  if (language === "hi") return TTS_VOICES.hindi;
  if (language === "en" || language === "soft") return TTS_VOICES.soft;
  return /[\u0900-\u097F]/.test(text) ? TTS_VOICES.hindi : TTS_VOICES.english;
}

async function ttsFile(text, language) {
  text = cleanText(text);
  if (!text) throw new Error("Text is empty.");
  const voice = voiceFor(language, text);
  const file = path.join(os.tmpdir(), `tts-${crypto.randomUUID()}.mp3`);

  await exec("edge-tts", [
    "--voice", voice,
    "--text", text,
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
  state.player.play(resource);
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
\`${p}tts <text>\`
\`${p}play <song>\`
\`${p}pause\` • \`${p}resume\` • \`${p}skip\`
\`${p}stop\` • \`${p}queue\`
\`${p}join\` • \`${p}leave\`
\`${p}help\`

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

    return reply({ embeds: [embed("🎵 Added to Queue", `**${info.title || "Unknown"}**\nPosition: **${position}**`)] });
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


async function start24x7Voice() {
  if (!TWENTY_FOUR_SEVEN || !STAY_VC_CHANNEL_ID) return;
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.get(STAY_VC_CHANNEL_ID);
    if (!channel || !channel.isVoiceBased()) continue;
    try {
      const state = getState(guild.id);
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
      });
      state.connection = connection;
      connection.subscribe(state.player);
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        setTimeout(() => start24x7Voice().catch(console.error), 3000);
      });
      console.log(`✅ 24/7 VC connected: ${guild.name} / ${channel.name}`);
    } catch (e) {
      console.error("24/7 VC connection failed:", e.message);
    }
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
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

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

    if (cmd === "tts") {
      if (!rest) throw new Error(`Usage: \`${prefix}tts hello bhai kya haal hai\``);
      return handleAction("tts", message.guild.id, message.member, {
        text: attributedText(message.member, rest), language: "auto"
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
