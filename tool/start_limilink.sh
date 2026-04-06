#!/bin/bash
# tool/start_limilink.sh

PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$PROJECT_ROOT"

# Ensure session directory exists
mkdir -p session

# Check if already running
SERVER_PID=$(pgrep -f "pdm run server$" | head -n 1)
BOT_PID=$(pgrep -f "pdm run discord_bot$" | head -n 1)

if [[ -n "$SERVER_PID" ]]; then
  echo "Server is already running (PID: $SERVER_PID)."
else
  echo "Starting server..."
  setsid pdm run server > session/server.log 2>&1 &
  echo $! > session/server.pid
fi

if [[ -n "$BOT_PID" ]]; then
  echo "Discord bot is already running (PID: $BOT_PID)."
else
  echo "Starting Discord bot..."
  setsid pdm run discord_bot > session/discord_bot.log 2>&1 &
  echo $! > session/bot.pid
fi

echo "Limilink started. Logs: session/server.log, session/discord_bot.log"
