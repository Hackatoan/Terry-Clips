// This file is the entry point of the Discord bot. It initializes the bot using the token from the .env file, connects to Discord, and implements the logic to join the voice channel with the most members.

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { getLargestVoiceChannel } = require('./utils/channelHelper');
const { joinVoiceChannel, createAudioReceiver } = require('@discordjs/voice');
const { Writable } = require('stream');
const fs = require('fs');
const path = require('path');
const prism = require('prism-media');
const speech = require('@google-cloud/speech');
const speechClient = new speech.SpeechClient();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

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

            receiver.speaking.on('end', async (userId) => {
                const audioStream = activeAudioStreams.get(userId);
                if (audioStream) {
                    audioStream.removeAllListeners('data');
                    audioStream.removeAllListeners('end');
                    audioStream.destroy();
                    activeAudioStreams.delete(userId);
                }
                // Get user's last 30s buffer
                const bufferArr = userAudioBuffers.get(userId);
                if (bufferArr && bufferArr.length > 0) {
                    const userPcmBuffer = Buffer.concat(bufferArr.map(entry => entry.chunk));
                    const transcript = await transcribePcmBufferGoogle(userPcmBuffer);
                    if (transcript && /\bterry\s+clip\s+that\b/i.test(transcript)) {
                        console.log('Voice trigger: sending to channel', 1402078598147342336);
                        runClipCommand(1402078598147342336);
                    }
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

async function transcribePcmBufferGoogle(pcmBuffer) {
    const audioBytes = pcmBuffer.toString('base64');
    const request = {
        audio: { content: audioBytes },
        config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 48000,
            languageCode: 'en-US',
            audioChannelCount: 1,
        },
    };
    const [response] = await speechClient.recognize(request);
    const transcription = response.results
        .map(result => result.alternatives[0].transcript)
        .join(' ');
    return transcription;
}

client.on('messageCreate', async (message) => {
    // Regex to match "terry clip that" with any spelling of "terry"
    const terryRegex = /\b[tT][eEaA3][rR][rR][yYi1lL!|]\s+clip\s+that\b/i;

    const shouldClip =
        message.content === '!clip' ||
        terryRegex.test(message.content);

    if (!shouldClip) return;

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

    const pcmBuffer = Buffer.concat(allEntries.map(entry => entry.chunk));
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
});

async function runClipCommand(channelId) {
    console.log('runClipCommand called with:', channelId);
    let channel = client.channels.cache.get(channelId);
    if (!channel) {
        // Try to fetch the channel if not cached
        try {
            console.log('Trying to fetch channel:', channelId);
            channel = await client.channels.fetch(channelId);
        } catch (err) {
            console.error('Could not fetch channel:', channelId, err);
            return;
        }
    }
    console.log('Resolved channel:', channel?.name, channel?.id, channel?.type);

    let allEntries = [];
    for (const bufferArr of userAudioBuffers.values()) {
        for (const entry of bufferArr) {
            allEntries.push(entry);
        }
    }
    if (allEntries.length === 0) {
        await channel.send('No audio captured in the last 30 seconds.');
        return;
    }
    allEntries.sort((a, b) => a.timestamp - b.timestamp);

    const pcmBuffer = Buffer.concat(allEntries.map(entry => entry.chunk));
    const normalizedBuffer = normalizePcmBuffer(pcmBuffer);

    const wavHeader = createWavHeader(normalizedBuffer.length, {
        numChannels: 1,
        sampleRate: 48000,
        bitDepth: 16,
    });
    const wavBuffer = Buffer.concat([wavHeader, normalizedBuffer]);
    const filePath = path.join(__dirname, 'clip.wav');
    fs.writeFileSync(filePath, wavBuffer);

    await channel.send({
        files: [{
            attachment: filePath,
            name: 'clip.wav'
        }]
    });

    fs.unlinkSync(filePath);
}

client.login(process.env.BOT_TOKEN);

console.log('Bot starting, hardcoded channel:', 1402078598147342336);