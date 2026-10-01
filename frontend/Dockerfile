# syntax=docker/dockerfile:1.7

# ---- build: Vite production bundle ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public/ public/
COPY src/ src/
# Baked into the bundle at build time (contracts §8.1). Default: same-origin /api via the gateway.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

# ---- runtime: official unprivileged Nginx (uid 101), static files only ----
FROM nginxinc/nginx-unprivileged:1.31.5-alpine

ENV NGINX_CSP_CONNECT_SRC="'self'" \
    NGINX_ENVSUBST_FILTER="^NGINX_"

COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/snippets/ /etc/nginx/snippets/
COPY nginx/templates/ /etc/nginx/templates/
COPY --from=build /app/dist/ /usr/share/nginx/html/

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8081/health || exit 1
