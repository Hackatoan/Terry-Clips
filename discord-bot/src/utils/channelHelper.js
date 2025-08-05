function getLargestVoiceChannel(guild) {
    const voiceChannels = guild.channels.cache.filter(
        c => c.type === 2 // 2 is the type for GuildVoice in discord.js v14
    );
    let largest = null;
    let maxMembers = 0;
    for (const channel of voiceChannels.values()) {
        if (channel.members.size > maxMembers) {
            largest = channel;
            maxMembers = channel.members.size;
        }
    }
    return largest;
}

module.exports = { getLargestVoiceChannel };