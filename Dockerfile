# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Install system dependencies required for audio
# We need ffmpeg for processing and python/make/g++ for some npm packages
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install --omit=dev

# Bundle app source
COPY . .

# Your bot's private token will be passed in as an environment variable, not stored here
ENV DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN

# When the container launches, run this command
CMD ["node", "index.js"]