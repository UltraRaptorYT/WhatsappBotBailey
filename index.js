import "dotenv/config";
import express from "express";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import P from "pino";
import QRCode from "qrcode";
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

function getErrorMessage(error) {
  return error?.stack || error?.message || String(error);
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

app.use(express.json());

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
  const metadata = body.url ? await getUrlMetadata(String(body.url)) : {};
  const inferredMimeType = body.mimetype || metadata.mimetype || extensionToMimeType(metadata.fileName);
  const type = body.type || (body.url && inferredMimeType?.startsWith("image/") ? "image" : body.url ? "document" : "text");

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
    if (!body.url) {
      return { error: "Missing image url" };
    }

    return {
      message: {
        image: { url: String(body.url) },
        caption: captionText ? String(captionText) : undefined
      },
      messageType: "image",
      responseText: captionText ? String(captionText) : ""
    };
  }

  if (type === "document") {
    if (!body.url) {
      return { error: "Missing document url" };
    }

    const fileName = body.fileName || metadata.fileName || "document";
    const mimetype = inferredMimeType || "application/octet-stream";

    return {
      message: {
        document: { url: String(body.url) },
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

app.post("/send", requireAdmin, async (req, res) => {
  const { phone, jid } = req.body || {};
  const to = jid || cleanPhoneToJid(phone);
  const payload = await buildMessagePayload(req.body || {});

  if (!to) {
    return res.status(400).json({ ok: false, error: "Missing jid or phone" });
  }

  if (payload.error) {
    return res.status(400).json({ ok: false, error: payload.error });
  }

  if (!sock || connectionStatus !== "connected") {
    return res.status(500).json({ ok: false, error: "WhatsApp is not connected" });
  }

  try {
    await sock.sendMessage(to, payload.message);
    console.log(`Send message success: ${to}`);
    res.json({
      ok: true,
      to,
      type: payload.messageType,
      text: payload.responseText
    });
  } catch (error) {
    console.error(`Send message failure: ${to}`, error);
    res.status(500).json({ ok: false, error: "Failed to send message" });
  }
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
    }

    if (connection === "close") {
      currentQr = null;
      connectionStatus = "disconnected";

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const restartRequired = statusCode === DisconnectReason.restartRequired;

      lastBotError = lastDisconnect?.error
        ? getErrorMessage(lastDisconnect.error)
        : `Connection closed. Reason: ${statusCode || "unknown"}`;
      console.log(`Connection closed. Reason: ${statusCode || "unknown"}`);

      if (loggedOut) {
        console.log("Logged out. Clear Supabase auth rows and scan QR again.");
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
