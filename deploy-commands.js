const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config(); // Loads .env file variables

const clientId = '1395549464940515543'; // Replace with your bot's Client ID
const guildId = '838836392334327898'; // Replace with your server's ID for testing
const token = process.env.DISCORD_BOT_TOKEN;

const commands = [
    new SlashCommandBuilder()
        .setName('clip')
        .setDescription('Clips the last X seconds of audio (Default: 30s, Max: 120s)')
        .addIntegerOption(option =>
            option.setName('seconds')
                .setDescription('The duration of the clip in seconds.')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(120)),
    new SlashCommandBuilder()
        .setName('record')
        .setDescription('Starts a continuous recording with a 30-second buffer.'),
    new SlashCommandBuilder()
        .setName('stoprecording')
        .setDescription('Stops the current recording.'),
    new SlashCommandBuilder()
        .setName('replay')
        .setDescription('Plays the last saved clip or recording in your voice channel.'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        // For testing, we deploy to a single guild instantly.
        // For production, you would use Routes.applicationCommands(clientId)
        await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();