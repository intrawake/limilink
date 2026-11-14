# Continuing a paused session after an uncertain crash

A lost service can leave an agent alive or leave tool effects whose outcome is unknown. Limilink does not retry those operations or resume their queued followups. Queued work proved not to have started becomes `interrupted_not_started`; possibly started work remains `indeterminate`.

## Browser flow

1. Open the paused conversation and choose **Review paused session**.
2. If an earlier writer/activity still owns its execution fence or session lease, recovery is refused. Wait for its independently verified settlement. Recovery does not signal it or steal its locks.
3. Inspect the conversation, the listed uncertain operation IDs, any possible external effects and the displayed agent/model/reasoning settings.
4. Check the acknowledgement and choose **Allow new messages**. This acknowledges uncertainty, not successful completion or reversal of effects.
5. Send a **new** message explicitly. No saved message, staged followup or old operation ID is resent by recovery.

The earlier warning and saved text remain available. Unknown *acceptance* in this browser is a separate issue: check, restore or dismiss that saved entry explicitly. A server-acknowledged indeterminate operation no longer blocks a fresh click, but its outcome still remains unknown.

A changed review is rejected; review again. If the confirmation response is lost, nothing is automatically retried. Review again to observe the current state. The server retains the acknowledgement across a process restart. A new uncertainty pauses the lane again; replaying an old acknowledgement cannot clear it.

Malformed/unpersisted receipts, unreadable acknowledgement metadata, invalid history or inconsistent configuration/resources remain blocked with a reason. This feature does **not** repair them, reset settings or delete evidence. Such cases require separate diagnosis and repair; use a fresh session if appropriate.

## HTTP control

- `GET /sessions/{sid}/recovery`: inspect current state. A ready paused lane returns `token`, `uncertain_ids`, effective `configuration` and a warning. Readiness requires quiescence, valid evidence and nonblocking exclusive lifecycle/execution ownership.
- `POST /sessions/{sid}/recovery`: supply a fresh canonical 32-hex `request_id`, the reviewed 64-hex `token`, and literal boolean `acknowledge_possible_effects: true`.
- `GET /sessions/{sid}/recovery?request_id={id}`: observe a committed confirmation after response loss. The response separates the saved confirmation from current `recovery_required` state.
- Same ID/body POST observes the saved confirmation; conflicting reuse rejects. No automatic POST retries are needed.
- Operation collections expose `recovery_required` independently of their latest-64 terminal window, plus exact `(id, revision)` acknowledgement coverage. Operation state, outcome, message and execution identity never change merely because recovery was acknowledged.

The private per-session `.delivery-recovery.json` ledger stores exact uncertain receipt byte digests and immutable confirmation receipts. Do not edit or delete it to force admission. Original operation/legacy receipts remain authoritative for their unknown outcomes. No power-loss durability or exactly-once external effects are claimed.
