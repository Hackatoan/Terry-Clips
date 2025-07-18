const prism = require('prism-media');
const fs = require('node:fs');
const { Client, GatewayIntentBits, Collection, ChannelType } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    EndBehaviorType,
    VoiceReceiver,
} = require('@discordjs/voice');
const wav = require('wav');
require('dotenv').config();

// --- Configuration ---
const MAX_CLIP_DURATION = 120;
const DEFAULT_CLIP_DURATION = 30;
const RECORDING_BUFFER_SECONDS = 30;
const AUDIO_PACKETS_PER_SECOND = 50; // 20ms packets
const AUDIO_SAMPLE_RATE = 48000;

// --- Bot Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
    ],
});

// --- Data Storage ---
const voiceConnections = new Map();
const audioBuffers = new Map(); // guild.id -> array of audio chunks
const recordingSessions = new Map(); // guild.id -> session object
const lastClips = new Map(); // user.id -> file_path

// --- Bot Events ---
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}! 🚀`);
    await autoJoinVC();
});

// Re-join if kicked, or on startup
client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.member.user.id === client.user.id && oldState.channel && !newState.channel) {
        console.log(`Kicked from ${oldState.channel.name}, attempting to rejoin...`);
        // Clean up old connection data before rejoining
        if (voiceConnections.has(oldState.guild.id)) voiceConnections.delete(oldState.guild.id);
        if (audioBuffers.has(oldState.guild.id)) audioBuffers.delete(oldState.guild.id);
        autoJoinVC(oldState.guild);
    }
});


async function autoJoinVC(specificGuild = null) {
    const guildsToJoin = specificGuild ? [specificGuild] : Array.from(client.guilds.cache.values());

    for (const guild of guildsToJoin) {
        if (voiceConnections.has(guild.id)) continue;

        let targetChannel = null;
        let maxMembers = 0;

        const channels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice);

        for (const channel of channels.values()) {
            if (channel.members.some(member => member.user.bot)) continue;
            if (channel.members.size > maxMembers) {
                maxMembers = channel.members.size;
                targetChannel = channel;
            }
        }

        if (targetChannel) {
            try {
                const connection = joinVoiceChannel({
                    channelId: targetChannel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                    selfDeaf: false, // Must be false to receive audio
                });

                voiceConnections.set(guild.id, connection);
                startListening(connection, guild.id);
                console.log(`Joined '${targetChannel.name}' in '${guild.name}' and started listening.`);
            } catch (error) {
                console.error(`Error joining ${targetChannel.name}:`, error);
            }
        }
    }
}

// Replace your old startListening function with this one
function startListening(connection, guildId) {
    const bufferSize = MAX_CLIP_DURATION * AUDIO_PACKETS_PER_SECOND;
    const audioBuffer = [];
    audioBuffers.set(guildId, audioBuffer);

    // Create a single, shared decoder
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000, fec: true });

    // When anyone starts speaking, pipe their audio into the shared decoder
    connection.receiver.speaking.on('start', (userId) => {
        const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 }, // Changed to 1 second
});

        // Pipe the user's audio into the decoder, but don't let it close the decoder
        opusStream.pipe(decoder, { end: false });
    });

    // When the shared decoder produces a PCM chunk, add it to our buffer
    decoder.on('data', (chunk) => {
        audioBuffer.push(chunk);
        if (audioBuffer.length > bufferSize) {
            audioBuffer.shift();
        }
    });

    // Handle potential errors on the decoder
    decoder.on('error', (err) => {
        console.error('Decoder Error:', err);
    });
}


client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) {
        return interaction.reply({ content: 'These commands only work in a server.', ephemeral: true });
    }

    const { commandName } = interaction;
    const guildId = interaction.guildId;

    if (commandName === 'clip') {
        if (!voiceConnections.has(guildId)) {
            return interaction.reply({ content: "I'm not listening in a voice channel.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const seconds = interaction.options.getInteger('seconds') ?? DEFAULT_CLIP_DURATION;
        const buffer = audioBuffers.get(guildId);

        if (!buffer || buffer.length === 0) {
            return interaction.followUp({ content: 'Not enough audio has been recorded yet.' });
        }

        const packetsToGet = seconds * AUDIO_PACKETS_PER_SECOND;
        const clippedAudio = buffer.slice(-packetsToGet);

        const timestamp = Date.now();
        const filePath = `clip_${interaction.user.id}_${timestamp}.wav`;

        const writer = new wav.Writer({
            sampleRate: AUDIO_SAMPLE_RATE,
            channels: 2,
            bitDepth: 16,
        });
        const fileStream = fs.createWriteStream(filePath);
        writer.pipe(fileStream);
        clippedAudio.forEach(chunk => writer.write(chunk));
        writer.end();

        fileStream.on('finish', async () => {
            try {
                await interaction.user.send({
                    content: `Here is your clip of the last ${seconds} seconds:`,
                    files: [filePath],
                });
                await interaction.followUp('✅ Clip sent to your DMs!');
                lastClips.set(interaction.user.id, filePath);
            } catch (error) {
                await interaction.followUp("I couldn't send you a DM. Please check your privacy settings.");
                fs.unlinkSync(filePath); // Clean up if DM fails
            }
        });
    } else if (commandName === 'replay') {
        const filePath = lastClips.get(interaction.user.id);
        if (!filePath) {
            return interaction.reply({ content: "You don't have a clip to replay.", ephemeral: true });
        }
        if (!fs.existsSync(filePath)) {
            return interaction.reply({ content: "I can't find that clip file anymore.", ephemeral: true });
        }
        const connection = voiceConnections.get(guildId);
        if (!connection) {
            return interaction.reply({ content: "I'm not in a voice channel.", ephemeral: true });
        }

        const player = createAudioPlayer();
        const resource = createAudioResource(filePath);
        connection.subscribe(player);
        player.play(resource);
        await interaction.reply({ content: `▶️ Replaying your last saved audio.`, ephemeral: true });
    }
    // Recording commands would be added here
});


client.login(process.env.DISCORD_BOT_TOKEN);