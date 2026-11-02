FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "--import", "tsx", "src/server.ts"]
