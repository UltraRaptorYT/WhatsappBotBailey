import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import P from "pino";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";
import { useSupabaseAuthState } from "./supabase-auth.js";

const app = express();
const port = process.env.PORT || 3000;
const adminToken = process.env.ADMIN_TOKEN;
const faviconPath = fileURLToPath(new URL("./dashboard/public/brand/favicon.ico", import.meta.url));

let sock;
let currentQr = null;
let connectionStatus = "starting";
let reconnectTimer = null;
let lastBotError = null;
let botStarting = false;
let sendQueue = [];
let queueRunning = false;
let queuePaused = false;
let queueSettings = {
  batchSize: Number(process.env.QUEUE_BATCH_SIZE || 5),
  batchWaitMs: Number(process.env.QUEUE_BATCH_WAIT_MS || 5 * 60 * 1000),
  messageDelayMs: Number(process.env.QUEUE_SEND_DELAY_MS || 1200)
};
let queueStore;
let authResetInProgress = false;

process.on("unhandledRejection", (reason) => {
  lastBotError = getErrorMessage(reason);
  connectionStatus = "disconnected";
  console.error("Unhandled promise rejection:", reason);
  scheduleReconnect();
});

process.on("uncaughtException", (error) => {
  lastBotError = getErrorMessage(error);
  connectionStatus = "disconnected";
  console.error("Uncaught exception:", error);
  scheduleReconnect();
});

function getErrorMessage(error) {
  return error?.stack || error?.message || String(error);
}

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWhileQueueActive(ms) {
  let remaining = ms;
  while (!queuePaused && remaining > 0) {
    const step = Math.min(remaining, 1000);
    await delay(step);
    remaining -= step;
  }
}

function normalizeQueueSettings(input = {}) {
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
  };

  return {
    batchSize: number(input.batchSize, queueSettings.batchSize, 1, 1000),
    batchWaitMs: number(input.batchWaitMs, queueSettings.batchWaitMs, 0, 24 * 60 * 60 * 1000),
    messageDelayMs: number(input.messageDelayMs, queueSettings.messageDelayMs, 0, 60 * 1000)
  };
}

async function loadQueueStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

  queueStore = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await queueStore
    .from("baileys_queue")
    .select("value")
    .eq("session_id", process.env.SESSION_ID || "main")
    .maybeSingle();

  if (error) throw new Error(`Could not load durable queue: ${error.message}`);
  if (data?.value && typeof data.value === "object") {
    sendQueue = Array.isArray(data.value.items) ? data.value.items : [];
    queuePaused = Boolean(data.value.paused);
    queueSettings = normalizeQueueSettings(data.value.settings || {});
    // A process cannot resume an in-flight request after a restart.
    sendQueue = sendQueue.map((item) => item.status === "sending" ? { ...item, status: "queued" } : item);
    await saveQueueStore();
  }
}

async function saveQueueStore() {
  const { error } = await queueStore
    .from("baileys_queue")
    .upsert({
      session_id: process.env.SESSION_ID || "main",
      value: { items: sendQueue, paused: queuePaused, settings: queueSettings },
      updated_at: new Date().toISOString()
    }, { onConflict: "session_id" });
  if (error) throw new Error(`Could not save durable queue: ${error.message}`);
}

async function clearWhatsAppAuth() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { error } = await supabase
    .from("baileys_auth")
    .delete()
    .eq("session_id", process.env.SESSION_ID || "main");

  if (error) throw new Error(`Could not reset WhatsApp login: ${error.message}`);
}

async function resetWhatsAppSession({ pauseQueue = false } = {}) {
  if (authResetInProgress) return;
  authResetInProgress = true;

  try {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (pauseQueue) {
      queuePaused = true;
      await saveQueueStore();
    }

    cleanupSocket();
    try {
      sock?.ws?.close();
    } catch (_error) {
      // The old socket may already be closed.
    }
    sock = undefined;
    currentQr = null;
    lastBotError = null;
    connectionStatus = "starting";
    await clearWhatsAppAuth();
    await startBot();
  } finally {
    authResetInProgress = false;
  }
}

function getQueueCounts() {
  return sendQueue.reduce(
    (counts, item) => {
      counts.all += 1;
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    },
    { all: 0, queued: 0, sending: 0, sent: 0, failed: 0 }
  );
}

function moveQueueItemToEnd(id, patch) {
  const item = sendQueue.find((entry) => entry.id === id);

  if (!item) {
    return null;
  }

  sendQueue = [
    ...sendQueue.filter((entry) => entry.id !== id),
    { ...item, ...patch, updatedAt: new Date().toISOString() }
  ];

  return sendQueue[sendQueue.length - 1];
}

function publicQueueItem(item) {
  return {
    id: item.id,
    clientId: item.clientId,
    phone: item.phone,
    jid: item.jid,
    text: item.text,
    status: item.status,
    attempts: item.attempts,
    lastError: item.lastError,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    sentAt: item.sentAt,
    fileName: item.fileName,
    hasAttachment: Boolean(item.payload?.url || item.payload?.dataUrl || item.payload?.base64)
  };
}

function getQueueSnapshot() {
  return {
    ok: true,
    running: queueRunning,
    paused: queuePaused,
    settings: queueSettings,
    counts: getQueueCounts(),
    items: sendQueue.map(publicQueueItem)
  };
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  connectionStatus = "starting";
  console.log("Reconnecting in 3 seconds");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((error) => {
      botStarting = false;
      lastBotError = getErrorMessage(error);
      connectionStatus = "disconnected";
      console.error("Reconnect failed:", error);
      scheduleReconnect();
    });
  }, 3000);
}

function cleanupSocket() {
  if (!sock) {
    return;
  }

  try {
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("messages.upsert");
  } catch (error) {
    console.error("Socket cleanup warning:", error.message);
  }
}

app.use(express.json({ limit: process.env.JSON_LIMIT || "100mb" }));

function requireAdmin(req, res, next) {
  const header = req.get("authorization") || "";
  const bearerToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  const queryToken = req.query.token;
  const token = bearerToken || queryToken;

  if (!adminToken || token !== adminToken) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

function cleanPhoneToJid(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : "";
}

function getPhoneDigitsFromJid(jid) {
  if (!jid?.endsWith("@s.whatsapp.net")) {
    return "";
  }

  return jid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
}

async function validateWhatsAppUser(jid) {
  if (!jid.endsWith("@s.whatsapp.net")) {
    return { ok: true };
  }

  const digits = getPhoneDigitsFromJid(jid);

  if (digits.length < 8 || digits.length > 15) {
    return {
      ok: false,
      error: "Invalid phone number format"
    };
  }

  const matches = await sock.onWhatsApp(jid);
  const match = matches?.[0];

  if (!match?.exists) {
    return {
      ok: false,
      error: "Phone number is not on WhatsApp"
    };
  }

  return {
    ok: true,
    jid: match.jid || jid
  };
}

function getFileNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const fileName = pathname.split("/").filter(Boolean).pop();
    return fileName ? decodeURIComponent(fileName) : null;
  } catch (_error) {
    return null;
  }
}

function extensionToMimeType(fileName) {
  const extension = fileName?.split(".").pop()?.toLowerCase();
  const mimeTypes = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    zip: "application/zip"
  };

  return mimeTypes[extension] || null;
}

function parseFileBody(body) {
  const file = body.file || {};
  const dataUrl = body.dataUrl || file.dataUrl;
  const base64 = body.base64 || file.base64;
  const fileName = body.fileName || file.fileName || file.name;
  let mimetype = body.mimetype || file.mimetype || file.type || extensionToMimeType(fileName);
  let rawBase64 = base64;

  if (dataUrl) {
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);

    if (!match) {
      return { error: "Invalid dataUrl" };
    }

    mimetype = mimetype || match[1];
    rawBase64 = match[2];
  }

  if (!rawBase64) {
    return null;
  }

  return {
    buffer: Buffer.from(String(rawBase64), "base64"),
    fileName: fileName || "upload",
    mimetype: mimetype || "application/octet-stream"
  };
}

async function getUrlMetadata(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal
    });
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const disposition = response.headers.get("content-disposition") || "";
    const fileNameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i);
    const headerFileName = fileNameMatch?.[1]
      ? decodeURIComponent(fileNameMatch[1].replace(/"/g, ""))
      : null;

    return {
      mimetype: contentType || null,
      fileName: headerFileName || getFileNameFromUrl(response.url || url)
    };
  } catch (error) {
    console.error(`Could not read URL metadata for ${url}:`, error.message);
    return {
      mimetype: null,
      fileName: getFileNameFromUrl(url)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildMessagePayload(body) {
  const captionText = body.text ?? body.caption;
  const uploadedFile = parseFileBody(body);

  if (uploadedFile?.error) {
    return { error: uploadedFile.error };
  }

  const metadata = body.url ? await getUrlMetadata(String(body.url)) : {};
  const inferredMimeType =
    uploadedFile?.mimetype ||
    body.mimetype ||
    metadata.mimetype ||
    extensionToMimeType(metadata.fileName);
  const type =
    body.type ||
    (inferredMimeType?.startsWith("image/") && (body.url || uploadedFile) ? "image" : null) ||
    (body.url || uploadedFile ? "document" : "text");

  if (type === "text" || (!type && body.text)) {
    if (!body.text) {
      return { error: "Missing text" };
    }

    return {
      message: { text: String(body.text) },
      messageType: "text",
      responseText: String(body.text)
    };
  }

  if (type === "image") {
    if (!body.url && !uploadedFile) {
      return { error: "Missing image url or file" };
    }

    return {
      message: {
        image: uploadedFile ? uploadedFile.buffer : { url: String(body.url) },
        mimetype: inferredMimeType || undefined,
        caption: captionText ? String(captionText) : undefined
      },
      messageType: "image",
      responseText: captionText ? String(captionText) : ""
    };
  }

  if (type === "document") {
    if (!body.url && !uploadedFile) {
      return { error: "Missing document url or file" };
    }

    const fileName = uploadedFile?.fileName || body.fileName || metadata.fileName || "document";
    const mimetype = inferredMimeType || "application/octet-stream";

    return {
      message: {
        document: uploadedFile ? uploadedFile.buffer : { url: String(body.url) },
        fileName: String(fileName),
        mimetype: String(mimetype),
        caption: captionText ? String(captionText) : undefined
      },
      messageType: "document",
      responseText: captionText ? String(captionText) : ""
    };
  }

  return { error: "Unsupported message type" };
}

function getMessageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ""
  ).trim();
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("Baileys bot is running.");
});

app.get("/favicon.ico", (_req, res) => {
  res.sendFile(faviconPath);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: connectionStatus,
    time: new Date().toISOString()
  });
});

app.get("/status", requireAdmin, (_req, res) => {
  res.json({
    status: connectionStatus,
    hasQr: Boolean(currentQr),
    lastError: lastBotError
  });
});

app.get("/qr", requireAdmin, (req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0"
  });

  if (req.query.format === "json") {
    return res.json({
      status: connectionStatus,
      hasQr: Boolean(currentQr),
      qr: currentQr,
      lastError: lastBotError
    });
  }

  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#f5f7fb">
    <link rel="shortcut icon" href="/favicon.ico">
    <link rel="icon" href="/favicon.ico">
    <title>Connect WhatsApp | Bailey</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f5f7fb; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); display: grid; place-items: center; }
      main { width: min(100%, 480px); text-align: center; }
      .brand { margin: 0 0 18px; color: #64748b; font-size: 13px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      .card { padding: clamp(20px, 6vw, 36px); border: 1px solid #e3e8f0; border-radius: 24px; background: #fff; box-shadow: 0 18px 55px rgb(24 39 75 / 9%); }
      h1 { margin: 0; font-size: clamp(24px, 6vw, 32px); line-height: 1.15; letter-spacing: -.035em; }
      .intro { margin: 12px 0 20px; color: #64748b; line-height: 1.55; }
      .status { min-height: 24px; margin: 0 auto 18px; display: flex; align-items: center; justify-content: center; gap: 8px; color: #475569; font-size: 14px; }
      .dot { width: 9px; height: 9px; flex: 0 0 9px; border-radius: 50%; background: #94a3b8; }
      .status[data-state="connected"] .dot { background: #16a34a; }
      .status[data-state="qr_required"] .dot { background: #2563eb; }
      .status[data-state="disconnected"] .dot { background: #dc2626; }
      .spinner { width: 16px; height: 16px; border: 2px solid #dbe3ef; border-top-color: #2563eb; border-radius: 50%; animation: spin .8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .qr-frame { width: min(100%, 360px); min-height: 220px; margin: 0 auto 18px; padding: 12px; display: grid; place-items: center; border: 1px solid #e2e8f0; border-radius: 18px; background: #fff; }
      .qr-frame img { display: none; width: 100%; max-width: 320px; height: auto; image-rendering: pixelated; }
      .qr-frame img.visible { display: block; }
      .placeholder { max-width: 260px; padding: 20px; color: #64748b; font-size: 14px; line-height: 1.55; }
      .instructions { margin: 0; color: #475569; font-size: 14px; line-height: 1.6; }
      .hint { margin: 8px 0 0; color: #94a3b8; font-size: 12px; }
      .error { display: none; margin: 16px 0 0; padding: 12px 14px; border-radius: 12px; background: #fff1f2; color: #be123c; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
      .error.visible { display: block; }
      .actions { margin-top: 20px; }
      button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; background: #172033; color: #fff; font: inherit; font-size: 14px; font-weight: 650; cursor: pointer; }
      button:hover { background: #29364f; }
      button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }
      @media (max-width: 380px) { body { padding-inline: 12px; } .card { border-radius: 20px; } .qr-frame { min-height: 190px; padding: 8px; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; } }
    </style>
  </head>
  <body>
    <main>
      <p class="brand">Bailey · WhatsApp setup</p>
      <section class="card" aria-labelledby="title">
        <h1 id="title">Link your WhatsApp</h1>
        <p class="intro">Keep this page open while you scan the code with your phone.</p>
        <p class="status" id="status" data-state="starting" role="status" aria-live="polite"><span class="spinner" id="spinner" aria-hidden="true"></span><span id="status-text">Connecting to WhatsApp…</span></p>
        <div class="qr-frame">
          <img id="qr-image" alt="WhatsApp device linking QR code" />
          <p class="placeholder" id="placeholder">The QR code will appear here as soon as WhatsApp provides one.</p>
        </div>
        <p class="instructions" id="instructions">Open WhatsApp → Settings → Linked devices → Link a device.</p>
        <p class="hint" id="hint">This page refreshes the QR automatically.</p>
        <p class="error" id="error" role="alert"></p>
        <div class="actions"><button id="refresh" type="button">Check connection</button></div>
      </section>
    </main>
    <script>
      const statusEl = document.getElementById("status");
      const statusText = document.getElementById("status-text");
      const spinner = document.getElementById("spinner");
      const qrImage = document.getElementById("qr-image");
      const placeholder = document.getElementById("placeholder");
      const instructions = document.getElementById("instructions");
      const hint = document.getElementById("hint");
      const errorEl = document.getElementById("error");
      const query = new URLSearchParams(window.location.search);
      query.set("format", "json");
      const statusUrl = window.location.pathname + "?" + query.toString();
      let polling = false;

      function showQr(qr) {
        if (qrImage.src !== qr) qrImage.src = qr;
        qrImage.classList.add("visible");
        placeholder.hidden = true;
        instructions.hidden = false;
        hint.hidden = false;
      }

      function hideQr(message) {
        qrImage.removeAttribute("src");
        qrImage.classList.remove("visible");
        placeholder.hidden = false;
        placeholder.textContent = message;
        instructions.hidden = true;
        hint.hidden = true;
      }

      function renderState(data) {
        const state = data.status || "starting";
        statusEl.dataset.state = state;
        errorEl.textContent = data.lastError || "";
        errorEl.classList.toggle("visible", Boolean(data.lastError));
        spinner.hidden = state === "connected";

        if (state === "connected") {
          statusText.textContent = "WhatsApp is connected";
          hideQr("Connected successfully. You can close this page; no scan is needed.");
          return;
        }

        if (data.hasQr && data.qr) {
          statusText.textContent = "QR ready · waiting for your scan";
          showQr(data.qr);
          return;
        }

        if (state === "qr_required") {
          statusText.textContent = "Preparing a fresh QR code…";
          hideQr("WhatsApp is preparing the QR code. This page will update automatically.");
        } else if (state === "disconnected") {
          statusText.textContent = "Reconnecting to WhatsApp…";
          hideQr("The bot is reconnecting. Keep this page open; it will show a new QR if needed.");
        } else {
          statusText.textContent = "Connecting to WhatsApp…";
          hideQr("Waiting for WhatsApp to start the device-linking process…");
        }
      }

      async function refreshStatus() {
        if (polling) return;
        polling = true;
        try {
          const response = await fetch(statusUrl, { cache: "no-store", headers: { Accept: "application/json" } });
          if (!response.ok) throw new Error(response.status === 401 ? "This link is no longer authorized. Reopen it with the admin token." : "The bot returned HTTP " + response.status + ". Retrying…");
          renderState(await response.json());
        } catch (error) {
          statusEl.dataset.state = "disconnected";
          spinner.hidden = false;
          statusText.textContent = "Waiting for the bot…";
          errorEl.textContent = error instanceof Error ? error.message : "Could not reach the bot. Retrying…";
          errorEl.classList.add("visible");
        } finally {
          polling = false;
          if (document.visibilityState === "visible") window.setTimeout(refreshStatus, 2000);
        }
      }

      document.getElementById("refresh").addEventListener("click", refreshStatus);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshStatus();
      });
      refreshStatus();
    </script>
  </body>
</html>`);
});

async function sendMessageBody(body) {
  const { phone, jid } = body || {};
  const to = jid || cleanPhoneToJid(phone);
  const payload = await buildMessagePayload(body || {});

  if (!to) {
    return { status: 400, body: { ok: false, error: "Missing jid or phone" } };
  }

  if (payload.error) {
    return { status: 400, body: { ok: false, error: payload.error } };
  }

  if (!sock || connectionStatus !== "connected") {
    return { status: 500, body: { ok: false, error: "WhatsApp is not connected" } };
  }

  try {
    const validation = await validateWhatsAppUser(to);

    if (!validation.ok) {
      return { status: 400, body: { ok: false, to, error: validation.error } };
    }

    const validatedTo = validation.jid || to;
    await sock.sendMessage(validatedTo, payload.message);
    console.log(`Send message success: ${validatedTo}`);

    return {
      status: 200,
      body: {
        ok: true,
        to: validatedTo,
        type: payload.messageType,
        text: payload.responseText
      }
    };
  } catch (error) {
    console.error(`Send message failure: ${to}`, error);
    return { status: 500, body: { ok: false, error: "Failed to send message" } };
  }
}

app.post("/send", requireAdmin, async (req, res) => {
  const result = await sendMessageBody(req.body || {});
  res.status(result.status).json(result.body);
});

app.post("/session/reset", requireAdmin, async (_req, res, next) => {
  try {
    await resetWhatsAppSession({ pauseQueue: true });
    res.json({ ok: true, status: connectionStatus, message: "Login reset. Refresh the QR page in a few seconds." });
  } catch (error) {
    next(error);
  }
});

function buildQueuedItem(rawItem) {
  const payload = { ...(rawItem.payload || rawItem) };
  const clientId = rawItem.clientId ? String(rawItem.clientId) : undefined;
  const phone = payload.phone ? String(payload.phone).replace(/\D/g, "") : "";
  const jid = payload.jid ? String(payload.jid) : "";

  delete payload.clientId;
  delete payload.payload;

  return {
    id: uid(),
    clientId,
    phone,
    jid,
    text: payload.text ? String(payload.text) : "",
    fileName: payload.fileName ? String(payload.fileName) : undefined,
    payload,
    status: "queued",
    attempts: 0,
    lastError: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sentAt: undefined
  };
}

function buildQueuedItems(rawItem) {
  const payload = rawItem.payload || rawItem;
  const text = payload.text == null ? "" : String(payload.text);
  const parts = text
    .split(/\s*\/br\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

  // Keep file-only messages valid, while splitting text messages into ordered sends.
  const messageParts = parts.length ? parts : [text];
  const baseClientId = rawItem.clientId ? String(rawItem.clientId) : undefined;

  return messageParts.map((part, index) =>
    buildQueuedItem({
      ...rawItem,
      clientId: baseClientId && messageParts.length > 1 ? `${baseClientId}-${index + 1}` : baseClientId,
      payload: { ...payload, text: part }
    })
  );
}

async function processSendQueue() {
  if (queueRunning) {
    return;
  }

  queueRunning = true;
  queuePaused = false;

  try {
    let sentInBatch = 0;
    while (!queuePaused) {
      const next = sendQueue.find((item) => item.status === "queued");

      if (!next) {
        break;
      }

      next.status = "sending";
      next.attempts += 1;
      next.lastError = undefined;
      next.updatedAt = new Date().toISOString();
      await saveQueueStore();

      const result = await sendMessageBody(next.payload);

      if (result.body.ok) {
        next.status = "sent";
        next.sentAt = new Date().toISOString();
        next.updatedAt = next.sentAt;
        next.lastError = undefined;
      } else if (result.body.error === "WhatsApp is not connected") {
        next.status = "queued";
        next.lastError = result.body.error;
        next.updatedAt = new Date().toISOString();
        break;
      } else {
        moveQueueItemToEnd(next.id, {
          status: "failed",
          lastError: result.body.error || "Send failed"
        });
      }

      await saveQueueStore();
      if (result.body.ok) sentInBatch += 1;

      if (sentInBatch >= queueSettings.batchSize && sendQueue.some((item) => item.status === "queued")) {
        sentInBatch = 0;
        await waitWhileQueueActive(queueSettings.batchWaitMs);
      } else {
        await waitWhileQueueActive(queueSettings.messageDelayMs);
      }
    }
  } finally {
    queueRunning = false;
    await saveQueueStore();
  }
}

app.get("/queue", requireAdmin, (_req, res) => {
  res.json(getQueueSnapshot());
});

app.post("/queue", requireAdmin, async (req, res, next) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [req.body || {}];
  const items = rawItems.flatMap(buildQueuedItems);

  sendQueue.push(...items);
  try { await saveQueueStore(); } catch (error) { return next(error); }

  res.json({
    ...getQueueSnapshot(),
    added: items.map(publicQueueItem)
  });
});

app.post("/queue/start", requireAdmin, async (_req, res, next) => {
  queuePaused = false;
  try { await saveQueueStore(); } catch (error) { return next(error); }
  processSendQueue().catch((error) => {
    lastBotError = getErrorMessage(error);
    queueRunning = false;
    console.error("Queue worker failure:", error);
  });

  res.json(getQueueSnapshot());
});

app.post("/queue/pause", requireAdmin, async (_req, res, next) => {
  queuePaused = true;
  try { await saveQueueStore(); } catch (error) { return next(error); }
  res.json(getQueueSnapshot());
});

app.post("/queue/settings", requireAdmin, async (req, res, next) => {
  queueSettings = normalizeQueueSettings(req.body || {});
  try { await saveQueueStore(); } catch (error) { return next(error); }
  res.json(getQueueSnapshot());
});

app.post("/queue/requeue", requireAdmin, async (req, res, next) => {
  const id = req.body?.id ? String(req.body.id) : "";

  if (id) {
    moveQueueItemToEnd(id, {
      status: "queued",
      lastError: undefined,
      sentAt: undefined
    });
  } else {
    sendQueue = sendQueue.map((item) =>
      item.status === "failed"
        ? {
            ...item,
            status: "queued",
            lastError: undefined,
            sentAt: undefined,
            updatedAt: new Date().toISOString()
          }
        : item
    );
  }

  try { await saveQueueStore(); } catch (error) { return next(error); }
  res.json(getQueueSnapshot());
});

app.post("/queue/remove", requireAdmin, async (req, res, next) => {
  const id = req.body?.id ? String(req.body.id) : "";
  const item = sendQueue.find((entry) => entry.id === id);

  if (!item) {
    return res.status(404).json({ ok: false, error: "Queue item not found" });
  }

  if (item.status === "sending") {
    return res.status(409).json({ ok: false, error: "A message currently being sent cannot be removed" });
  }

  sendQueue = sendQueue.filter((entry) => entry.id !== id);
  try { await saveQueueStore(); } catch (error) { return next(error); }
  res.json(getQueueSnapshot());
});

app.post("/queue/clear", requireAdmin, async (req, res, next) => {
  const status = req.body?.status ? String(req.body.status) : "";
  const removableStatuses = new Set(["sent", "failed"]);

  if (req.body?.all) {
    sendQueue = sendQueue.filter((item) => item.status === "sending");
  } else if (status && removableStatuses.has(status)) {
    sendQueue = sendQueue.filter((item) => item.status !== status);
  }

  try { await saveQueueStore(); } catch (error) { return next(error); }
  res.json(getQueueSnapshot());
});

async function startBot() {
  if (botStarting) {
    return;
  }

  botStarting = true;
  cleanupSocket();
  currentQr = null;
  connectionStatus = "starting";

  const { state, saveCreds } = await useSupabaseAuthState();
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`Using WhatsApp Web version ${version.join(".")} (${isLatest ? "latest" : "not latest"})`);

  sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS("Chrome"),
    printQRInTerminal: false,
    logger: P({ level: "silent" })
  });

  botStarting = false;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQr = await QRCode.toDataURL(qr);
      connectionStatus = "qr_required";
      console.log("QR generated. Open /qr?token=YOUR_ADMIN_TOKEN to scan.");
    }

    if (connection === "open") {
      currentQr = null;
      connectionStatus = "connected";
      lastBotError = null;
      console.log("WhatsApp connected");
      if (!queuePaused && sendQueue.some((item) => item.status === "queued")) {
        processSendQueue().catch((error) => console.error("Queue resume failure:", error));
      }
    }

    if (connection === "close") {
      currentQr = null;
      connectionStatus = "disconnected";

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const restartRequired = statusCode === DisconnectReason.restartRequired;
      const connectionReplaced = statusCode === DisconnectReason.connectionReplaced;

      lastBotError = lastDisconnect?.error
        ? getErrorMessage(lastDisconnect.error)
        : `Connection closed. Reason: ${statusCode || "unknown"}`;
      console.log(`Connection closed. Reason: ${statusCode || "unknown"}`);

      if (loggedOut) {
        console.log("Logged out. Resetting stored auth so a new QR can be scanned.");
        resetWhatsAppSession().catch((error) => {
          lastBotError = getErrorMessage(error);
          connectionStatus = "disconnected";
          console.error("Automatic login reset failed:", error);
        });
        return;
      }

      if (connectionReplaced) {
        console.log("Connection conflict. Stop other running bot instances that use this SESSION_ID, then restart this service.");
        return;
      }

      if (restartRequired) {
        console.log("WhatsApp requested a stream restart.");
      }

      scheduleReconnect();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;

      if (!remoteJid || msg.key.fromMe || !msg.message) {
        continue;
      }

      const text = getMessageText(msg);

      if (text.toLowerCase() === "ping") {
        await sock.sendMessage(remoteJid, { text: "pong" }, { quoted: msg });
      }
    }
  });
}

async function boot() {
  await loadQueueStore();
  app.listen(port, () => {
    console.log(`Server started on port ${port}`);
  });

  startBot().catch((error) => {
    botStarting = false;
    connectionStatus = "disconnected";
    lastBotError = getErrorMessage(error);
    console.error("Failed to start WhatsApp bot:", error);
    scheduleReconnect();
  });
}

boot().catch((error) => {
  console.error("Failed to boot service:", error);
  process.exit(1);
});
