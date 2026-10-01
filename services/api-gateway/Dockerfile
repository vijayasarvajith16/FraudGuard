# syntax=docker/dockerfile:1.7

# Official unprivileged image (stable branch): runs as uid 101, listens on 8080, renders
# /etc/nginx/templates/*.template with envsubst and runs /docker-entrypoint.d/*.sh at startup.
FROM nginxinc/nginx-unprivileged:1.31.5-alpine

ENV NGINX_RESOLVER=127.0.0.11 \
    CORS_ALLOWED_ORIGINS="" \
    NGINX_ENVSUBST_FILTER="^NGINX_"

COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets/ /etc/nginx/snippets/
COPY templates/ /etc/nginx/templates/
COPY --chmod=0755 docker-entrypoint.d/20-cors-origins.sh /docker-entrypoint.d/20-cors-origins.sh

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
