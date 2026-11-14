# Session-pinned images and audio

An assistant can publish a **copy** of a completed local image/audio file to the current session. The browser's **Pins** button opens a sidebar with previews, native audio controls and original-file download links, newest first. Pins survive source-file cleanup, browser reloads and service process restarts; they are not transient chat text or Discord outbox files.

```sh
./tool/share_media.py /path/to/picture.png
./tool/share_media.py /path/to/voice.mp3
# Explicit session / deliberate identity reuse:
./tool/share_media.py /path/to/voice.wav --session session_example \
  --publication-id 0123456789abcdef0123456789abcdef
```

The helper discovers the current session from `LIMILINK_SESSION`/session location and the local port from Limilink configuration. `--server` can select a different **loopback** API port for a local preview. It prints and flushes the publication ID and exact observation path **before transport**, streams the opened regular file once with its bounded Content-Length, and returns JSON with stable relative browser URLs. It never retries automatically. Publish a finished file, not one still being generated.

If a response is lost, inspect `GET /sessions/{sid}/media/{id}`. Same ID plus matching normalized name, detected type, size and SHA-256 observes the original pin; conflicting reuse rejects. A missing observation is not final while an earlier upload may still be committing. Do not silently select a new ID or resend automatically.

## Scope and privacy

- This is assistant-to-user publication, **not** a browser upload/model-input pipeline. Publishing does not call an agent, alter prompts/configuration/history or notify Discord. It works while the assistant's existing turn owns the execution fence. Upload/stream leases do count as broad session liveness, without blocking a new explicit chat. Known delivery work is labelled Running/Queued; a busy bit alone is labelled Session busy, not Thinking. The conservative lease probe still detects surviving/unfenced writers.
- Media is outside the static tree. **The routes have the same access perimeter as Limilink, not separate authentication or secret-link security.** Random IDs do not make links private. Fleet's intended deployment restricts its Tailscale forwarding to the configured laptop and phone; verify the actual perimeter before activation. Do not expose these unauthenticated routes publicly.
- Each session owns its shelf. Trash blocks new publication/reads; Undo restores it. Existing transfers hold deletion leases until completion/disconnect. Physical whole-session deletion reclaims pins and stages. Each pin has a confirmed Remove action that removes its published copy, not the original source file. There is no public-share-token feature.
- No Google Drive, external upload host, media generation, transcoding or provider calls are involved. URLs are relative to the existing Limilink origin, not the CLI's loopback hostname.

## Limits and formats

- 64 MiB per file (`64 * 1024**2` bytes), 512 MiB and 128 published items per session.
- Two simultaneous uploads per root owner, fail-fast when full; body streaming deadline 120 seconds. Streamed bytes are counted independently of declared length. Encoded bodies are rejected.
- Recognized headers: PNG, JPEG, GIF, WebP; MP3, WAV, Ogg audio, M4A/M4B audio containers and FLAC. SVG/HTML, generic video MP4/Ogg and unknown/truncated signatures are rejected. Very large MP3 metadata tags outside the bounded signature prefix are unsupported.
- Header recognition is **not full decoding, malware scanning or a codec guarantee**. Invalid/unsupported previews still offer original downloads. Browser/device codec support varies. Audio never autoplays, uses `preload="none"`, retains its existing node/time across shelf polls/appended pins, and stops when navigating away from its session.

## Storage and HTTP

Raw `PUT /sessions/{sid}/media/{32hexid}?filename={display_name}` stages bytes under a unique private directory, hashes/counts them and validates their recognized type. Filesystem names are fixed/generated, never derived from the display filename. Complete data/metadata are flushed before one short lifecycle/quota/identity-checked directory rename publishes the immutable pin. File/directory fsyncs are attempted before reporting success; this is not a promise of hardware/power-loss durability. An error after rename leaves the published pin intact and requires exact observation.

- `GET /sessions/{sid}/media`: `{revision, media}`; pass the previous `revision` to receive `{revision, unchanged:true}` when unchanged.
- `GET /sessions/{sid}/media/{id}`: `{media}` exact observation.
- `DELETE /sessions/{sid}/media/{id}`: removes a pin with a 204 response; repeated removal is safe. New reads return 404. Already-open transfers can finish. Small metadata tombstones prevent old uploads from resurrecting removed pins (PUT returns 410); publish deliberately again with a new ID. Removed copies no longer count against shelf limits.
- `GET`/`HEAD /sessions/{sid}/media/{id}/content`: controlled image/audio MIME, exact length, SHA-256 ETag, single byte ranges and safe inline disposition. Add `?download=1` for attachment disposition.
- GET handles `start-end`, `start-`, `-suffix` ranges, clamps end and returns 416 for unsatisfiable ranges. Malformed/multiple/overlong range headers are ignored with full 200; HEAD ignores Range. Matching If-None-Match yields 304; If-Range requires the exact strong ETag.
- API/content responses use private no-store and nosniff. No absolute storage paths, client-provided content URLs or secret environment values are returned.

Safe directory/file descriptors are opened component-by-component without symlink following. Already-open regular content FDs, the session lease and a duplicate of the current root-owner lock stay owned through the entire ASGI response, including setup/no-body/send-failure/disconnect paths. The API never overwrites a published pin. This is not a sandbox against a hostile process with the same filesystem UID.

Only complete published directories count as pins/quota. Ordinary failures remove only their own uncommitted stage. On the first upload for a session under a new root owner, abandoned stage directories are cleaned before new staging begins; active stages from that owner are never age-swept. Corrupt published metadata/data refuses service and new quota decisions rather than disappearing. Whole-session deletion also reclaims all storage.
