FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
ENV NODE_ENV=production STATE_FILE=/app/data/state.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
CMD ["node", "--import", "tsx", "src/run.ts"]
