#!/bin/sh
set -e

AUTH_BLOCK=""
if [ -n "$BASIC_AUTH_USER" ] && [ -n "$BASIC_AUTH_PASSWORD" ]; then
  hash="$(caddy hash-password --plaintext "$BASIC_AUTH_PASSWORD")"
  AUTH_BLOCK="$(printf '\tbasic_auth {\n\t\t%s %s\n\t}\n' "$BASIC_AUTH_USER" "$hash")"
  echo "Basic auth enabled for user: $BASIC_AUTH_USER"
elif [ -n "$BASIC_AUTH_USER" ] || [ -n "$BASIC_AUTH_PASSWORD" ]; then
  echo "ERROR: set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD to enable basic auth" >&2
  exit 1
fi

cat > /tmp/Caddyfile <<EOF
:8080 {
	root * ./dist
	encode gzip zstd
	header Cache-Control "no-store"
	file_server
$AUTH_BLOCK
}
EOF

exec caddy run --config /tmp/Caddyfile --adapter caddyfile
