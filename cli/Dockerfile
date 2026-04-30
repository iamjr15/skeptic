# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY templates/ ./templates/
RUN npm run build

# Stage 2: Runtime
FROM mcr.microsoft.com/playwright:v1.52.0-noble
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/templates/ ./templates/
ENTRYPOINT ["node", "dist/bin/skeptic.js"]
