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
  SERVER_PID=$(pgrep -f "pdm run server" | head -n 1)
fi

if [[ -z "$BOT_PID" ]]; then
  BOT_PID=$(pgrep -f "pdm run discord_bot" | head -n 1)
fi

if [[ -z "$SERVER_PID" || -z "$BOT_PID" ]]; then
  echo "Usage: $0 [--server-pid <PID>] [--bot-pid <PID>] [--delay <seconds>]"
  echo "Or ensure processes are running or session/server.pid and session/bot.pid exist."
  exit 1
fi

RESTART_CMD=$(cat <<INNEREOF
  # Wait for specified delay
  sleep $DELAY

  # Kill the existing processes
  kill -TERM "$BOT_PID" 2>/dev/null
  pkill -P "$BOT_PID" 2>/dev/null
  kill -TERM "$SERVER_PID" 2>/dev/null
  pkill -P "$SERVER_PID" 2>/dev/null

  # Wait a bit
  sleep 10
  
  # Force kill
  kill -9 "$BOT_PID" 2>/dev/null
  kill -9 "$SERVER_PID" 2>/dev/null
  pkill -9 -P "$BOT_PID" 2>/dev/null
  pkill -9 -P "$SERVER_PID" 2>/dev/null

  # Restart
  cd $(cd "$(dirname "$0")/.." && pwd)
  mkdir -p session
  setsid pdm run server > session/server.log 2>&1 &
  echo \$! > session/server.pid
  setsid pdm run discord_bot > session/discord_bot.log 2>&1 &
  echo \$! > session/bot.pid
INNEREOF
)

# Use setsid to detach and nohup to ignore HUP
setsid nohup bash -c "$RESTART_CMD" > /dev/null 2>&1 &

echo "Restart scheduled in $DELAY seconds. Background PID: $!"
