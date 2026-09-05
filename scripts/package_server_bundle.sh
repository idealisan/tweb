#!/usr/bin/env bash
set -euo pipefail

platform=${1:?platform is required}
caddy_binary=${2:?caddy binary is required}
dist_dir=${3:?dist directory is required}
output_dir=${4:?output directory is required}

rm -rf "$output_dir"
mkdir -p "$output_dir/dist" "$output_dir/caddy"
cp -R "$dist_dir"/. "$output_dir/dist/"
cp "$caddy_binary" "$output_dir/caddy/"

if [[ "$platform" == windows_* ]]; then
  cat > "$output_dir/start.ps1" <<'POWERSHELL'
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$caddy = Join-Path $root "caddy\caddy.exe"
$port = 8000
while ($true) {
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $listener.Start()
    $listener.Stop()
    break
  } catch {
    $port++
  }
}
$url = "http://127.0.0.1:$port/"
Write-Host "Serving Telegram Web at $url"
Start-Process $url
& $caddy file-server --root (Join-Path $root "dist") --listen "127.0.0.1:$port"
POWERSHELL
  cat > "$output_dir/start.bat" <<'BATCH'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
BATCH
else
  cat > "$output_dir/start.sh" <<'SHELL'
#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
caddy="$root/caddy/caddy"
port="$(python3 - "$root" <<'PY'
import socket
import sys

port = 8000
while True:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
        print(port)
        break
    except OSError:
        port += 1
    finally:
        sock.close()
PY
)"
url="http://127.0.0.1:${port}/"
echo "Serving Telegram Web at ${url}"
"$caddy" file-server --root "$root/dist" --listen "127.0.0.1:${port}" &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT INT TERM
sleep 0.3
if command -v open >/dev/null 2>&1; then
  open "$url"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 || true
fi
wait "$pid"
SHELL
  cp "$output_dir/start.sh" "$output_dir/start.command"
  chmod +x "$output_dir/start.sh" "$output_dir/start.command" "$output_dir/caddy/caddy"
fi
