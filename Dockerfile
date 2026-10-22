FROM node:20-slim
WORKDIR /app
COPY package.json package.json
RUN npm install --production
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["node", "src/server.js"]
