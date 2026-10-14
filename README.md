# Bailey WhatsApp Bot

Step-by-step instructions for setting up Bailey with a Node.js bot on Render, session storage in Supabase, and the optional Next.js dashboard on Vercel.

## What Bailey does

Bailey connects an existing WhatsApp account as a linked device using Baileys. It lets you send messages through an API or the web dashboard, and stage paced bulk sends in a queue. Supabase stores the linked-device session and queue so the bot can reconnect after restarts.

## What you need

- GitHub account with this repository
- Supabase, Render, and Vercel accounts
- A phone with WhatsApp to link as a device
- Node.js 20 or later for local development

The bot and dashboard are separate deployments:

| Part | Deploy location | Purpose |
| --- | --- | --- |
| Bot API and WhatsApp connection | Render | Keeps the WhatsApp connection and handles API requests and the send queue |
| Database and optional file storage | Supabase | Stores WhatsApp session keys, queue data, and uploaded attachments |
| Web dashboard | Vercel | Lets you check status and send or queue messages from a browser |

## 1. Create the Supabase project

1. Create a project in Supabase and wait for it to finish provisioning.
2. Open **SQL Editor** and run:

   ```sql
   create table if not exists baileys_auth (
     session_id text not null,
     key text not null,
     value jsonb not null,
     updated_at timestamptz default now(),
     primary key (session_id, key)
   );

   create table if not exists baileys_queue (
     session_id text primary key,
     value jsonb not null default '{"items":[],"paused":false,"settings":{}}'::jsonb,
     updated_at timestamptz default now()
   );
   ```

3. Open **Project Settings -> API** (or **API Keys**, depending on the Supabase dashboard) and copy:
   - Project URL
   - The `service_role` secret key

   Keep the service role key private. It grants elevated access to your database and storage.

### Optional: enable dashboard attachment uploads

If you want to upload image or document files through the dashboard:

1. Open **Storage** in Supabase.
2. Create a bucket named `whatsapp-temp` and leave it **private**.
3. The dashboard server will upload files to this bucket and create temporary signed URLs for the bot.

You can skip this section if you will send files only by URL or send text messages.

## 2. Deploy the bot to Render

1. In Render, choose **New -> Web Service** and connect this GitHub repository.
2. Use these settings:

   | Setting | Value |
   | --- | --- |
   | Root Directory | `.` (repository root) |
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Region | Choose the region nearest you, such as Singapore |

3. Add these environment variables under the service's **Environment** settings:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | Your Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Your private Supabase service role key |
   | `SESSION_ID` | `main` |
   | `ADMIN_TOKEN` | A long, random secret that you create |

   Render provides `PORT` automatically. Optional queue settings are `QUEUE_BATCH_SIZE`, `QUEUE_BATCH_WAIT_MS`, and `QUEUE_SEND_DELAY_MS`.

4. Create the service and wait for the first deploy to finish.
5. Copy the service URL, for example `https://your-service.onrender.com`.
6. Check the public health endpoint in a browser:

   ```text
   https://your-service.onrender.com/health
   ```

   It should return JSON. `starting` means the service is still connecting; `connected` means WhatsApp is linked.

### Link WhatsApp the first time

1. Open the QR page, replacing the example URL and token:

   ```text
   https://your-service.onrender.com/qr?token=YOUR_ADMIN_TOKEN
   ```

2. On your phone, open **WhatsApp -> Settings -> Linked devices -> Link a device**.
3. Scan the QR code displayed in the browser.
4. Wait until the page says WhatsApp is connected.

The QR page refreshes its status and QR automatically. After the first successful link, the bot stores the session in Supabase and should reconnect after normal restarts without another scan. If the page says it is already connected, no scan is needed.

## 3. Deploy the dashboard to Vercel (optional)

1. In Vercel, choose **Add New -> Project** and import this same GitHub repository.
2. Set **Root Directory** to `dashboard` and keep the detected Next.js framework and default build settings.
3. Add these environment variables:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_DEFAULT_BOT_URL` | The Render service URL, such as `https://your-service.onrender.com` |
   | `NEXT_PUBLIC_MAX_UPLOAD_MB` | `50` (optional; maximum dashboard upload size) |

4. If you enabled Supabase attachment uploads above, also add these **server-side** variables to Vercel:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | Your Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Your private Supabase service role key |
   | `SUPABASE_STORAGE_BUCKET` | `whatsapp-temp` |
   | `SUPABASE_SIGNED_URL_TTL_SECONDS` | `1800` |

   Do not add `NEXT_PUBLIC_` to the service role key. Never expose it in browser code.

5. Deploy the project. After changing Vercel environment variables, redeploy for the new values to take effect.
6. Open the Vercel deployment URL. In the dashboard, enter the same `ADMIN_TOKEN` you configured on Render.
7. If you want a specific Vercel address, open **Project Settings -> Domains**, add the address to this project, and make sure Vercel shows it as valid and assigned to Production. Use the working deployment URL while a domain is not resolving.

The dashboard stores the admin token in that browser's local storage so it can keep making requests. Only enter it on a device and browser you trust.

## 4. Check that everything works

Use the Render service URL in the examples below. Send the admin token as a Bearer token instead of putting it in the URL.

### Check bot status

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  "https://your-service.onrender.com/status"
```

### Send a text message

Use the recipient's full international phone number, including the country code, or provide a WhatsApp JID. For example, a US number can be entered as `+1 202 555 0123`; Bailey removes the `+`, spaces, and punctuation before sending. Singapore numbers can be entered with `65` as the country code.

```bash
curl -X POST "https://your-service.onrender.com/send" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"6591234567","text":"Hello from Bailey"}'
```

Successful response:

```json
{
  "ok": true,
  "to": "6591234567@s.whatsapp.net",
  "type": "text",
  "text": "Hello from Bailey"
}
```

You can also send a JID instead of `phone`:

```json
{"jid":"6591234567@s.whatsapp.net","text":"Hello from Bailey"}
```

The recipient must be on WhatsApp and the bot must show `connected` in `/status`.

### Send an attachment by URL

```bash
curl -X POST "https://your-service.onrender.com/send" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"6591234567","type":"image","url":"https://example.com/image.jpg","text":"Photo caption"}'
```

For documents, use `"type":"document"`; you may also set `fileName` and `mimetype`. The bot can infer common file types from the URL.

For Python automation, install `requests` and call the same API:

```python
import os
import requests

response = requests.post(
    "https://your-service.onrender.com/send",
    headers={"Authorization": f"Bearer {os.environ['BAILEY_ADMIN_TOKEN']}"},
    json={"phone": "6591234567", "text": "Hello from Python"},
    timeout=30,
)
response.raise_for_status()
print(response.json())
```

For large batches, use the dashboard queue. It persists in Supabase, can be paused/resumed, and applies the configured pacing between sends.

## 5. Keep the Render Free service awake (optional)

This repository includes `.github/workflows/keepalive.yml`, which requests `/health` every five minutes. The workflow currently uses `https://whatsappbotbailey.onrender.com`. If your Render URL is different, edit that workflow to use your service URL and push the change to GitHub.

Render Free services can still sleep or restart, and scheduled GitHub Actions may not run at an exact time. Supabase-backed session storage helps the bot reconnect after a restart. If you need consistently fast responses and uptime, use an always-on paid service.

## Run locally

### Bot

1. Copy `.env.example` to `.env` and fill in the Supabase values and an `ADMIN_TOKEN`.
2. From the repository root, run:

   ```bash
   npm install
   npm start
   ```

3. The bot API will listen at `http://localhost:3000` (or the `PORT` you set).

### Dashboard

1. Copy `dashboard/.env.example` to `dashboard/.env.local`.
2. Set `NEXT_PUBLIC_DEFAULT_BOT_URL=http://localhost:3000` for local bot testing. For uploads, also set the Supabase server-side variables described above.
3. In a second terminal, run:

   ```bash
   cd dashboard
   npm install
   npm run dev -- -p 3001
   ```

4. Open `http://localhost:3001` and enter the bot's admin token.

Run only one bot process per `SESSION_ID`. Running the local bot and Render bot with `SESSION_ID=main` at the same time can cause WhatsApp to disconnect one of them. Stop one bot or use a different `SESSION_ID` for testing.

## Bulk recipient file format

CSV and XLSX files can use headers such as:

```csv
Mobile Number,Name,text,ImageURL
91234567,Alice,"Dear {Name}, your number is {Mobile Number}.",https://example.com/image.png
98765432,Ben,"Dear {Name}, your number is {Mobile Number}.",
```

The dashboard replaces `{Column Name}` with values from each row. `Mobile Number` is supported. For numbers outside Singapore, include the full number with its country code, such as `+1 202 555 0123`. Eight-digit Singapore numbers without `+65` are prefixed automatically. Without headers, column 1 is treated as the phone number and column 2 as the message. A row's `ImageURL` is used unless you choose a shared attachment.

In the dashboard queue, use `/br` to send separate WhatsApp messages to the same recipient, for example `First message /br Second message`. All parts stay together as one queue item and send in order, with the configured per-message delay between them. The batch wait is applied after the complete `/br` group, so it cannot pause between its parts. The immediate `POST /send` endpoint sends its text as provided and does not interpret `/br`.

## Endpoints

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | Public | Basic server response |
| `GET` | `/health` | Public | Health and WhatsApp connection status |
| `GET` | `/status` | Admin token | Status, QR availability, and last bot error |
| `GET` | `/qr` | Admin token | QR login page |
| `POST` | `/send` | Admin token | Send one WhatsApp message immediately |
| `GET/POST` | `/queue` | Admin token | Read or add queue messages |
| `POST` | `/queue/start`, `/queue/pause`, `/queue/settings`, `/queue/remove` | Admin token | Control the send queue |
| `POST` | `/session/reset` | Admin token | Clear the linked session and request a new QR |

For admin API requests, use either `Authorization: Bearer ADMIN_TOKEN` or `?token=ADMIN_TOKEN`. Prefer the Authorization header for API calls. The QR page uses the query token because it is opened directly in a browser.

## Troubleshooting

- **Vercel domain does not open:** try the deployment URL from Vercel first. In **Project Settings -> Domains**, attach the desired domain to this project and Production. A browser DNS error happens before requests reach the app.
- **Dashboard says unauthorized:** enter the Render `ADMIN_TOKEN` in the dashboard and check that it matches the Render environment variable.
- **QR page says unauthorized:** open it with the correct `?token=...` value. Do not share that full URL.
- **QR page has no QR:** check `/health` and `/status`; the bot may still be starting, reconnecting, or already linked.
- **Send returns `WhatsApp is not connected`:** wait for `/status` to report `connected`. Check the Render logs for the connection error.
- **Supabase table error on startup:** confirm both SQL tables were created and Render has the correct project URL and service role key.
- **Uploads fail:** confirm the private `whatsapp-temp` bucket exists and that Vercel has the Supabase server-side variables.
- **WhatsApp disconnects with a conflict:** stop duplicate bot processes using the same `SESSION_ID`.

## Keep credentials private

- Do not commit `.env`, `.env.local`, auth files, Supabase service role keys, or the admin token.
- The Supabase service role key belongs only in Render and, if dashboard uploads are enabled, Vercel server-side environment variables.
- Treat the admin token and saved WhatsApp session as credentials. Anyone with them may be able to send messages from the linked account.
