# WhatsApp service run guide

Use the maintained project guide at [docs/how2run.md](../docs/how2run.md). It includes Windows setup, Django and Node commands, Gemini configuration and verification, supported message handling, WhatsApp pairing, recovery behavior, test commands, troubleshooting, and production preparation.

From this directory, build and start the bridge with:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

To inspect available generation models or make a harmless Gemini test request, run `npm.cmd run gemini:models` or `npm.cmd run gemini:test`. Automated tests use mocked Gemini requests.

Run only one process for each session directory. The bridge reads the repository-root `.env` and stores credentials in this directory's `whatsapp-session/` folder.

On Baileys status 440 (`connectionReplaced`), the bridge stops automatic reconnects so it does not fight another linked session. Check for another FinTrack bridge process or competing linked-device session before restarting. Status 401 means WhatsApp logged the session out; do not delete the saved session files to silence either error.
