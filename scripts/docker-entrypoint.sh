#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Ensure uv/uvx cache, data and bin directories are writable by the node user.
# uvx needs all three when spawning MCP servers (downloads tools to the data
# dir, caches packages in the cache dir, and may install symlinks under the
# bin dir). These live inside the /paperclip volume so they persist across
# restarts, but they're created here every boot because the volume itself may
# pre-date these env vars.
mkdir -p /paperclip/.cache/uv \
         /paperclip/.local/share/uv \
         /paperclip/.local/bin
chown -R node:node /paperclip/.cache /paperclip/.local

exec gosu node "$@"
