#!/bin/sh
# Generates the CORS allowlist map from CORS_ALLOWED_ORIGINS: space-separated exact origins,
# for example "http://localhost:8080 https://fraudguard.example". Unlisted origins get no CORS headers.
set -eu
out=/etc/nginx/conf.d/00-cors-origins.conf
{
    echo 'map $http_origin $cors_allowed_origin {'
    echo '    default "";'
    for origin in ${CORS_ALLOWED_ORIGINS:-}; do
        case "$origin" in
            http://*|https://*) printf '    "%s" "%s";\n' "$origin" "$origin" ;;
            *) echo "20-cors-origins.sh: ignoring invalid origin '$origin'" >&2 ;;
        esac
    done
    echo '}'
} > "$out"
echo "20-cors-origins.sh: CORS allowlist -> ${CORS_ALLOWED_ORIGINS:-<none>}"
