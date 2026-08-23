import asyncio
import json
import os
import shutil
import socket
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from unittest.mock import call as mock_call

import aiohttp
import discord
import discord.http

# Mock discord BEFORE importing the bot
mock_client = MagicMock()
mock_client.event = lambda func: func  # Return the original function

with patch("discord.Client", return_value=mock_client):
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

    def test_login_retries_outage_before_connecting(self):
        async def run_test():
            real_client = discord.Client(intents=discord.Intents.none())
            dns_error = aiohttp.ClientConnectorDNSError(
                MagicMock(), socket.gaierror(socket.EAI_AGAIN, "Try again")
            )
            errors = [
                dns_error,
                aiohttp.ClientConnectionError("Connection lost"),
                TimeoutError(),
                aiohttp.ClientPayloadError("Incomplete response"),
                discord.HTTPException(MagicMock(status=503), "Unavailable"),
                *[dns_error for _ in range(5)],
            ]
            clients = [real_client]
            create_client = bot.create_client

            def next_client():
                self.assertTrue(clients[-1].is_closed())
                clients.append(create_client())
                return clients[-1]

            with (
                patch.object(bot, "client", real_client),
                patch.object(bot, "create_client", side_effect=next_client),
                patch.object(
                    discord.Client, "login", side_effect=[*errors, None]
                ) as login,
                patch.object(discord.Client, "connect") as connect,
                patch.object(bot.asyncio, "sleep", new_callable=AsyncMock) as sleep,
            ):

                async def check_connect(**kwargs):
                    self.assertEqual(login.await_count, len(errors) + 1)

                connect.side_effect = check_connect
                await bot.run_bot("test-token")
                self.assertEqual(login.await_args_list, [mock_call("test-token")] * 11)
                self.assertEqual(
                    sleep.await_args_list,
                    [
                        mock_call(delay)
                        for delay in (1, 2, 4, 8, 16, 32, 60, 60, 60, 60)
                    ],
                )
                connect.assert_awaited_once_with(reconnect=True)
                self.assertEqual(len(clients), 11)
                self.assertTrue(all(client.is_closed() for client in clients))

        asyncio.run(run_test())

    def test_real_login_closes_sessions_and_recreates_connectors(self):
        async def run_test():
            sessions = []
            connectors = []
            client_session = aiohttp.ClientSession

            def new_session(*args, **kwargs):
                self.assertTrue(all(session.closed for session in sessions))
                self.assertFalse(kwargs["connector"].closed)
                session = client_session(*args, **kwargs)
                sessions.append(session)
                connectors.append(kwargs["connector"])
                return session

            async def check_backoff(delay):
                self.assertTrue(all(session.closed for session in sessions))

            async def check_connect(**kwargs):
                self.assertFalse(sessions[-1].closed)
                self.assertFalse(sessions[-1].connector.closed)
                for event in (
                    bot.on_disconnect,
                    bot.on_connect,
                    bot.on_resumed,
                    bot.on_ready,
                    bot.on_message,
                ):
                    self.assertIs(getattr(bot.client, event.__name__), event)
                self.assertTrue(bot.client.intents.message_content)

            dns_error = aiohttp.ClientConnectorDNSError(
                MagicMock(), socket.gaierror(socket.EAI_AGAIN, "Try again")
            )
            user = {
                "id": "123",
                "username": "test",
                "discriminator": "0",
                "avatar": None,
            }
            application = MagicMock(interactions_endpoint_url=None, id=456)
            with (
                patch.object(bot, "client", bot.create_client()),
                patch.object(aiohttp, "ClientSession", side_effect=new_session),
                patch.object(
                    discord.http.HTTPClient,
                    "request",
                    new_callable=AsyncMock,
                    side_effect=[dns_error, user, user],
                ) as request,
                patch.object(
                    discord.Client,
                    "application_info",
                    side_effect=[dns_error, application],
                ),
                patch.object(
                    discord.Client, "connect", side_effect=check_connect
                ) as connect,
                patch.object(bot.asyncio, "sleep", side_effect=check_backoff) as sleep,
            ):
                await bot.run_bot("test-token")
                self.assertEqual(request.await_count, 3)
                self.assertEqual(len(sessions), 3)
                self.assertTrue(all(session.closed for session in sessions))
                self.assertTrue(all(connector.closed for connector in connectors))
                self.assertTrue(bot.client.is_closed())
                self.assertEqual(sleep.await_args_list, [mock_call(1), mock_call(2)])
                connect.assert_awaited_once_with(reconnect=True)

        asyncio.run(run_test())

    def test_login_permanent_errors_and_cancellation_propagate(self):
        async def run_test():
            for error in (
                discord.LoginFailure("Invalid token"),
                discord.HTTPException(MagicMock(status=403), "Forbidden"),
                ValueError("Programming error"),
                asyncio.CancelledError(),
            ):
                with self.subTest(error=type(error).__name__):
                    real_client = discord.Client(intents=discord.Intents.none())
                    with (
                        patch.object(bot, "client", real_client),
                        patch.object(real_client, "login", side_effect=error) as login,
                        patch.object(real_client, "connect") as connect,
                        patch.object(
                            bot.asyncio, "sleep", new_callable=AsyncMock
                        ) as sleep,
                        self.assertRaises(type(error)),
                    ):
                        await bot.run_bot("test-token")
                    login.assert_awaited_once_with("test-token")
                    sleep.assert_not_awaited()
                    connect.assert_not_awaited()
                    self.assertTrue(real_client.is_closed())

        asyncio.run(run_test())

    def test_cancellation_during_login_backoff_closes_client(self):
        async def run_test():
            real_client = discord.Client(intents=discord.Intents.none())
            with (
                patch.object(bot, "client", real_client),
                patch.object(real_client, "login", side_effect=TimeoutError()) as login,
                patch.object(real_client, "connect") as connect,
                patch.object(
                    bot.asyncio, "sleep", side_effect=asyncio.CancelledError()
                ),
                self.assertRaises(asyncio.CancelledError),
            ):
                await bot.run_bot("test-token")
            login.assert_awaited_once_with("test-token")
            connect.assert_not_awaited()
            self.assertTrue(real_client.is_closed())

        asyncio.run(run_test())

    def test_successful_login_does_not_retry_gateway_errors(self):
        async def run_test():
            real_client = discord.Client(intents=discord.Intents.none())
            with (
                patch.object(bot, "client", real_client),
                patch.object(real_client, "login") as login,
                patch.object(
                    real_client, "connect", side_effect=RuntimeError("Gateway")
                ),
                patch.object(bot.asyncio, "sleep", new_callable=AsyncMock) as sleep,
                self.assertRaisesRegex(RuntimeError, "Gateway"),
            ):
                await bot.run_bot("test-token")
            login.assert_awaited_once_with("test-token")
            sleep.assert_not_awaited()
            self.assertTrue(real_client.is_closed())

        asyncio.run(run_test())

    def test_save_sessions_atomic(self):
        bot.channel_sessions = {"123": "session_123"}
        bot.save_sessions()

        self.assertTrue(os.path.exists(bot.SESSION_TRACKER_FILE))
        with open(bot.SESSION_TRACKER_FILE, "r") as f:
            data = json.load(f)
        self.assertEqual(data["123"], "session_123")

    def test_persistent_gateway_outage_restarts_process(self):
        async def run_test():
            bot._gateway_watchdog_task = None
            with (
                patch.object(bot, "RECONNECT_WATCHDOG_SECONDS", 0),
                patch.object(bot, "restart_process") as mock_restart,
            ):
                await bot.on_disconnect()
                watchdog = bot._gateway_watchdog_task
                assert watchdog is not None
                await watchdog
                mock_restart.assert_called_once_with()

        asyncio.run(run_test())

    def test_gateway_recovery_cancels_restart(self):
        async def run_test():
            for recovery_event in (bot.on_connect, bot.on_resumed):
                bot._gateway_watchdog_task = None
                with (
                    patch.object(bot, "RECONNECT_WATCHDOG_SECONDS", 60),
                    patch.object(bot, "restart_process") as mock_restart,
                ):
                    await bot.on_disconnect()
                    watchdog = bot._gateway_watchdog_task
                    assert watchdog is not None
                    await recovery_event()
                    self.assertTrue(watchdog.cancelled())
                    mock_restart.assert_not_called()

        asyncio.run(run_test())

    def test_reconnect_watchdog_seconds_must_be_positive_and_finite(self):
        self.assertEqual(bot.parse_reconnect_watchdog_seconds("12.5"), 12.5)
        for value in ("bad", "0", "-1", "nan", "inf", "-inf"):
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "must be a positive number"),
            ):
                bot.parse_reconnect_watchdog_seconds(value)

    @patch("demo.discord_bot.os.execv")
    @patch("demo.discord_bot.logging.shutdown")
    def test_restart_process_reexecutes_python(self, mock_shutdown, mock_execv):
        bot.restart_process()

        mock_shutdown.assert_called_once_with()
        mock_execv.assert_called_once_with(sys.executable, [sys.executable, *sys.argv])

    @patch("demo.discord_bot.httpx.AsyncClient")
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

    @patch("demo.discord_bot.httpx.AsyncClient")
    @patch("discord.File")
    def test_error_propagation(self, mock_file_class, mock_async_client_class):
        # Setup a mock session
        session_id = "test_session_error"

        # Mock discord objects
        mock_message = MagicMock()
        mock_message.author = MagicMock()
        mock_message.author.id = 456
        mock_user = MagicMock()
        mock_user.id = 789
        type(bot.client).user = mock_user

        mock_message.channel.id = 123
        mock_message.channel.name = "limilink-test"
        mock_message.content = "hello error"
        mock_message.channel.send = AsyncMock()

        mock_typing = MagicMock()
        mock_typing.__aenter__ = AsyncMock()
        mock_typing.__aexit__ = AsyncMock()
        mock_message.channel.typing.return_value = mock_typing

        bot.channel_sessions = {"123": session_id}

        # Mock the HTTP response to raise HTTPStatusError
        mock_client_instance = mock_async_client_class.return_value
        mock_client_instance.__aenter__.return_value = mock_client_instance

        import demo.discord_bot as db

        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.json.return_value = {"detail": "Agent harness failed: some error"}

        mock_error = db.httpx.HTTPStatusError(
            message="Server Error", request=MagicMock(), response=mock_response
        )
        mock_response.raise_for_status = MagicMock(side_effect=mock_error)
        mock_client_instance.post = AsyncMock(return_value=mock_response)

        async def run_test():
            await bot.on_message(mock_message)

            # Verify the error message was sent
            mock_message.channel.send.assert_called()

            found_error_msg = False
            for call in mock_message.channel.send.call_args_list:
                args, _ = call
                if (
                    len(args) > 0
                    and "⚠️ **Error 500**: Agent harness failed: some error" in args[0]
                ):
                    found_error_msg = True
            self.assertTrue(found_error_msg)

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
