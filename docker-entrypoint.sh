#!/bin/sh
set -e

BASE_CONFIG="/etc/caddy/Caddyfile"

if [ -n "$BASIC_AUTH_USER" ] && [ -n "$BASIC_AUTH_PASSWORD" ]; then
  hash="$(caddy hash-password --plaintext "$BASIC_AUTH_PASSWORD")"
  CONFIG="/etc/caddy/Caddyfile.auth"
  {
    cat "$BASE_CONFIG"
    printf '\nbasic_auth {\n\t%s %s\n}\n' "$BASIC_AUTH_USER" "$hash"
  } > "$CONFIG"
  echo "Basic auth enabled for user: $BASIC_AUTH_USER"
elif [ -n "$BASIC_AUTH_USER" ] || [ -n "$BASIC_AUTH_PASSWORD" ]; then
  echo "ERROR: set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD to enable basic auth" >&2
  exit 1
else
  CONFIG="$BASE_CONFIG"
fi

exec caddy run --config "$CONFIG" --adapter caddyfile
