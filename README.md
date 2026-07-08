# Baileys Render Bot

Node.js WhatsApp bot using Baileys, Render Free, and Supabase-backed auth persistence. The QR code is needed for the first login only. After WhatsApp is linked, Baileys credentials and session keys are stored in Supabase so normal Render restarts should reconnect without another QR scan.

## Features

- Express web service for Render
- Baileys WhatsApp Web socket
- Supabase table for persistent auth/session storage
- Admin-protected QR, status, and send-message endpoints
- Public health endpoint for keep-alive pings
- Simple `ping` -> `pong` WhatsApp test command
- GitHub Actions keep-alive workflow template

## Supabase Setup

1. Create a Supabase project.
2. Open the SQL editor.
3. Run this SQL:

```sql
create table if not exists baileys_auth (
  session_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz default now(),
  primary key (session_id, key)
);
```

This table stores `creds`, `pre-key-*`, `session-*`, `sender-key-*`, `app-state-sync-key-*`, `app-state-sync-version-*`, `sender-key-memory-*`, and any other auth keys requested by Baileys.

## Local Setup

```bash
npm install
npm start
```

For local testing, set the required environment variables before starting the app. This project does not require local Baileys auth files.

## Environment Variables

Create these variables in Render:

```txt
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SESSION_ID
ADMIN_TOKEN
```

Optional:

```txt
PORT
```

Use `SESSION_ID=main` unless you plan to support multiple WhatsApp sessions. Use a long random value for `ADMIN_TOKEN`.

Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code, browser JavaScript, screenshots, or public logs.

## Render Deployment

1. Push this repository to GitHub.
2. Create a new Render Web Service.
3. Connect the GitHub repository.
4. Use these settings:

```txt
Build command: npm install
Start command: npm start
```

5. Add the environment variables listed above.
6. Deploy the service.

## Link WhatsApp

Open this URL after deployment:

```txt
https://your-render-app.onrender.com/qr?token=YOUR_ADMIN_TOKEN
```

Then scan the QR code:

```txt
WhatsApp -> Settings -> Linked devices -> Link a device
```

If there is no QR and the page says the bot is connected, you do not need to scan again.

## Test The Bot

Send this message to the linked WhatsApp account:

```txt
ping
```

The bot should reply:

```txt
pong
```

Check service health:

```bash
curl https://your-render-app.onrender.com/health
```

Check admin status:

```bash
curl "https://your-render-app.onrender.com/status?token=YOUR_ADMIN_TOKEN"
```

Send a WhatsApp message through the API:

```bash
curl -X POST "https://your-render-app.onrender.com/send?token=YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"6591234567","text":"Hello from Render Baileys"}'
```

You can also send to a full WhatsApp JID:

```bash
curl -X POST "https://your-render-app.onrender.com/send?token=YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jid":"6591234567@s.whatsapp.net","text":"Hello from Render Baileys"}'
```

Send an image by URL:

```bash
curl -X POST "https://your-render-app.onrender.com/send?token=YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"6591234567","type":"image","url":"https://example.com/image.jpg","text":"Here is an image"}'
```

Send a document by URL:

```bash
curl -X POST "https://your-render-app.onrender.com/send?token=YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"6591234567","type":"document","url":"https://example.com/file.pdf","fileName":"file.pdf","mimetype":"application/pdf","text":"Here is a document"}'
```

For image and document URLs, `type`, `fileName`, and `mimetype` can usually be omitted. The server will try to infer them from the URL path and HTTP headers:

```bash
curl -X POST "https://your-render-app.onrender.com/send?token=YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"6591234567","url":"https://example.com/file.pdf","text":"Here is a document"}'
```

## Keep Render Awake

The included GitHub Actions workflow pings `/health` every 5 minutes:

```txt
.github/workflows/keepalive.yml
```

Replace this placeholder in the workflow with your actual Render URL:

```txt
https://YOUR_RENDER_APP.onrender.com
```

External services such as cron-job.org or UptimeRobot are preferred for keep-alive pings because GitHub scheduled workflows may be delayed or paused.

## Optional Dashboard

This repo also includes a TypeScript Next.js dashboard in `dashboard/` for testing and sending through the bot API from a browser.

```bash
cd dashboard
npm install
npm run dev -- -p 3001
```

Open:

```txt
http://localhost:3001
```

The dashboard uses shadcn-style UI components and includes:

- Health/status checks
- QR page shortcut
- Single message tab with optional image/document upload
- Bulk message tab for `.csv` or `.xlsx` recipient import
- Shared image/document upload for bulk sends
- Persistent browser-side send queue using `localStorage`
- Health-check before each queued send, so failed or disconnected runs can be resumed
- Supabase Storage upload for attachments, using private bucket signed URLs

Bulk recipient files should include:

```txt
phone,text
6591234567,Hello from the dashboard
6597654321,Another message
```

Without headers, column 1 is treated as `phone` and column 2 as `text`.

For attachment uploads, set these dashboard server-side environment variables:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=whatsapp-temp
SUPABASE_SIGNED_URL_TTL_SECONDS=1800
```

The Supabase bucket should stay private. The dashboard uploads the file server-side, creates a signed URL, then sends that URL to the bot.

## Endpoints

```txt
GET  /          Public text response
GET  /health    Public JSON health response
GET  /status    Admin-protected status JSON
GET  /qr        Admin-protected QR page
POST /send      Admin-protected send-message API
```

Admin endpoints accept either:

```txt
Authorization: Bearer ADMIN_TOKEN
```

or:

```txt
?token=ADMIN_TOKEN
```

## Security Notes

Do not commit:

```txt
.env
auth/
Baileys session files
Supabase service role key
Admin token
```

Baileys auth/session data is sensitive. Anyone with the session can control the linked WhatsApp session. Keep the Supabase service role key private and use a long random `ADMIN_TOKEN`.

## Avoid Session Conflicts

Only run one bot process per `SESSION_ID`. If you run the bot locally and on Render at the same time with `SESSION_ID=main`, WhatsApp may disconnect one process with:

```txt
Stream Errored (conflict)
```

Stop the local process before starting Render, or use a different `SESSION_ID` for experiments.

## Render Free Notes

Render Free is not a perfect 24/7 worker platform. A 5-minute keep-alive reduces sleeping, but the app may still restart. Supabase-backed auth is the important part: after normal restarts, the bot should reconnect without another QR scan.
