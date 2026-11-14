"""Read one invocation's Pi JSONL output, not its persisted conversation."""

import json


class PiResponseError(ValueError):
    """JSON mode reports provider failures as events even when the process exits 0."""

    def __init__(self, error_message: object) -> None:
        super().__init__("Pi reported a failed assistant response.")
        self.error_message = (
            error_message if isinstance(error_message, str) else "Request failed"
        )


def pi_json_reply(stdout: bytes) -> str:
    """Select the latest settled assistant reply, allowing trailing custom notices.

    Never use deltas, tool results, thinking or old session files as a reply.
    A later agent run invalidates an earlier reply until it settles successfully.
    """
    if stdout and not stdout.endswith(b"\n"):
        raise ValueError("Incomplete Pi JSON output.")
    assistant = None
    settled = False
    aborted = False
    for line in stdout.split(b"\n"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError) as error:
            raise ValueError("Invalid Pi JSON output.") from error
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            raise ValueError("Invalid Pi JSON event.")
        kind = event["type"]
        if kind == "agent_start":
            assistant = None
            settled = False
            aborted = False
        elif kind == "message_end":
            message = event.get("message")
            if isinstance(message, dict) and message.get("role") == "assistant":
                assistant = message
                settled = False
        elif kind == "agent_settled":
            settled = True
            aborted = event.get("aborted") is not False

    if assistant is None:
        return ""
    if settled and not aborted and assistant.get("stopReason") == "error":
        raise PiResponseError(assistant.get("errorMessage"))
    if not settled or aborted or assistant.get("stopReason") != "stop":
        raise ValueError("Pi did not produce a successful settled assistant reply.")
    content = assistant.get("content")
    if not isinstance(content, list):
        raise ValueError("Invalid Pi assistant content.")
    texts = []
    for block in content:
        if not isinstance(block, dict):
            raise ValueError("Invalid Pi assistant content block.")
        if block.get("type") == "text":
            if not isinstance(block.get("text"), str):
                raise ValueError("Invalid Pi assistant text.")
            texts.append(block["text"])
    return "\n".join(texts).strip()
