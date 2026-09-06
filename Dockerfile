FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip build-essential ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Current yt-dlp + EJS solver + PO-token provider for modern YouTube restrictions.
RUN pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" yt-dlp-ejs edge-tts bgutil-ytdlp-pot-provider

# Build the official bgutil HTTP PO-token provider inside the same Railway container.
RUN git clone --depth 1 --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm ci --no-audit --no-fund \
    && npx tsc

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY README.md ./
COPY .env.example ./

ENV NODE_ENV=production
ENV YTDLP_POT_URL=http://127.0.0.1:4416

# Start PO-token provider + Discord bot in one Railway service.
CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js --host 127.0.0.1 --port 4416 & exec node index.js"]
