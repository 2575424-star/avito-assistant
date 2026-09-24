FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
