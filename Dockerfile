FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY fal-api.mjs fal-sozluk.json ./
COPY docs ./docs
ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "fal-api.mjs"]
