FROM node:20.18.0-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

FROM node:20.18.0-alpine AS production

WORKDIR /app

RUN mkdir -p /app/data/media_cache /app/logs /app/profiles

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY data ./data
COPY logs ./logs
COPY profiles ./profiles
COPY rules ./rules
COPY .env.example ./.env.example
COPY README.md ./README.md
COPY PROJECT_SPEC.md ./PROJECT_SPEC.md
COPY POST_RULES.md ./POST_RULES.md

ENV NODE_ENV=production

CMD ["npm", "start"]
