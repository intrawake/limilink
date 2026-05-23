#!/bin/bash

# restart_limilink.sh
# This script restarts the limilink server and discord bot.

SERVER_PID=""
BOT_PID=""
DELAY=120

while [[ $# -gt 0 ]]; do
  case $1 in
    --server-pid)
      SERVER_PID="$2"
      shift 2
      ;;
    --bot-pid)
      BOT_PID="$2"
      shift 2
      ;;
    --delay|-d)
      DELAY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$SERVER_PID" && -f "$(cd "$(dirname "$0")/.." && pwd)/session/server.pid" ]]; then
  SERVER_PID=$(cat $(cd "$(dirname "$0")/.." && pwd)/session/server.pid)
fi

if [[ -z "$BOT_PID" && -f "$(cd "$(dirname "$0")/.." && pwd)/session/bot.pid" ]]; then
  BOT_PID=$(cat $(cd "$(dirname "$0")/.." && pwd)/session/bot.pid)
fi

if [[ -z "$SERVER_PID" ]]; then
  SERVER_PID=$(pgrep -f "pdm run limilink$" | head -n 1)
fi

if [[ -z "$BOT_PID" ]]; then
  BOT_PID=$(pgrep -f "pdm run limilink-discord$" | head -n 1)
fi

if [[ -z "$SERVER_PID" || -z "$BOT_PID" ]]; then
  echo "Usage: $0 [--server-pid <PID>] [--bot-pid <PID>] [--delay <seconds>]"
  echo "Or ensure processes are running or session/server.pid and session/bot.pid exist."
  exit 1
fi

RESTART_CMD=$(cat <<INNEREOF
  # Get process group IDs to ensure we kill all children without orphaning them
  SERVER_PGID=\$(ps -o pgid= -p "\$SERVER_PID" | tr -d ' ' 2>/dev/null)
  BOT_PGID=\$(ps -o pgid= -p "\$BOT_PID" | tr -d ' ' 2>/dev/null)

  # Wait for specified delay
  sleep $DELAY

  # Kill the existing processes and their process groups
  if [[ -n "\$BOT_PGID" ]]; then
    kill -TERM -"\$BOT_PGID" 2>/dev/null
  else
    kill -TERM "\$BOT_PID" 2>/dev/null
  fi
  
  if [[ -n "\$SERVER_PGID" ]]; then
    kill -TERM -"\$SERVER_PGID" 2>/dev/null
  else
    kill -TERM "\$SERVER_PID" 2>/dev/null
  fi

  # Wait a bit
  sleep 10
  
  # Force kill
  if [[ -n "\$BOT_PGID" ]]; then
    kill -9 -"\$BOT_PGID" 2>/dev/null
  else
    kill -9 "\$BOT_PID" 2>/dev/null
  fi

  if [[ -n "\$SERVER_PGID" ]]; then
    kill -9 -"\$SERVER_PGID" 2>/dev/null
  else
    kill -9 "\$SERVER_PID" 2>/dev/null
  fi

  # Restart
  cd $(cd "$(dirname "$0")/.." && pwd)
  mkdir -p session
  setsid /home/paprika/.local/bin/pdm run limilink > session/server.log 2>&1 &
  echo \$! > session/server.pid
  setsid /home/paprika/.local/bin/pdm run limilink-discord > session/discord_bot.log 2>&1 &
  echo \$! > session/bot.pid
INNEREOF
)

# Use setsid to detach and nohup to ignore HUP
setsid nohup bash -c "$RESTART_CMD" > /dev/null 2>&1 &

echo "Restart scheduled in $DELAY seconds. Background PID: $!"
