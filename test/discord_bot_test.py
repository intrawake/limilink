import os
import json
import shutil
import tempfile
import unittest
from unittest.mock import patch, MagicMock, AsyncMock
import asyncio

# Mock discord BEFORE importing the bot
mock_client = MagicMock()
mock_client.event = lambda func: func  # Return the original function

with patch("discord.Client", return_value=mock_client), patch("discord.Intents"):
    import demo.discord_bot as bot


class TestDiscordBot(unittest.TestCase):
    def setUp(self):
        # Create a temporary directory for tests
        self.test_dir = tempfile.mkdtemp()
        self.old_cwd = os.getcwd()
        os.chdir(self.test_dir)

        # Override session-related paths in the bot module
        bot.sessions_dir = os.path.join(self.test_dir, "session")
        os.makedirs(bot.sessions_dir, exist_ok=True)
        bot.SESSION_TRACKER_FILE = os.path.join(self.test_dir, "channel_sessions.json")
        bot.channel_sessions = {}
        bot.client = mock_client

    def tearDown(self):
        os.chdir(self.old_cwd)
        shutil.rmtree(self.test_dir)

    def test_save_sessions_atomic(self):
        bot.channel_sessions = {"123": "session_123"}
        bot.save_sessions()

        self.assertTrue(os.path.exists(bot.SESSION_TRACKER_FILE))
        with open(bot.SESSION_TRACKER_FILE, "r") as f:
            data = json.load(f)
        self.assertEqual(data["123"], "session_123")

    @patch("httpx.AsyncClient")
    @patch("discord.File")
    def test_outbox_processing(self, mock_file_class, mock_async_client_class):
        # Setup a mock session and outbox
        session_id = "test_session"
        session_path = os.path.join(bot.sessions_dir, session_id)
        outbox_path = os.path.join(session_path, "outbox")
        os.makedirs(outbox_path, exist_ok=True)

        test_file = os.path.join(outbox_path, "test.txt")
        with open(test_file, "w") as f:
            f.write("test content")

        # Mock discord objects
        mock_message = MagicMock()
        mock_message.author = MagicMock()
        mock_message.author.id = 456
        # Use setattr to bypass static type checking if needed, or just let it be
        # bot.client is mock_client
        mock_user = MagicMock()
        mock_user.id = 789
        type(bot.client).user = mock_user

        mock_message.channel.id = 123
        mock_message.channel.name = "limilink-test"
        mock_message.content = "hello"
        mock_message.channel.send = AsyncMock()

        # Mock typing context manager
        mock_typing = MagicMock()
        mock_typing.__aenter__ = AsyncMock()
        mock_typing.__aexit__ = AsyncMock()
        mock_message.channel.typing.return_value = mock_typing

        bot.channel_sessions = {"123": session_id}

        # Mock the HTTP response
        mock_client_instance = mock_async_client_class.return_value
        mock_client_instance.__aenter__.return_value = mock_client_instance

        mock_response = MagicMock()
        mock_response.json.return_value = {"reply": "Hi there!"}
        mock_response.raise_for_status = MagicMock()
        mock_client_instance.post = AsyncMock(return_value=mock_response)

        async def run_test():
            await bot.on_message(mock_message)

            # Verify message was sent with files
            mock_message.channel.send.assert_called()
            # Find the call that sent the reply
            found_reply = False
            for call in mock_message.channel.send.call_args_list:
                args, kwargs = call
                if len(args) > 0 and args[0] == "Hi there!":
                    found_reply = True
                    self.assertIn("files", kwargs)
                    self.assertEqual(len(kwargs["files"]), 1)
            self.assertTrue(found_reply)

            # Verify file was cleaned up
            self.assertFalse(os.path.exists(test_file))

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
