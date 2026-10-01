#!/bin/sh
# Real client IPs behind another proxy (docs/contracts.md §8). NGINX_TRUSTED_PROXIES lists the CIDRs
# (space-separated) of proxies in front of the gateway, e.g. a Kubernetes ingress. Only their
# X-Forwarded-For is believed; rate limits and logs then key on the real client address.
# Empty (compose): the TCP peer is the client and a client-sent X-Forwarded-For is ignored.
set -eu
out=/etc/nginx/conf.d/00-real-ip.conf
: > "$out"
count=0
for cidr in ${NGINX_TRUSTED_PROXIES:-}; do
    case "$cidr" in
        *[!0-9a-fA-F.:/]* | "" )
            echo "25-trusted-proxies.sh: invalid CIDR '$cidr'" >&2
            exit 1 ;;
    esac
    echo "set_real_ip_from $cidr;" >> "$out"
    count=$((count + 1))
done
if [ "$count" -gt 0 ]; then
    {
        echo "real_ip_header X-Forwarded-For;"
        echo "real_ip_recursive on;"
    } >> "$out"
fi
echo "25-trusted-proxies.sh: trusting X-Forwarded-For from ${NGINX_TRUSTED_PROXIES:-<none>}"
