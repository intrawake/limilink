# limilink_continue_after 🚀

A robust wrapper tool for executing long-running commands and notifying the current Limilink session upon completion.

## Features

- **Asynchronous Notifications**: Sends a Discord notification via `notifyme` once the wrapped command finishes.
- **Automatic Backgrounding**: If the command takes longer than a specified delay, the tool backgrounds itself, returning control to the terminal while continuing to monitor the task.
- **I/O Redirection**: Built-in support for redirecting stdin, stdout, and stderr to files, ensuring output is captured even when backgrounded.
- **Fail-Fast Monitoring**: Waits for an initial period to catch immediate failures (e.g., command not found) before detaching.

## Usage

```bash
limilink_continue_after [FLAGS] -- <command> [args...]
```

### Flags

- `--delay <seconds>`: How long to wait in the foreground before backgrounding. Default is `5.0`.
- `--stdin <path>`: File to read stdin from. Defaults to `/dev/null`.
- `--stdout <path>`: File to append stdout to. Defaults to `/dev/null`.
- `--stderr <path>`: File to append stderr to. Defaults to the same file as `--stdout`.

### Example

Run a game server and capture logs while backgrounding after 2 seconds:

```bash
limilink_continue_after --delay 2 --stdout game.log --stderr game.log -- \
  pdm run server --game mafia --players players.sxpb
```

## How it Works

1. **Fork & Spawn**: The tool forks a monitor process which spawns the target command as a subprocess.
2. **Initial Wait**: The parent process waits for up to `--delay` seconds.
3. **Early Exit**: If the command finishes within the delay, the tool exits with the command's exit code.
4. **Detachment**: If the command is still running after the delay, the parent process exits with `0`, leaving the monitor process to wait in the background.
5. **Notification**: Once the command completes, the monitor process sends a notification (e.g., `[✅ Case Closed]`) to the Discord session and exits.
