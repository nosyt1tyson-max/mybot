FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip build-essential ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Current yt-dlp + EJS challenge solver for modern YouTube extraction.
RUN pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" yt-dlp-ejs edge-tts

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY README.md ./
COPY .env.example ./

ENV NODE_ENV=production

CMD ["node", "index.js"]
