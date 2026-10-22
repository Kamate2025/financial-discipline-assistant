# FD local operation and production preparation

FD has a Django API at the repository root and a TypeScript WhatsApp bridge in `whatsapp-service/`. Run one bridge process per WhatsApp session. The bridge stores linked-device credentials under `whatsapp-service/whatsapp-session/` when started from its package directory.

## Requirements and configuration

- Python 3.11 or newer and Node.js 20 or newer.
- A repository-root `.env` based on `.env.example`.
- A WhatsApp account for device linking.

Set `DJANGO_SECRET_KEY`, `DJANGO_DEBUG`, `DJANGO_ALLOWED_HOSTS`, `DJANGO_SERVICE_KEY`, and `DJANGO_BASE_URL`. Use the same strong, private `DJANGO_SERVICE_KEY` for Django and the bridge. Local `DJANGO_BASE_URL` is `http://127.0.0.1:8000`. Never copy real credentials into source files or commit `.env` or session files. `.gitignore` excludes both and the generated `dist/` output.

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the repository-root `.env` for natural-language interpretation. Model listing is available through `npm.cmd run gemini:models` and only shows models the configured key reports as supporting `generateContent`. This local key successfully generated a structured response with `gemini-3.5-flash`; `gemini-2.5-flash` was listed but returned HTTP 404 on generation, so it is not the configured model. Verify with `npm.cmd run gemini:test`; the command sends only the harmless text `Hello FD.` and prints the validated intent, never the key or response body.

## Start locally on Windows

Open two PowerShell terminals. In the first, from the repository root:

```powershell
cd C:\kd\Projects\fd
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py runserver 127.0.0.1:8000
```

Check Django at `http://127.0.0.1:8000/api/v1/health/`; it should return HTTP 200. In the second terminal:

```powershell
cd C:\kd\Projects\fd\whatsapp-service
npm.cmd ci
npm.cmd run build
npm.cmd start
```

`npm.cmd` avoids PowerShell's script execution policy blocking `npm.ps1`. The service performs one backend health check at startup and continues if Django is temporarily unreachable. It reads the root `.env`. Pair a new account by scanning the terminal QR code in WhatsApp > Linked Devices > Link a device. A valid existing session is reused.

To stop the bridge, press Ctrl+C. It clears scheduled reconnects and closes its current socket. Do not run two bridge instances with the same session directory.

## Message and identity behavior

Baileys 6.7.24 emits incoming messages; the bridge accepts text, extended text, and image captions, ignores self messages, handles simple greetings/help/name updates deterministically, and uses Gemini for ambiguous natural-language requests. Gemini receives only the current message and a minimal classification prompt, without sender phone, profile, or transaction history. Its validated output can request expense, income, transfer, summary, clarification, or supported deterministic responses; Django remains responsible for authentication, validation, transaction persistence, and summaries. Affordability advice is explicitly unsupported. Incoming one-to-one messages are processed only after resolving a verified phone JID. Baileys 6.7.24 provides `WAMessageKey.senderPn`/`senderLid` when supplied by the stanza and the `chats.phoneNumberShare` event (`lid` plus `jid`). FD validates these values and keeps explicit phone-share mappings in memory for the current process. A LID's numeric local part is never treated as a phone number. Groups and broadcasts are ignored. If no verified mapping exists, FD logs whether an alternate phone field and mapping store were available, then skips the message without accessing a profile or transaction. When a PN is present, FD uses the PN JID for identity and reply. When identity comes from a prior phone-number-share mapping, FD uses the mapped PN for Django identity and the original LID for the reply recipient. The mapping cache is in-memory and is rebuilt by new phone-number-share events; Baileys 6.7.24 does not expose a persistent contact LID mapping store in its public auth-store API.

For a new phone, `Hello` starts onboarding. A name entered while FD is waiting (including a bare name such as `Kamate`) is saved deterministically through `/api/v1/onboarding/`; Gemini is not required. `Call me ...` and `My name is ...` also work. The API requires the service key, creates a Django user with an unusable password, and associates a normalized phone profile. A transaction cannot proceed until the profile is saved. `Ok`, `Thanks`, and similar acknowledgements receive a short conversational response; while onboarding is incomplete, FD repeats the name request.

## Connection recovery and diagnostics

- `open` means the socket is ready. Replies are skipped while it is closed.
- Baileys `515` (`restartRequired`) causes the old socket to be replaced immediately with a fresh socket using the persisted credentials.
- `401` is treated as logged out. Status `440` (`connectionReplaced`) stops automatic reconnects; repeated retries can create a rapid session-takeover loop. Check for another bridge process or competing linked-device session before restarting. Status 500, including the historical `xml-not-well-formed` event, is not by itself proof that credentials were revoked; other recoverable disconnects use bounded exponential backoff. No session files are removed automatically.
- Outbound send failures and inbound handler failures are caught. The sanitized Baileys logger includes error class/status and bounded stack frames while omitting raw nodes, error messages, and credentials.
- If Baileys reports `failed to find key ... to decode patch`, version 6.7.24's `decodeSyncdPatch` source shows a missing app-state sync key causes a 404 Boom error during synchronization. This establishes that the sync key was unavailable to that decode attempt; it does not establish why it was missing or that this caused the later disconnect. This project does not suppress that error or modify Baileys synchronization state.
- Transaction writes include the stable WhatsApp message ID in `X-WhatsApp-Message-ID`. Django stores that ID with the transaction in the same database transaction, so redelivery after a bridge restart returns the existing transaction instead of creating another. IDs are globally unique in `ProcessedMessage`; reusing an ID for a different user's request returns 409 without exposing the saved transaction. This covers transaction creation; greetings, summaries, and profile changes still use bridge-process deduplication only. A failed reply after a successful write can be safely retried with the same message ID.
- `messages.upsert` logs whether usable decrypted content was present, the message type, and whether dispatch proceeded. Ciphertext stubs are logged as received-but-not-decrypted; unsupported decrypted message types are logged separately. `messages.update` and history-sync events are observed without payloads. Baileys `useMultiFileAuthState` persists `creds.update` to `creds.json` and Signal/app-state writes through `state.keys.set()` to the session directory.

`/api/v1/health/` reports Django health only. It is not a WhatsApp readiness check. The bridge currently has no separate HTTP readiness endpoint.

## Troubleshooting

- If port 8000 is occupied, stop the other local Django process or choose a different port and update `DJANGO_BASE_URL` to match.
- For backend HTTP 401/403 responses, verify the shared service key and confirm the sender has completed onboarding. Only Django's exact `Unknown WhatsApp phone number` response is classified as an unknown profile; invalid service credentials are reported as an authentication/configuration issue. Never include the key in diagnostic output.
- If a backend request times out (the bridge client timeout is 10 seconds), check Django health, API logs, and database responsiveness. The bridge does not automatically retry a timed-out transaction request; check whether a record was created before resending to avoid duplicates.
- A WhatsApp send error with status 428 means the socket is closed. Wait for `open`; replies are skipped while the bridge is reconnecting.
- If the bridge reports a `440` connection conflict, stop other bridge processes and check for a competing linked-device connection before restarting. A status 401 is the explicit logged-out signal; do not delete session data for a generic 500 or stream error.
- For a TypeScript error, run `npm.cmd ci` and `npm.cmd run build` from `whatsapp-service/`. `npm.cmd start` executes `dist/index.js`, so rebuild after changing TypeScript source.

## Checks and tests

Run Django checks and tests from the repository root:

```powershell
.\.venv\Scripts\python.exe manage.py check
.\.venv\Scripts\python.exe manage.py test
```

Run bridge build and tests from `whatsapp-service/`:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run gemini:models
npm.cmd run gemini:test
```

The Node tests use mocked Gemini calls and local helpers; they do not call Google or connect to WhatsApp. `gemini:models` and `gemini:test` do make real Google API calls. Django tests use Django's test database and do not connect to a live WhatsApp account. A passing build, model test, or unit test does not confirm delivery of a real WhatsApp reply.

## Production preparation

Implemented protections include environment-based secrets, ignored environment/session files, startup config validation, the service-key protected onboarding API, status-aware reconnects with a finite retry limit, safe closed-socket handling, sanitized Baileys log contexts, and tests for disconnect classification and JID filtering.

Before production deployment:

1. Set `DJANGO_DEBUG=False`, a unique `DJANGO_SECRET_KEY`, a strong shared `DJANGO_SERVICE_KEY`, and exact production `DJANGO_ALLOWED_HOSTS` values. Keep `.env` readable only by the service account; use a managed secret store where available.
2. Deploy Django with a production WSGI/ASGI server behind HTTPS and a production database. This repository currently configures SQLite; production database configuration and migration are not implemented here.
3. Build the bridge with `npm ci` and `npm run build`, then run `npm start` under a Windows service/process supervisor configured to restart after an operator-reviewed failure. The bridge stops after eight recoverable failures and stops immediately on a 440 session conflict or 401 logged-out state.
4. Persist and restrict access to the complete `whatsapp-session/` directory. Back it up only to an encrypted, access-controlled location; restoring it creates a second credential copy, so ensure the old process is stopped before starting the restored session. Do not put it in Git or ordinary logs.
5. Run exactly one bridge process per session directory. Monitor Django health and bridge logs separately; an open WhatsApp connection is the bridge's readiness signal. Keep system time synchronized and verify outbound network access to WhatsApp and Django.
6. After deployment, verify with a designated test account: send `Hello`, provide a name, confirm profile creation in Django, record a test transaction, request a summary, and confirm each actual reply.

Process supervision, production database setup, HTTPS deployment, and live acceptance are deployment tasks; this repository does not configure them.

## Verified fixes and limitations

- The bridge previously treated status 500 as a revoked session. It now reserves the logged-out state for 401 and retries other statuses within the bounded policy. Baileys also defines 500 as `badSession`, so a persistent 500 still requires investigation; it is deliberately not claimed to be solved by re-pairing.
- Restart-required 515 previously only scheduled reconnect behavior without a fully guarded lifecycle. It now closes the old socket and constructs a replacement; this is covered by status/helper tests, not a live WhatsApp test.
- Incoming event exceptions could escape an async event listener. They are now caught and reported without dumping message objects. Raw Baileys protocol nodes are redacted by omission, which limits investigation of internal decoder failures.
- Baileys 6.7.24's installed type declarations define `senderPn`, `senderLid`, `participantPn`, and `participantLid` on `WAMessageKey`; the event declarations define `chats.phoneNumberShare`. The receive decoder populates those key fields from stanza attributes and emits the phone-share event when a sender shares their phone number. The old filter only checked `remoteJidAlt` and `remoteJid`, which missed `senderPn` and caused valid LID messages to be dropped. The bridge now consumes v6 fields and the explicit share event. It does not rely on v7-only APIs.
- The public auth state has credentials and signal keys but no LID-to-PN mapping API. The explicit share event is cached in memory. LIDs without `senderPn` or a previously observed phone-share mapping remain safely unresolved.
- The latest live run resolved one private message through `senderPn` and Baileys accepted a reply on the phone-JID route. The log intentionally omitted the message body, so that event could not be assigned to a particular test prompt or onboarding branch. Repeated 440 `connectionReplaced` conflicts then led to a 401 logged-out state. The bridge now stops on 440 instead of repeatedly reconnecting; the existing auth directory was not changed or deleted.
- The prior live onboarding stopped before a profile was saved. The local Django database currently has no profile for the test sender, consistent with the later authentication failure. A deterministic name-response branch now saves names without Gemini, but live onboarding and transaction persistence still need to be repeated after the WhatsApp session is relinked.
- The previous development Gemini credential was exposed and has been disabled in the local `.env`. Configure a replacement key locally before running Gemini live tests; do not paste it into chat or commit it.
- The missing sync-key patch error is inside Baileys' app-state patch decoder. The available source identifies the immediate missing-key condition, but cannot determine whether the cause is stale/incomplete sync state, a protocol issue, or another failure. No causal link to the reported stream error is established.
- One incoming identity resolution and Baileys-accepted reply were observed live, but the complete onboarding, transaction, acknowledgement, and summary sequence was not verified. Further live tests require resolving the 440 conflict and relinking after the reported 401 logout.
