import discord
from discord.ext import tasks
import os
import httpx
import json
import tempfile
import atexit
import signal
import sys
import logging
from main import load_config, get_sessions_dir
import otel_setup

TOKEN = os.environ.get("DISCORD_BOT_TOKEN")

cfg, config_dir = load_config()

otel_setup.init_otel("limilink-discord", cfg)
if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor  # type: ignore

        HTTPXClientInstrumentor().instrument()
    except ImportError:
        pass

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


async def send_limilink_reply(channel, reply_text, session_id):
    session_path = os.path.join(sessions_dir, session_id)
    outbox_dir = os.path.join(session_path, "outbox")
    files = []
    file_paths = []
    if os.path.isdir(outbox_dir):
        for filename in sorted(os.listdir(outbox_dir)):
            file_path = os.path.join(outbox_dir, filename)
            if os.path.isfile(file_path):
                if os.path.getsize(file_path) < 25 * 1024 * 1024:
                    files.append(discord.File(file_path))
                    file_paths.append(file_path)
                else:
                    await channel.send(f"⚠️ File too large: `{filename}`")

    if len(reply_text) > 2000:
        chunks = [reply_text[i : i + 2000] for i in range(0, len(reply_text), 2000)]
        for i, chunk in enumerate(chunks):
            if i == len(chunks) - 1:
                await channel.send(chunk, files=files[:10])
            else:
                await channel.send(chunk)
    else:
        if not reply_text and files:
            await channel.send(files=files[:10])
        elif reply_text:
            await channel.send(reply_text, files=files[:10])

    for i in range(10, len(files), 10):
        await channel.send(files=files[i : i + 10])

    for f in files:
        f.close()
    for p in file_paths:
        try:
            os.remove(p)
        except Exception:
            pass


@tasks.loop(seconds=10.0)
async def poll_notifyme():
    for channel_id_str, session_id in list(channel_sessions.items()):
        try:
            async with httpx.AsyncClient() as http_client:
                poll_url = f"http://localhost:{port}/sessions/{session_id}/poll"
                response = await http_client.get(poll_url)
                if response.status_code == 200:
                    data = response.json()
                    messages = data.get("messages", [])
                    for msg in messages:
                        channel = client.get_channel(int(channel_id_str))
                        if channel:
                            await send_limilink_reply(channel, msg, session_id)
                        else:
                            logging.warning(
                                f"poll_notifyme: channel {channel_id_str} not in cache, "
                                f"dropping notification for session {session_id}"
                            )
        except Exception:
            logging.debug("poll_notifyme error", exc_info=True)


@client.event
async def on_ready():
    print(
        f"Limilink Discord Bot logged in as {client.user} connected to proxy on port {port}"
    )
    if not poll_notifyme.is_running():
        poll_notifyme.start()


@client.event
async def on_message(message):
    if message.author == client.user:
        return
    if not message.channel.name.startswith("limilink"):
        return

    channel_id_str = str(message.channel.id)

    if message.content.strip().startswith("!new"):
        parts = message.content.strip().split(maxsplit=1)
        agent_arg = parts[1].strip() if len(parts) > 1 else None

        # Ask the server to create a new session (server generates the ID)
        try:
            async with httpx.AsyncClient() as http_client:
                create_url = f"http://localhost:{port}/sessions"
                if agent_arg:
                    create_url += f"?agent={agent_arg}"
                create_resp = await http_client.post(create_url)
                if create_resp.status_code != 200:
                    detail = "Unknown error"
                    try:
                        detail = create_resp.json().get("detail", create_resp.text)
                    except Exception:
                        detail = create_resp.text
                    await message.channel.send(f"⚠️ Failed to create session: {detail}")
                    return
                new_session_id = create_resp.json()["session_id"]
        except Exception as e:
            await message.channel.send(f"⚠️ Error communicating with Limilink: {e}")
            return

        channel_sessions[channel_id_str] = new_session_id
        save_sessions()

        msg = f"🔄 Started a fresh Limilink session for this channel! (Session ID: `{new_session_id}`)"
        if agent_arg:
            msg += f"\n🤖 Agent: `{agent_arg}`"
        await message.channel.send(msg)
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
                await send_limilink_reply(message.channel, reply_text, session_id)
        except httpx.HTTPStatusError as e:
            error_detail = "Unknown error"
            try:
                error_detail = e.response.json().get("detail", str(e))
            except Exception:
                error_detail = str(e)

            error_msg = f"⚠️ **Error {e.response.status_code}**: {error_detail}"
            if len(error_msg) > 2000:
                error_msg = error_msg[:1996] + "..."
            await message.channel.send(error_msg)
        except Exception as e:
            error_msg = f"Error communicating with Limilink on port {port}: {e}"
            if len(error_msg) > 2000:
                error_msg = error_msg[:1996] + "..."
            await message.channel.send(error_msg)


if __name__ == "__main__":
    if TOKEN is None:
        logging.error(
            "Error: DISCORD_BOT_TOKEN environment variable or discord_bot_token in config.sxpb not set."
        )
        sys.exit(1)
    client.run(str(TOKEN))
