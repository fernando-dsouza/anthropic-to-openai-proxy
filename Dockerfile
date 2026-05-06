FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 8082

ENV PORT=8082
ENV OMNIROUTE_URL=http://localhost:3000
ENV TARGET_PATH=/v1/chat/completions
ENV DIRECT_ANTHROPIC=false

CMD ["node", "server.js"]
