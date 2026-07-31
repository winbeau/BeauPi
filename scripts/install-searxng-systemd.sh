#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="searxng.service"
UNIT_SOURCE="$SCRIPT_DIR/systemd/$UNIT_NAME"
SEARXNG_DIR="$HOME/.local/share/searxng"
COMPOSE_FILE="$SEARXNG_DIR/compose.yml"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_TARGET="$SYSTEMD_USER_DIR/$UNIT_NAME"
WANTS_DIR="$SYSTEMD_USER_DIR/default.target.wants"
HEALTH_URL="http://127.0.0.1:8888/"

if [[ ! -f "$COMPOSE_FILE" ]]; then
	printf 'Missing SearXNG Compose file: %s\n' "$COMPOSE_FILE" >&2
	exit 1
fi

if [[ ! -x /usr/bin/docker ]]; then
	printf 'Docker is required at /usr/bin/docker.\n' >&2
	exit 1
fi

/usr/bin/docker compose version >/dev/null
install -Dm0644 "$UNIT_SOURCE" "$UNIT_TARGET"

if systemctl --user show-environment >/dev/null 2>&1; then
	systemctl --user daemon-reload
	systemctl --user enable "$UNIT_NAME"
	systemctl --user restart "$UNIT_NAME"
else
	mkdir -p "$WANTS_DIR"
	ln -sfn "../$UNIT_NAME" "$WANTS_DIR/$UNIT_NAME"
	(
		cd "$SEARXNG_DIR"
		/usr/bin/docker compose up -d --remove-orphans
	)
	printf 'User systemd bus is unavailable; enabled %s for the next user-manager startup.\n' "$UNIT_NAME"
fi

container_id="$(cd "$SEARXNG_DIR" && /usr/bin/docker compose ps --status running -q searxng)"
if [[ -z "$container_id" ]]; then
	printf 'SearXNG did not reach the running container state.\n' >&2
	exit 1
fi

if command -v curl >/dev/null 2>&1; then
	ready=false
	for _ in {1..30}; do
		if curl --noproxy '*' --fail --silent --show-error --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
			ready=true
			break
		fi
		sleep 1
	done
	if [[ "$ready" != true ]]; then
		printf 'SearXNG container is running but %s did not become ready.\n' "$HEALTH_URL" >&2
		exit 1
	fi
fi

linger="$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || true)"
printf 'Installed: %s\n' "$UNIT_TARGET"
printf 'Enabled:   %s\n' "$WANTS_DIR/$UNIT_NAME"
printf 'SearXNG:   %s\n' "$HEALTH_URL"
if [[ "$linger" != yes ]]; then
	printf 'Warning: user lingering is disabled; enable it so the user service starts before login.\n' >&2
fi
