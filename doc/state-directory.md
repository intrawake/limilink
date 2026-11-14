# Session state location

The server, Discord bridge and trace-by-ID helper select the same root:

1. Nonempty `LIMILINK_SESSIONS_DIR` (relative to the process cwd).
2. Config `session_dirpath` (`~` supported; relative to the config directory).
3. `$XDG_STATE_HOME/limilink/sessions`, or `~/.local/state/limilink/sessions` when XDG_STATE_HOME is unset, empty or nonabsolute.

Config remains at `$XDG_CONFIG_HOME/limilink/config.sxpb`, normally `~/.config/limilink/config.sxpb`. `LIMILINK_CONFIG` selects another file; server `--config` takes precedence. Fresh state roots are private (0700); existing directory modes are unchanged. There is no automatic migration or checkout fallback.

The whole root contains sessions, pins, receipts/recovery records, titles/order/trash metadata, Discord mappings and hidden ownership/lease/execution files. Back it up as persistent state. OpenRC logs remain `/var/log/limilink*.log` and service PIDs remain under `/run`; application `server.pid`/`bot.pid` markers stay in the root.

## Cutover

Useful conversations need not be finalized. Both services and all child/manual writers **must be stopped**, with no supervisor restarting them during the command. Take a backup first. Use the updated code containing the relocation tool and pending-relocation startup guard.

**Do not manually move the root first.** The command stages stock-Pi forks, moves the complete root while holding its existing locks, archives old journals/Activity, and verifies ordinary Pi continuation. It accepts only an absent destination on the same filesystem. Run it as the state owner, never root, from outside the session tree. Create the destination parent first.

For the current service account and default XDG location:

```sh
# As service administrator, after active work finishes:
rc-service limilink-discord stop
rc-service limilink stop

# As paprika, in the checkout (NOT a session directory):
cd /home/paprika/project/limilink
old="$PWD/session"
new="$HOME/.local/state/limilink/sessions"
pi_package="$HOME/dreamscape/dist/pi_npm/node_modules/@earendil-works/pi-coding-agent"
mkdir -p "$(dirname "$new")"

# Dry-run: inspect selected journals, roots and SDK version.
.venv/bin/python tool/relocate_state.py "$old" "$new" --pi-package "$pi_package"

# Only after the plan is correct and all writers have finished:
.venv/bin/python tool/relocate_state.py "$old" "$new" --pi-package "$pi_package" \
  --apply --workers-finished
```

If XDG_STATE_HOME is customized, use its actual absolute target instead. Before restarting, ensure config/environment overrides point at the new root, or remove the old override to use the new default. The command does not edit configuration or change versions.

After a successful `state: complete` result, as service administrator:

```sh
rc-service limilink start
rc-service limilink-discord start
```

Verify the same conversation IDs/titles, existing history and pins, then send a turn in an existing conversation and confirm its prior context is available. Discord's mapping file is retained; live Discord connectivity still needs operator acceptance.

## What is preserved or archived

A plain move is insufficient: Pi's custom-directory `--continue` filters journals by recorded absolute cwd. The tool uses stock `SessionManager.forkFrom`, preserving the Pi UUID and complete entry tree/current context while creating a new journal filename/header for the new cwd. All original journals and sidecars are retained under each session's `.relocation/OPERATION/previous-session/`, outside active discovery. Old Activity snapshots/observer families are archived there too; new work gets fresh ownership rather than adopting old child slots.

The fork's `parentSession` is historical provenance pointing to the original pre-move filename; it may no longer resolve. The private root `.relocation-OPERATION.json` report maps selected sources to their actual archives. Transcript text, environment overrides, historical paths and ordinary symlinks are not rewritten. Inspect any custom root-dependent paths separately.

## Rollback

Stop both services and all writers again. Use the **same updated tool with the roots reversed**, dry-run first, then apply:

```sh
.venv/bin/python tool/relocate_state.py "$new" "$old" --pi-package "$pi_package"
.venv/bin/python tool/relocate_state.py "$new" "$old" --pi-package "$pi_package" \
  --apply --workers-finished
```

This carries the latest post-cutover model context back. Do not restore a stale backup or merely move directories back. Then restore the intended version/configuration: older code defaults to checkout `session/`; current code needs an explicit old-root override if you keep running it after rollback. Restart both services and verify again.

## Refusals and interruption

Held owner/lease/execution locks, live/malformed service PID markers, nonclosed/unreadable child observer slots, unsafe control/journal symlinks, ambiguous/no matching journals and malformed/unterminated/cyclic journal data refuse. These checks do not prove that every arbitrary detached process is gone; `--workers-finished` is the operator's explicit attestation. Never delete locks or mark child observations closed merely to bypass a refusal.

Before staging, the tool writes `.relocation-pending.json`. A partial failure retains evidence and prints the root/report paths plus **DO NOT RESTART**; there is no automatic recovery or inverse operation. Updated server/Discord startup refuses this marker, as does another relocation attempt. Inspect the report before any manual recovery. Older binaries do not know this guard: never downgrade/start them over an incomplete operation.

If the final report rename succeeds but the final directory sync fails, the command reports completed data promotion with uncertain final durability, points to the completed report, and explicitly says the pending interlock is absent. Keep services stopped and investigate that storage error; do not assume a protective marker still exists. File/directory fsyncs are attempted, not a hardware/power-loss guarantee.

## Validation

```sh
pdm run test
PI_RELOCATE_PACKAGE=/absolute/pi-package .venv/bin/python test/relocate_state_native_smoke.py
```

The native fixture covers branched/compacted context, newest-journal selection, UUID/original-byte preservation, sidecars, fresh Activity ownership, post-move work and reverse relocation, plus malformed-source refusal. An isolated second-account rehearsal also used the real server and stock Pi CLI before/after/rollback with three local scripted completions and networking blocked. It preserved prior model context, history, pins and mappings and verified both startup guards. No external provider calls or production cutover were performed.
