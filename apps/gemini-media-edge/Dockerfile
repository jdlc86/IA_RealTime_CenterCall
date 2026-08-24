FROM node:24.7.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.mjs"]
