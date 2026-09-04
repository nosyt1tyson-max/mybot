FROM node:24-bookworm-slim

# FFmpeg is used for Discord audio playback.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Edge TTS gives us Indian neural voices such as hi-IN-SwaraNeural and en-IN-NeerjaNeural.
RUN pip3 install --no-cache-dir --break-system-packages edge-tts yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]
