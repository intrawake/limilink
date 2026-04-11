---
name: notifyme
description: Use to send notifications to the user via Discord when long-running tasks, background jobs, or compilations finish in the limilink session workspace.
---

# Notifyme Skill

The `notifyme` tool allows a long-running process or background script to send a notification directly back to your Discord channel via the Limilink proxy. It's incredibly useful for alerting you when a slow compilation, massive test suite, or large download completes.

## How it works

The tool deduces the correct `session_id` automatically. It does this by traversing up the directory tree looking for a `.initialized` marker file, starting from:
1. **The Current Working Directory (`$PWD`)**: This means if you just run `notifyme` from anywhere within your session workspace, it works automatically.
2. **The Executable Path**: If you symlink the tool into a specific directory, it will resolve the session based on where that symlink is located.

## Usage

**Simple Notification**
```bash
notifyme "The task has finished successfully!"
```

**Piping Output**
You can pipe output directly into the tool, and it will read from `stdin`:
```bash
./run_tests.sh | notifyme
```

## Installation & Availability
Because the proxy can map external scripts into your session's `bin/` directory, `notifyme` can be made available right out of the box in every session without needing to do anything. Just type `bin/notifyme`!
