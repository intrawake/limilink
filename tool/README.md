# Limilink Tool Collection

These executable helpers support Limilink sessions, notifications, service management, and local pi-agent session inspection.
Examples below run from the repository root.

## `limilink_continue_after.py`

Run a command, wait briefly for an immediate result, and notify the current Limilink session when it eventually finishes.
If the command is still running after the delay, the monitor continues in the background.

```sh
./tool/limilink_continue_after.py --delay 5 --stdout build.log -- \
  pdm run build
```

Options:

- `--delay SECONDS`: foreground wait before backgrounding; defaults to 5.
- `--stdin PATH`: input file; defaults to `/dev/null`.
- `--stdout PATH`: append command output to this file; defaults to `/dev/null`.
- `--stderr PATH`: append errors separately; defaults to the stdout target.

The notification includes the command and whether it succeeded.
This helper uses `notifyme.py`, so it must run from a Limilink session or with `LIMILINK_SESSION` set.

## `notifyme.py`

Send a notification to the current Limilink session through the local server.
The script finds the session from `LIMILINK_SESSION` or by walking upward for a `.initialized` marker.

```sh
./tool/notifyme.py "The build finished."
printf 'The build finished.\n' | ./tool/notifyme.py
```

It reads the Limilink port from the configured `config.sxpb`, defaulting to port 8000.
A running local Limilink server is required.

## `openrc_limilink_restart.sh`

Schedule detached OpenRC restarts of `limilink` and `limilink-discord`. The
default two-minute delay lets the command return before restarting the service
that launched it.

```shell
./tool/openrc_limilink_restart.sh
./tool/openrc_limilink_restart.sh --delay 30 --server-only
./tool/openrc_limilink_restart.sh --bot-only
```

This is a deployment utility for hosts where the caller can use `doas` to restart OpenRC services.
Use `--server-only` or `--bot-only` to restart just one service.

## `pi_session_stat.py`

Summarize a pi-agent session: model, context-window usage, message and tool-call counts, cumulative tokens, and estimated cost.
Limilink uses this script for `!stat`.

```shell
./tool/pi_session_stat.py path/to/session.jsonl
PI_CODING_AGENT_DIR=path/to/.pi/agent ./tool/pi_session_stat.py
```

When no path is supplied, it first checks `PI_CODING_AGENT_DIR`, then pi's normal home session directory.
Context-window lookup calls `pi-agent --list-models`; the rest is read directly from JSONL.

## `pi_session_trace.py`

Inspect events in local pi-agent session JSONL. The current `tool` selector
shows recent tool calls, paired with their results:

```shell
./tool/pi_session_trace.py tool       # Last 10 calls
./tool/pi_session_trace.py tool 5     # Last 5 calls
./tool/pi_session_trace.py tool 5 -v  # Full arguments/results as JSONL
```

Use `--session PATH_OR_ID` to select a JSONL file or Limilink session ID; otherwise the script finds the current or newest local session.
Compact status markers are `.` for success, `E` for error, and `?` when no result has been recorded yet.

Inside Limilink, `!trace tool 5` shows the last five tool calls for the current pi session.
