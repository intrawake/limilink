import discord
import os
import httpx
import json
import uuid
import tempfile
import atexit
import signal
import sys
from main import load_config, get_sessions_dir

TOKEN = os.environ.get("DISCORD_BOT_TOKEN")

cfg, config_dir = load_config()

port = 8000
if cfg:
    port = int(cfg.get("port", port))
    if TOKEN is None and "discord_bot_token" in cfg:
        TOKEN = str(cfg["discord_bot_token"])

sessions_dir = get_sessions_dir(cfg, config_dir)
os.makedirs(sessions_dir, exist_ok=True)

# PID file management
pid_file = os.path.join(sessions_dir, "bot.pid")
with open(pid_file, "w") as f:
    f.write(str(os.getpid()))


def cleanup():
    if os.path.exists(pid_file):
        os.remove(pid_file)


atexit.register(cleanup)


def signal_handler(signum, frame):
    cleanup()
    sys.exit(0)


signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

LIMILINK_URL = f"http://localhost:{port}/chat"
SESSION_TRACKER_FILE: str = os.path.join(sessions_dir, "channel_sessions.json")

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

if os.path.exists(SESSION_TRACKER_FILE):
    try:
        with open(SESSION_TRACKER_FILE, "r") as f:
            channel_sessions = json.load(f)
    except Exception:
        channel_sessions = {}
else:
    channel_sessions = {}


def save_sessions():
    """Atomically save the session mapping JSON."""
    dir_path = os.path.dirname(SESSION_TRACKER_FILE)
    if not dir_path:
        dir_path = "."
    os.makedirs(dir_path, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=dir_path, delete=False) as f:
        json.dump(channel_sessions, f)
        temp_name = f.name
    os.rename(temp_name, SESSION_TRACKER_FILE)


@client.event
async def on_ready():
    print(
        f"Limilink Discord Bot logged in as {client.user} connected to proxy on port {port}"
    )


@client.event
async def on_message(message):
    if message.author == client.user:
        return
    if not message.channel.name.startswith("limilink"):
        return

    channel_id_str = str(message.channel.id)

    if message.content.strip() == "!new":
        new_session_id = f"discord_channel_{channel_id_str}_{uuid.uuid4().hex[:8]}"
        channel_sessions[channel_id_str] = new_session_id
        save_sessions()
        await message.channel.send(
            f"🔄 Started a fresh Limilink session for this channel! (Session ID: `{new_session_id}`)"
        )
        return

    if channel_id_str not in channel_sessions:
        channel_sessions[channel_id_str] = f"discord_channel_{channel_id_str}_default"
        save_sessions()

    session_id = channel_sessions[channel_id_str]

    async with message.channel.typing():
        try:
            async with httpx.AsyncClient(timeout=None) as http_client:
                payload = {"message": message.content, "session_id": session_id}
                response = await http_client.post(LIMILINK_URL, json=payload)
                response.raise_for_status()

                data = response.json()
                reply_text = data.get("reply", "No reply received from Limilink.")

                # Check for files in the session outbox
                session_path = os.path.join(sessions_dir, session_id)
                outbox_dir = os.path.join(session_path, "outbox")
                files = []
                file_paths = []
                if os.path.isdir(outbox_dir):
                    for filename in sorted(os.listdir(outbox_dir)):
                        file_path = os.path.join(outbox_dir, filename)
                        if os.path.isfile(file_path):
                            # Discord file size limit is typically 25MB for free users
                            if os.path.getsize(file_path) < 25 * 1024 * 1024:
                                files.append(discord.File(file_path))
                                file_paths.append(file_path)
                            else:
                                await message.channel.send(
                                    f"⚠️ File too large: `{filename}`"
                                )

                if len(reply_text) > 2000:
                    chunks = [
                        reply_text[i : i + 2000]
                        for i in range(0, len(reply_text), 2000)
                    ]
                    for i, chunk in enumerate(chunks):
                        if i == len(chunks) - 1:
                            await message.channel.send(chunk, files=files[:10])
                        else:
                            await message.channel.send(chunk)
                else:
                    await message.channel.send(reply_text, files=files[:10])

                # Send remaining files if more than 10
                for i in range(10, len(files), 10):
                    await message.channel.send(files=files[i : i + 10])

                # Clean up
                for f in files:
                    f.close()
                for p in file_paths:
                    try:
                        os.remove(p)
                    except Exception:
                        pass
        except Exception as e:
            await message.channel.send(
                f"Error communicating with Limilink on port {port}: {e}"
            )


if __name__ == "__main__":
    if TOKEN is None:
        print(
            "Error: DISCORD_BOT_TOKEN environment variable or discord_bot_token in config.sxpb not set."
        )
        sys.exit(1)
    client.run(str(TOKEN))
