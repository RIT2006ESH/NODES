FROM node:24-alpine

WORKDIR /app

# Install first so code edits do not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/testing/package.json packages/testing/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
COPY tools tools

ARG VITE_SMOKE_BASE_URL
ENV VITE_SMOKE_BASE_URL=$VITE_SMOKE_BASE_URL
RUN npm run build
EXPOSE 10000
ENV PORT=10000
CMD ["npm", "start"]
