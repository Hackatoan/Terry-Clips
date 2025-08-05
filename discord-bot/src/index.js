require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { getLargestVoiceChannel } = require('./utils/channelHelper');
const { joinVoiceChannel, createAudioReceiver } = require('@discordjs/voice');
const { Writable } = require('stream');
const fs = require('fs');
const path = require('path');
const prism = require('prism-media');

const AUDIO_BUFFER_DURATION = 30 * 1000; // 30 seconds in ms

// Map of userId -> array of audio chunks (Buffer)
const userAudioBuffers = new Map();

function addToBuffer(userId, chunk) {
    if (!userAudioBuffers.has(userId)) {
        userAudioBuffers.set(userId, []);
    }
    const buffer = userAudioBuffers.get(userId);
    buffer.push({ timestamp: Date.now(), chunk });
    // Remove chunks older than 30 seconds
    while (buffer.length && (Date.now() - buffer[0].timestamp > AUDIO_BUFFER_DURATION)) {
        buffer.shift();
    }
}

// Track active audio streams per user
const activeAudioStreams = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    const guild = client.guilds.cache.first();
    if (!guild) {
        console.log('No guilds found.');
        return;
    }

    await guild.channels.fetch(); // Ensure channels are cached
    const channel = getLargestVoiceChannel(guild);
    if (channel) {
        try {
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });
            console.log(`Joined ${channel.name}`);

            const receiver = connection.receiver;

            receiver.speaking.on('start', (userId) => {
                if (activeAudioStreams.has(userId)) return; // Already subscribed

                const audioStream = receiver.subscribe(userId, {
                    end: {
                        behavior: 'manual',
                    },
                });

                // Decode Opus to PCM
                const decoder = new prism.opus.Decoder({
                    rate: 48000,
                    channels: 1,
                    frameSize: 960,
                });

                audioStream.pipe(decoder);

                decoder.on('data', (pcmChunk) => {
                    addToBuffer(userId, pcmChunk);
                });

                audioStream.on('end', () => {
                    activeAudioStreams.delete(userId);
                    decoder.destroy();
                });

                activeAudioStreams.set(userId, audioStream);
            });

            receiver.speaking.on('end', (userId) => {
                const audioStream = activeAudioStreams.get(userId);
                if (audioStream) {
                    audioStream.removeAllListeners('data');
                    audioStream.removeAllListeners('end');
                    audioStream.destroy();
                    activeAudioStreams.delete(userId);
                }
            });
        } catch (error) {
            console.error(`Could not join channel: ${error}`);
        }
    } else {
        console.log('No voice channels found.');
    }
});

function createWavHeader(dataLength, options = {}) {
    const {
        numChannels = 1,
        sampleRate = 48000,
        bitDepth = 16,
    } = options;

    const byteRate = sampleRate * numChannels * bitDepth / 8;
    const blockAlign = numChannels * bitDepth / 8;
    const buffer = Buffer.alloc(44);

    buffer.write('RIFF', 0); // ChunkID
    buffer.writeUInt32LE(36 + dataLength, 4); // ChunkSize
    buffer.write('WAVE', 8); // Format
    buffer.write('fmt ', 12); // Subchunk1ID
    buffer.writeUInt32LE(16, 16); // Subchunk1Size
    buffer.writeUInt16LE(1, 20); // AudioFormat (PCM)
    buffer.writeUInt16LE(numChannels, 22); // NumChannels
    buffer.writeUInt32LE(sampleRate, 24); // SampleRate
    buffer.writeUInt32LE(byteRate, 28); // ByteRate
    buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
    buffer.writeUInt16LE(bitDepth, 34); // BitsPerSample
    buffer.write('data', 36); // Subchunk2ID
    buffer.writeUInt32LE(dataLength, 40); // Subchunk2Size

    return buffer;
}

function normalizePcmBuffer(pcmBuffer) {
    if (pcmBuffer.length === 0) return pcmBuffer;
    let maxSample = 0;
    // Find max absolute sample value
    for (let i = 0; i < pcmBuffer.length; i += 2) {
        const sample = pcmBuffer.readInt16LE(i);
        maxSample = Math.max(maxSample, Math.abs(sample));
    }
    if (maxSample === 0) return pcmBuffer; // silence
    const scale = 32767 / maxSample;
    // Create new buffer with normalized samples
    const normalized = Buffer.alloc(pcmBuffer.length);
    for (let i = 0; i < pcmBuffer.length; i += 2) {
        let sample = pcmBuffer.readInt16LE(i);
        sample = Math.max(-32768, Math.min(32767, Math.round(sample * scale)));
        normalized.writeInt16LE(sample, i);
    }
    return normalized;
}

client.on('messageCreate', async (message) => {
    if (message.content === '!clip') {
        let allEntries = [];
        for (const bufferArr of userAudioBuffers.values()) {
            for (const entry of bufferArr) {
                allEntries.push(entry);
            }
        }
        if (allEntries.length === 0) {
            await message.reply('No audio captured in the last 30 seconds.');
            return;
        }
        allEntries.sort((a, b) => a.timestamp - b.timestamp);

        // Concatenate all chunks in time order
        const pcmBuffer = Buffer.concat(allEntries.map(entry => entry.chunk));

        // Normalize the entire buffer (not per chunk)
        const normalizedBuffer = normalizePcmBuffer(pcmBuffer);

        const wavHeader = createWavHeader(normalizedBuffer.length, {
            numChannels: 1,
            sampleRate: 48000,
            bitDepth: 16,
        });
        const wavBuffer = Buffer.concat([wavHeader, normalizedBuffer]);
        const filePath = path.join(__dirname, 'clip.wav');
        fs.writeFileSync(filePath, wavBuffer);

        await message.channel.send({
            files: [{
                attachment: filePath,
                name: 'clip.wav'
            }]
        });

        fs.unlinkSync(filePath);
    }
});

// Add this intent to your client if not present
// GatewayIntentBits.MessageContent,
// GatewayIntentBits.GuildMessages,

client.login(process.env.BOT_TOKEN);