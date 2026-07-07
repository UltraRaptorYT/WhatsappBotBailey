# CLAUDE.md

## Project: Baileys WhatsApp Bot on Render Free

Build a Node.js WhatsApp bot using Baileys, hosted on Render Free, with Supabase-based persistent authentication storage and an external keep-alive endpoint.

The goal is to avoid repeated QR scans when Render restarts or redeploys by storing Baileys auth/session data in Supabase instead of the local filesystem.

---

## Core Requirements

Build a complete working repository with:

```txt
Render Web Service
+ Baileys WhatsApp Web bot
+ Supabase auth persistence
+ Admin-protected QR page
+ Admin-protected send message API
+ Health endpoint for 5-minute keep-alive pings
```

Do not use:

```txt
WhatsApp Cloud API
Twilio WhatsApp API
Oracle Cloud
Raspberry Pi
Local-only Baileys auth storage
```

Use:

```txt
Node.js
Express
@whiskeysockets/baileys
Supabase
Render
External cron / GitHub Actions keep-alive
```

---

## Target Architecture

```txt
WhatsApp
   ↕
Baileys bot running on Render Free
   ↕
Supabase table storing Baileys credentials/session keys
   ↕
External ping every 5 minutes to /health
```

---

## Important Design Notes

Baileys needs a persistent auth state after QR login.

The QR code is only used for the first login. After the QR is scanned, Baileys saves credentials and encryption/session keys. Since Render Free local files are not reliable across redeploys/restarts, do not store auth using `useMultiFileAuthState("./auth")`.

Instead, implement a custom Supabase-backed auth state adapter.

The bot should reconnect automatically when disconnected unless the disconnect reason is logged out.

---

## File Structure

Create this project structure:

```txt
baileys-render-bot/
├─ package.json
├─ index.js
├─ supabase-auth.js
├─ README.md
├─ .env.example
└─ .github/
   └─ workflows/
      └─ keepalive.yml
```

---

## Supabase Table

Include this SQL in the README:

```sql
create table if not exists baileys_auth (
  session_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz default now(),
  primary key (session_id, key)
);
```

This table stores:

```txt
creds
pre-key-*
session-*
sender-key-*
app-state-sync-key-*
app-state-sync-version-*
sender-key-memory-*
```

or any other Baileys auth key type that Baileys requests.

---

## Environment Variables

Create `.env.example` with:

```env
PORT=3000

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

SESSION_ID=main
ADMIN_TOKEN=change_this_to_a_long_random_secret
```

Rules:

* `SUPABASE_SERVICE_ROLE_KEY` must never be exposed to frontend code.
* `ADMIN_TOKEN` protects `/qr`, `/status`, and `/send`.
* `SESSION_ID` allows multiple WhatsApp sessions in the same Supabase table in the future.

---

## package.json

Use ES modules.

Required dependencies:

```json
{
  "name": "baileys-render-bot",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node index.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "@whiskeysockets/baileys": "^6.7.0",
    "express": "^4.19.2",
    "pino": "^9.3.2",
    "qrcode": "^1.5.4"
  }
}
```

---

## supabase-auth.js Requirements

Implement a function:

```js
export async function useSupabaseAuthState()
```

It must return:

```js
{
  state: {
    creds,
    keys: {
      get,
      set
    }
  },
  saveCreds
}
```

Implementation requirements:

* Use `createClient` from `@supabase/supabase-js`.
* Use `initAuthCreds`, `BufferJSON`, and `proto` from `@whiskeysockets/baileys`.
* Store all data in the `baileys_auth` table.
* Use `SESSION_ID` from environment variables.
* Serialize with `BufferJSON.replacer`.
* Deserialize with `BufferJSON.reviver`.
* Properly handle `app-state-sync-key` using:

```js
proto.Message.AppStateSyncKeyData.fromObject(value)
```

* Implement:

  * `readData(key)`
  * `writeData(key, value)`
  * `removeData(key)`
* Use Supabase `upsert` with conflict target:

```txt
session_id,key
```

* Log Supabase errors but do not crash the process unless the error is fatal.

---

## index.js Requirements

Create an Express server and Baileys socket.

Required endpoints:

```txt
GET /
GET /health
GET /status
GET /qr
POST /send
```

---

## Endpoint Behaviour

### `GET /`

Return plain text:

```txt
Baileys bot is running.
```

---

### `GET /health`

Public endpoint.

Return JSON:

```json
{
  "ok": true,
  "status": "connected",
  "time": "2026-01-01T00:00:00.000Z"
}
```

This endpoint is used by cron-job.org, UptimeRobot, or GitHub Actions to keep Render awake.

---

### `GET /status`

Admin-protected.

Accept token from either:

```txt
Authorization: Bearer ADMIN_TOKEN
```

or:

```txt
/status?token=ADMIN_TOKEN
```

Return:

```json
{
  "status": "connected",
  "hasQr": false
}
```

---

### `GET /qr`

Admin-protected.

If there is a current QR code, render a simple HTML page with:

```txt
Scan this WhatsApp QR
Open WhatsApp → Linked devices → Link a device
```

and display the QR image.

If there is no QR, return an HTML page saying:

```txt
No QR right now
Status: connected
If already connected, you do not need to scan again.
```

Use the `qrcode` npm package to convert the QR string to a data URL.

---

### `POST /send`

Admin-protected.

Request body should support either:

```json
{
  "phone": "6591234567",
  "text": "Hello from Baileys"
}
```

or:

```json
{
  "jid": "6591234567@s.whatsapp.net",
  "text": "Hello from Baileys"
}
```

If `phone` is provided, clean non-digits and convert to:

```txt
<phone>@s.whatsapp.net
```

Return:

```json
{
  "ok": true,
  "to": "6591234567@s.whatsapp.net",
  "text": "Hello from Baileys"
}
```

Handle missing fields with `400`.

Handle send failure with `500`.

---

## Baileys Bot Behaviour

Use:

```js
makeWASocket
DisconnectReason
Browsers
```

Set:

```js
browser: Browsers.macOS("Chrome")
printQRInTerminal: false
logger: P({ level: "silent" })
```

Track global state:

```js
let sock
let currentQr = null
let connectionStatus = "starting"
```

Connection states:

```txt
starting
qr_required
connected
disconnected
```

When Baileys emits QR:

* Convert QR to data URL.
* Store in `currentQr`.
* Set `connectionStatus = "qr_required"`.
* Log that QR is available at `/qr?token=...`.

When connection opens:

* Clear `currentQr`.
* Set `connectionStatus = "connected"`.
* Log `"WhatsApp connected"`.

When connection closes:

* Set `connectionStatus = "disconnected"`.
* Check disconnect reason.
* If not logged out, reconnect after 3 seconds.
* If logged out, log that Supabase auth rows should be cleared and QR scanned again.

On `creds.update`, call `saveCreds`.

---

## Basic Message Handler

Implement a simple test command.

When someone sends:

```txt
ping
```

Reply:

```txt
pong
```

Ignore messages from self.

Safely extract text from:

```js
msg.message.conversation
msg.message.extendedTextMessage?.text
```

---

## Admin Auth Middleware

Implement:

```js
function requireAdmin(req, res, next)
```

It should accept:

```txt
Authorization: Bearer ADMIN_TOKEN
```

or query param:

```txt
?token=ADMIN_TOKEN
```

If token is missing or wrong, return:

```json
{
  "error": "Unauthorized"
}
```

with status `401`.

---

## GitHub Actions Keep-Alive

Create:

```txt
.github/workflows/keepalive.yml
```

Use a 5-minute cron:

```yaml
name: Keep Render Awake

on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Render service
        run: |
          curl -fsS https://YOUR_RENDER_APP.onrender.com/health || true
```

In README, explain that the user must replace:

```txt
https://YOUR_RENDER_APP.onrender.com
```

with their actual Render URL.

Also mention that an external service like cron-job.org or UptimeRobot is preferred because GitHub scheduled actions may be delayed or paused.

---

## README.md Requirements

Write setup instructions for:

1. Creating Supabase project.
2. Running the SQL table creation.
3. Creating Render Web Service.
4. Setting Render environment variables.
5. Deploying from GitHub.
6. Opening:

```txt
https://your-render-app.onrender.com/qr?token=YOUR_ADMIN_TOKEN
```

7. Scanning QR using:

```txt
WhatsApp → Settings → Linked devices → Link a device
```

8. Testing bot by sending:

```txt
ping
```

9. Testing send API with curl:

```bash
curl -X POST "https://your-render-app.onrender.com/send?token=YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"6591234567","text":"Hello from Render Baileys"}'
```

10. Setting up 5-minute keep-alive.

---

## Render Deployment Settings

README should include:

```txt
Build command: npm install
Start command: npm start
```

Environment variables:

```txt
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SESSION_ID
ADMIN_TOKEN
```

---

## Security Requirements

Do not commit:

```txt
.env
auth/
Baileys session files
Supabase service role key
Admin token
```

Add `.gitignore` with:

```gitignore
node_modules/
.env
auth/
.DS_Store
```

Mention:

* Baileys auth/session data is sensitive.
* Anyone with the session can control the linked WhatsApp session.
* Keep Supabase service role key private.
* Use a long random `ADMIN_TOKEN`.

---

## Acceptance Criteria

The project is complete when:

* `npm install` works.
* `npm start` starts an Express server.
* `/health` returns JSON.
* `/qr?token=...` displays QR when QR is available.
* Scanning QR connects WhatsApp.
* Supabase table receives auth rows.
* Restarting the Render service reconnects without needing QR again.
* Sending `ping` to the WhatsApp account gets `pong`.
* `POST /send` can send a message.
* GitHub Actions keep-alive file exists with 5-minute schedule.
* README clearly explains Render, Supabase, QR scanning, and keep-alive setup.

---

## Implementation Preference

Keep the code simple and production-readable.

Do not over-engineer.

Avoid TypeScript unless necessary. Use plain JavaScript ES modules.

Use clear console logs for:

```txt
Server started
QR generated
WhatsApp connected
Connection closed
Reconnecting
Send message success/failure
Supabase read/write errors
```

---

## Notes

This is a free-hosting workaround.

Render Free is not a perfect 24/7 worker platform. The 5-minute keep-alive helps reduce sleeping, but the app may still restart. The important part is that Supabase stores the Baileys auth state so the user should not need to rescan the QR after normal restarts.

Build the complete repository now.
