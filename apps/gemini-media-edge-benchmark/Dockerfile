FROM node:24.18.0-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
