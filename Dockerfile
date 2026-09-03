# Captain — plain Node server, runs anywhere Docker runs: a VPS, Render,
# Railway, Fly.io, your own machine. No platform-specific build step.
FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY server.js ./server.js
COPY scripts ./scripts
COPY db ./db

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
