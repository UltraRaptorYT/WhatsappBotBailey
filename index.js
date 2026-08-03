import "dotenv/config";
import express from "express";
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

app.get("/qr", requireAdmin, (_req, res) => {
  if (currentQr) {
    return res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>WhatsApp QR</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; text-align: center; }
      img { width: min(320px, 90vw); height: auto; }
    </style>
  </head>
  <body>
    <h1>Scan this WhatsApp QR</h1>
    <p>Open WhatsApp -> Linked devices -> Link a device</p>
    <img src="${currentQr}" alt="WhatsApp login QR code">
  </body>
</html>`);
  }

  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>WhatsApp QR</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; text-align: center; }
    </style>
  </head>
  <body>
    <h1>No QR right now</h1>
    <p>Status: ${connectionStatus}</p>
    <p>If already connected, you do not need to scan again.</p>
    ${lastBotError ? `<pre>${lastBotError}</pre>` : ""}
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
        console.log("Logged out. Clear Supabase auth rows and scan QR again.");
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
