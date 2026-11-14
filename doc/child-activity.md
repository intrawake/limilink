# Child Activity

Activity enriches existing SDK child-session cards. Role metadata never creates another card or changes child lifecycle, chat, drafts or Send admission.

- Models come from the child's own selected model and response events. Thinking is the child's selected runtime level, not proof of provider execution.
- Role names are explicit launch associations: public foreground results or an announced background run's status must name both agent and absolute session file. The private file-key match must identify exactly one observed file/UUID session. Missing or contradictory evidence stays generic; header ancestry, labels, timing and opaque fleet keys are not role evidence.
- Progress is the first line of a successful `contact_supervisor` `progress_update`, normalized and capped at 280 Unicode characters. Its timestamp is when that report was observed, never the latest heartbeat. The most recent 256 callback IDs are deduplicated; newer reports continue beyond that window. A replacement observer does not inherit an older observer's report.

Progress is intentionally content-bearing. It may include a path or other sensitive text the child explicitly reported; display escaping is not secret redaction. General tool arguments/results, tasks, goals, assistant text and decision/interview requests are not exported.

## Bounds and recovery

Child collectors share the existing private family transport: at most 128 fixed slots, each at most 8 KiB with a 12-event tail and 16 role facts. The root retains at most 256 role facts privately, including conflict/limit evidence, across ordinary per-turn process recreation. Role uncertainty is monotonic: losing a collector or crossing a limit cannot silently turn a conflict into a named role. A closed source carrying role evidence is reclaimed only after the aggregate ledger has been successfully persisted; a failed write leaves that source available to the next process.

Background role reads use only `status.json` in directories explicitly named by an originating tool receipt or a session-owned `subagent:async-started` event. Reads use the existing heartbeat, require an owned/non-writable-by-others directory and regular no-follow file, check run/session identity and artifact version 3, and cap reads at 256 KiB/64 steps. There is no directory scan or historical-run discovery. A launch missed before observer setup can remain generic.

The browser receives only role, thinking and progress fields, not session paths, private keys or correlation records. Python validates the display schema independently. New fields require a server restart and new Pi observer runtimes to activate; restart is an explicit operator action.

## Verification

- `pdm run test` runs Python and Node regressions.
- `test/activity_sessions_browser.js` covers roles, progress, text injection, geometry and desktop/phone behavior against the disposable sidebar preview.
- `PI_PROOF_NPM_ROOT=/absolute/node_modules node test/activity_sessions_native_smoke.mjs` is an opt-in installed-stock SDK test pinned to pi-subagents 0.88.0. It uses scripted local responses and blocks network connections; it is not an LLM test.

Click-to-inspect transcripts/output is deferred to the persistent-RPC migration, not implemented by this observer.
