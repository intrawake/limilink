#!/bin/bash

# openrc_limilink_restart.sh
# Restarts limilink and limilink-discord via OpenRC.
# Backgrounds itself so it survives the restart (since limilink spawns this harness).
#
# Usage:
#   openrc_limilink_restart.sh [--delay <seconds>] [--bot-only] [--server-only]

DELAY=120
DO_SERVER=true
DO_BOT=true

while [[ $# -gt 0 ]]; do
  case $1 in
    --delay|-d)
      DELAY="$2"
      shift 2
      ;;
    --bot-only)
      DO_SERVER=false
      shift
      ;;
    --server-only)
      DO_BOT=false
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--delay <seconds>] [--bot-only] [--server-only]"
      exit 1
      ;;
  esac
done

# Build the detached restart command
CMDS=""
[[ "$DO_BOT" == "true" ]] && CMDS+="echo \"Restarting limilink-discord...\"; doas -- rc-service limilink-discord restart; "
[[ "$DO_SERVER" == "true" ]] && CMDS+="echo \"Restarting limilink...\"; doas -- rc-service limilink restart; "
CMDS+="echo \"Done.\""

# Background the whole thing: sleep then restart, fully detached
setsid nohup bash -c "sleep $DELAY; $CMDS" > /dev/null 2>&1 &

echo "Restart scheduled in ${DELAY}s. Background PID: $!"
