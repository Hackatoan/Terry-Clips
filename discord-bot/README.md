# Discord Bot to Join the Largest Voice Channel

This project is a simple Discord bot that automatically joins the voice channel with the most members in a server.

## Prerequisites

- Node.js installed on your machine.
- A Discord account and a server where you can add the bot.
- A bot token from the Discord Developer Portal.

## Setup Instructions

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd discord-bot
   ```

2. **Install dependencies**:
   Make sure you have `npm` installed, then run:
   ```bash
   npm install
   ```

3. **Create a `.env` file**:
   In the root directory of the project, create a file named `.env` and add your bot token:
   ```
   DISCORD_BOT_TOKEN=your_bot_token_here
   ```

4. **Run the bot**:
   Start the bot by running:
   ```bash
   npm start
   ```

## Usage

Once the bot is running, it will automatically join the voice channel with the most members in the server it is connected to. Make sure the bot has the necessary permissions to connect to voice channels.

## License

This project is licensed under the MIT License.