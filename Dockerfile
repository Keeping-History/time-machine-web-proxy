FROM node:22-bookworm AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g corepack@latest && corepack enable && corepack prepare pnpm@10.26.0 --activate
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
RUN pnpm run build

FROM node:22-bookworm-slim

WORKDIR /app
COPY --from=build /app/dist/timemachine.js ./
RUN addgroup --system timemachine && adduser --system --ingroup timemachine timemachine \
    && mkdir -p /app/cache && chown timemachine:timemachine /app/cache
USER timemachine

EXPOSE ${TIMEMACHINE_PORT:-8765}

CMD ["node", "timemachine.js"]
