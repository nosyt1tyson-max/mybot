require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
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
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN. Add it in Railway > Service > Variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your current voice channel."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel and clear the queue."),
  new SlashCommandBuilder()
    .setName("tts")
    .setDescription("Speak Hindi/English using an Indian neural voice.")
    .addStringOption(o =>
      o.setName("text")
        .setDescription("Text to speak")
        .setRequired(true)
        .setMaxLength(1000)
    )
    .addStringOption(o =>
      o.setName("language")
        .setDescription("Voice language")
        .setRequired(false)
        .addChoices(
          { name: "Auto / Indian English", value: "auto" },
          { name: "Hindi (India)", value: "hi" },
          { name: "English (India)", value: "en" }
        )
    ),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song or search YouTube.")
    .addStringOption(o =>
      o.setName("query")
        .setDescription("Song name, YouTube URL, or search text")
        .setRequired(true)
        .setMaxLength(200)
    ),
  new SlashCommandBuilder().setName("pause").setDescription("Pause music."),
  new SlashCommandBuilder().setName("resume").setDescription("Resume music."),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current song."),
  new SlashCommandBuilder().setName("stop").setDescription("Stop music and clear the queue."),
  new SlashCommandBuilder().setName("queue").setDescription("Show the music queue."),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set music volume.")
    .addIntegerOption(o =>
      o.setName("percent").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)
    )
].map(c => c.toJSON());

const queues = new Map();

function getState(guildId) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    const state = {
      player,
      items: [],
      current: null,
      volume: 80,
      connection: null,
      processing: false
    };
    queues.set(guildId, state);

    player.on(AudioPlayerStatus.Idle, () => {
      state.current = null;
      playNext(guildId).catch(err => console.error("playNext:", err));
    });

    player.on("error", err => {
      console.error("Audio player error:", err);
      state.current = null;
      playNext(guildId).catch(e => console.error("playNext:", e));
    });
  }
  return queues.get(guildId);
}

function cleanText(s) {
  return s.replace(/[^\p{L}\p{N}\p{P}\p{Z}\n]/gu, "").trim();
}

function voiceChannelOf(interaction) {
  const ch = interaction.member?.voice?.channel;
  if (!ch) throw new Error("You must join a voice channel first.");
  return ch;
}

function connect(interaction) {
  const channel = voiceChannelOf(interaction);
  const state = getState(interaction.guildId);

  const existing = getVoiceConnection(interaction.guildId);
  if (existing) {
    state.connection = existing;
    try { existing.subscribe(state.player); } catch {}
    return { channel, state, connection: existing };
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false
  });

  state.connection = connection;
  connection.subscribe(state.player);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        new Promise(resolve => connection.once(VoiceConnectionStatus.Ready, resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Voice reconnect timeout")), 5000))
      ]);
    } catch {
      try { connection.destroy(); } catch {}
      state.connection = null;
    }
  });

  return { channel, state, connection };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout || 120000, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function getMediaInfo(query) {
  const isUrl = /^https?:\/\//i.test(query);
  const target = isUrl ? query : `ytsearch1:${query}`;

  const json = await runCommand("yt-dlp", [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android",
    target
  ], { timeout: 90000 });

  const info = JSON.parse(json);
  if (info.entries?.length) return info.entries[0];

  return info;
}

async function getAudioUrl(webpageUrl) {
  const json = await runCommand("yt-dlp", [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android",
    webpageUrl
  ], { timeout: 90000 });

  const info = JSON.parse(json);
  const formats = (info.formats || [])
    .filter(f => f.url && (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
    .sort((a, b) => ((b.abr || 0) - (a.abr || 0)));

  if (formats[0]?.url) return formats[0].url;
  if (info.url) return info.url;

  throw new Error("No playable audio stream was found.");
}

function makeFfmpegStream(url) {
  // FFmpeg handles the remote audio stream and outputs raw PCM to Node.
  return spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
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
  if (state.current || state.items.length === 0) return;

  const item = state.items.shift();
  state.current = item;

  try {
    const audioUrl = await getAudioUrl(item.webpage_url);
    const ffmpeg = makeFfmpegStream(audioUrl);

    ffmpeg.stderr.on("data", d => {
      const msg = d.toString().trim();
      if (msg) console.error("ffmpeg:", msg);
    });

    ffmpeg.on("close", code => {
      if (code !== 0) console.error(`ffmpeg exited with code ${code}`);
    });

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });
    resource.volume.setVolume(Math.max(0.01, state.volume / 100));

    state.player.play(resource);
  } catch (err) {
    console.error("Song failed:", err);
    state.current = null;
    setTimeout(() => playNext(guildId), 100);
  }
}

function detectVoice(language, text) {
  if (language === "hi") return "hi-IN-SwaraNeural";
  if (language === "en") return "en-IN-NeerjaNeural";

  // Simple script-based auto selection.
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  return hasDevanagari ? "hi-IN-SwaraNeural" : "en-IN-NeerjaNeural";
}

async function makeTtsFile(text, language) {
  const safe = cleanText(text);
  if (!safe) throw new Error("Please provide some text.");

  const voice = detectVoice(language, safe);
  const file = path.join(os.tmpdir(), `tts-${crypto.randomUUID()}.mp3`);

  await runCommand("edge-tts", [
    "--voice", voice,
    "--text", safe,
    "--write-media", file
  ], { timeout: 60000 });

  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
    throw new Error("TTS did not produce an audio file.");
  }

  return { file, voice };
}

async function playLocalFile(guildId, file, state) {
  const resource = createAudioResource(file, {
    inlineVolume: true
  });
  resource.volume.setVolume(1);
  state.player.play(resource);

  return new Promise(resolve => {
    const onIdle = () => {
      state.player.off(AudioPlayerStatus.Idle, onIdle);
      resolve();
    };
    state.player.on(AudioPlayerStatus.Idle, onIdle);
  });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: process.env.BOT_STATUS || "Hindi TTS + Music", type: ActivityType.Listening }],
    status: "online"
  });

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`Slash commands registered in guild ${process.env.GUILD_ID}.`);
    } else {
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
      );
      console.log("Global slash commands registered.");
    }
  } catch (err) {
    console.error("Command registration failed:", err);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const state = getState(interaction.guildId);

    if (interaction.commandName === "join") {
      const { channel } = connect(interaction);
      await interaction.reply(`🔊 Joined **${channel.name}**.`);
      return;
    }

    if (interaction.commandName === "leave") {
      state.items = [];
      state.current = null;
      state.player.stop(true);
      const connection = getVoiceConnection(interaction.guildId);
      if (connection) connection.destroy();
      state.connection = null;
      await interaction.reply("👋 Left the voice channel and cleared the queue.");
      return;
    }

    if (interaction.commandName === "tts") {
      const text = interaction.options.getString("text", true);
      const language = interaction.options.getString("language") || "auto";

      await interaction.deferReply();
      const { state: st } = connect(interaction);

      const { file, voice } = await makeTtsFile(text, language);
      try {
        await playLocalFile(interaction.guildId, file, st);
      } finally {
        fs.rmSync(file, { force: true });
      }

      await interaction.editReply(`🗣️ Spoke using **${voice}**.`);
      return;
    }

    if (interaction.commandName === "play") {
      const query = interaction.options.getString("query", true);
      await interaction.deferReply();

      connect(interaction);
      const info = await getMediaInfo(query);
      const url = info.webpage_url || info.original_url;
      if (!url) throw new Error("Could not resolve that song.");

      state.items.push({
        title: info.title || "Unknown title",
        webpage_url: url,
        duration: info.duration || 0
      });

      const position = state.items.length + (state.current ? 1 : 0);
      await interaction.editReply(`🎵 Added **${info.title || "Unknown"}** to the queue. Position: **${position}**`);
      playNext(interaction.guildId).catch(console.error);
      return;
    }

    if (interaction.commandName === "pause") {
      const ok = state.player.pause();
      await interaction.reply(ok ? "⏸️ Music paused." : "Nothing is currently playing.");
      return;
    }

    if (interaction.commandName === "resume") {
      const ok = state.player.unpause();
      await interaction.reply(ok ? "▶️ Music resumed." : "Nothing is paused.");
      return;
    }

    if (interaction.commandName === "skip") {
      const ok = state.player.stop();
      await interaction.reply(ok ? "⏭️ Skipped." : "Nothing is currently playing.");
      return;
    }

    if (interaction.commandName === "stop") {
      state.items = [];
      state.current = null;
      state.player.stop(true);
      await interaction.reply("⏹️ Stopped music and cleared the queue.");
      return;
    }

    if (interaction.commandName === "queue") {
      const lines = [];
      if (state.current) lines.push(`▶️ **Now:** ${state.current.title}`);
      state.items.slice(0, 10).forEach((x, i) => lines.push(`${i + 1}. ${x.title}`));

      await interaction.reply(lines.length ? lines.join("\n") : "📭 Queue is empty.");
      return;
    }

    if (interaction.commandName === "volume") {
      const percent = interaction.options.getInteger("percent", true);
      state.volume = percent;
      await interaction.reply(`🔊 Volume set to **${percent}%**. It will apply to the next/current resource.`);
      return;
    }
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Something went wrong.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`❌ ${msg.slice(0, 1900)}`).catch(() => {});
    } else {
      await interaction.reply({ content: `❌ ${msg.slice(0, 1900)}`, ephemeral: true }).catch(() => {});
    }
  }
});

process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("Uncaught exception:", err));

client.login(TOKEN);
