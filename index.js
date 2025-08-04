require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType, getVoiceConnection } = require('@discordjs/voice');
const fs = require('fs');
const prism = require('prism-media');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Try mono first to test if slowdown goes away; switch to 2 for stereo if needed
const CHANNELS = 1;
const AUDIO_BUFFER_MS = 30000; // 30 seconds buffer
const BYTES_PER_SAMPLE = 2; // 16-bit PCM

const userBuffers = new Map();
const listeningConnections = new Set();

function startListening(connection) {
  if (listeningConnections.has(connection)) {
    console.log('Already listening on this connection, skipping.');
    return;
  }
  listeningConnections.add(connection);

  const receiver = connection.receiver;

  receiver.speaking.on('start', userId => {
    console.log(`User started speaking: ${userId}`);

    if (!userBuffers.has(userId)) {
      userBuffers.set(userId, []);
    }

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual }
    });

    const pcmStream = new prism.opus.Decoder({
      frameSize: 960,
      channels: CHANNELS,
      rate: 48000,
    });

    audioStream.pipe(pcmStream);

    pcmStream.on('data', chunk => {
      const buffer = userBuffers.get(userId) || [];
      buffer.push(chunk);

      let bufferLength = buffer.reduce((acc, cur) => acc + cur.length, 0);
      const maxBufferSize = 48000 * BYTES_PER_SAMPLE * CHANNELS * (AUDIO_BUFFER_MS / 1000);

      while (bufferLength > maxBufferSize) {
        const removed = buffer.shift();
        bufferLength -= removed.length;
      }

      userBuffers.set(userId, buffer);
    });

    audioStream.on('end', () => {
      console.log(`User ${userId} stopped speaking, clearing buffer`);
      userBuffers.delete(userId);
    });

    audioStream.on('error', (err) => {
      console.error(`Audio stream error for user ${userId}:`, err);
      userBuffers.delete(userId);
    });

    pcmStream.on('error', (err) => {
      console.error(`PCM stream error for user ${userId}:`, err);
      userBuffers.delete(userId);
    });
  });
}

// Mix buffers: same as before, but make sure buffers are mono if CHANNELS=1
function mixBuffers(buffers) {
  if (buffers.length === 0) return null;

  const minLength = Math.min(...buffers.map(bufArr => Buffer.concat(bufArr).length));
  const mixedBuffer = Buffer.alloc(minLength);

  function readSample(buffer, offset) {
    return buffer.readInt16LE(offset);
  }
  function writeSample(buffer, offset, sample) {
    if (sample > 32767) sample = 32767;
    else if (sample < -32768) sample = -32768;
    buffer.writeInt16LE(sample, offset);
  }

  for (let i = 0; i < minLength; i += 2) {
    let sum = 0;
    for (const bufArr of buffers) {
      const combined = Buffer.concat(bufArr);
      sum += readSample(combined, i);
    }
    const avg = sum / buffers.length;
    writeSample(mixedBuffer, i, avg);
  }

  return mixedBuffer;
}

async function sendWavFromMixedBuffer(message, mixedBuffer) {
  const filename = `clips/mixed-${Date.now()}.wav`;
  fs.mkdirSync('clips', { recursive: true });

  const ffmpegProcess = spawn(ffmpeg, [
    '-f', 's16le',
    '-ar', '48000',
    '-ac', String(CHANNELS),
    '-i', 'pipe:0',
    filename,
  ]);

  ffmpegProcess.stdin.write(mixedBuffer);
  ffmpegProcess.stdin.end();

  return new Promise((resolve, reject) => {
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`Saved mixed clip as ${filename}`);
        message.channel.send({ files: [filename] });
        resolve();
      } else {
        message.reply('Failed to save mixed audio clip.');
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

async function sendWavFromBuffer(message, bufferChunks, username) {
  const filename = `clips/${username}-${Date.now()}.wav`;
  fs.mkdirSync('clips', { recursive: true });

  const ffmpegProcess = spawn(ffmpeg, [
    '-f', 's16le',
    '-ar', '48000',
    '-ac', String(CHANNELS),
    '-i', 'pipe:0',
    filename,
  ]);

  const combinedBuffer = Buffer.concat(bufferChunks);
  ffmpegProcess.stdin.write(combinedBuffer);
  ffmpegProcess.stdin.end();

  return new Promise((resolve, reject) => {
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`Saved individual clip as ${filename}`);
        message.channel.send({ files: [filename] });
        resolve();
      } else {
        message.reply(`Failed to save audio clip for ${username}.`);
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}


client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const [guildId, guild] of client.guilds.cache) {
    await guild.fetch();
    const voiceChannels = guild.channels.cache.filter(c => c.type === 2);

    for (const [, channel] of voiceChannels) {
      if (channel.members.size > 0) {
        const connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
        });
        console.log(`Joined voice channel: ${channel.name} in guild: ${guild.name}`);
        startListening(connection);
      }
    }
  }
});

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!clip')) return;

  const mention = message.mentions.users.first();

  console.log('Received !clip command. Mention:', mention ? mention.tag : 'none');

  if (mention) {
    const buffer = userBuffers.get(mention.id);
    if (!buffer || buffer.length === 0) {
      console.log(`No audio buffered for user ${mention.tag}`);
      return message.reply(`No audio buffered for ${mention.username}.`);
    }
    console.log(`Buffer chunks for ${mention.username}: ${buffer.length}`);
    await sendWavFromBuffer(message, buffer, mention.username);
  } else {
    if (userBuffers.size === 0) {
      console.log('No audio buffered for anyone');
      return message.reply('No audio buffered for anyone.');
    }

    const allBuffers = Array.from(userBuffers.values());
    console.log(`Mixing audio from ${allBuffers.length} users`);

    // Log each buffer length
    allBuffers.forEach((bufArr, i) => {
      const totalLength = Buffer.concat(bufArr).length;
      console.log(`User ${i} buffer length: ${totalLength} bytes`);
    });

    const mixedBuffer = mixBuffers(allBuffers);

    if (!mixedBuffer) {
      console.log('Failed to mix audio buffer');
      return message.reply('Failed to mix audio.');
    }

    console.log(`Mixed buffer length: ${mixedBuffer.length}`);

    await sendWavFromMixedBuffer(message, mixedBuffer);
  }
});


client.on('voiceStateUpdate', (oldState, newState) => {
  const connection = getVoiceConnection(newState.guild.id);
  if (connection) {
    startListening(connection);
  }
});

function ffmpegTimeout(ffmpegProcess, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ffmpegProcess.kill('SIGKILL');
      reject(new Error('ffmpeg process timed out'));
    }, timeoutMs);

    ffmpegProcess.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

client.login(process.env.DISCORD_TOKEN);
