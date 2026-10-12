FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
ENV PORT=3000 VOXSEND_PROD_DIR=/app TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "server.js"]
