"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ExcelJS from "exceljs";
import {
  Activity,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  FileUp,
  Image,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Send,
  Server,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const defaultBotUrl =
  process.env.NEXT_PUBLIC_DEFAULT_BOT_URL || "https://whatsappbotbailey.onrender.com";
const adminTokenStorageKey = "baileys-dashboard-admin-token";
const activeTabStorageKey = "baileys-dashboard-active-tab";
const attachmentDbName = "baileys-dashboard-attachments";
const attachmentStoreName = "attachments";
const memoryAttachments = new Map<string, StoredAttachment>();
const maxUploadBytes = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB || 50) * 1024 * 1024;

type UploadFile = {
  attachmentId: string;
  fileName: string;
  mimetype: string;
  size: number;
};

type StoredAttachment = UploadFile & {
  dataUrl: string;
};

type QueueStatus = "queued" | "sending" | "sent" | "failed";
type QueueFilter = "all" | QueueStatus;

type QueueItem = {
  id: string;
  serverId?: string;
  phone: string;
  text: string;
  file?: UploadFile;
  url?: string;
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  sentAt?: string;
};

type QueueSettings = {
  batchSize: number;
  batchWaitMs: number;
  messageDelayMs: number;
};

type QueueSettingsDraft = {
  batchSize: string;
  batchWaitMinutes: string;
  messageDelaySeconds: string;
};

type ProxyResult = {
  ok: boolean;
  status?: number;
  statusText?: string;
  latencyMs?: number;
  data?: unknown;
  error?: string;
};

type ServerQueueItem = {
  id: string;
  clientId?: string;
  phone: string;
  text: string;
  fileName?: string;
  hasAttachment?: boolean;
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  sentAt?: string;
};

type ServerQueueResponse = {
  ok: boolean;
  running: boolean;
  paused: boolean;
  settings: QueueSettings;
  items: ServerQueueItem[];
  added?: ServerQueueItem[];
};

type UploadResult = {
  ok: boolean;
  url?: string;
  fileName?: string;
  mimetype?: string;
  error?: string;
};

function moveQueueItemToEnd(items: QueueItem[], id: string, patch: Partial<QueueItem>) {
  const item = items.find((entry) => entry.id === id);

  if (!item) {
    return items;
  }

  return [...items.filter((entry) => entry.id !== id), { ...item, ...patch }];
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toQueueSettingsDraft(settings: QueueSettings): QueueSettingsDraft {
  return {
    batchSize: String(settings.batchSize),
    batchWaitMinutes: String(settings.batchWaitMs / 60000),
    messageDelaySeconds: String(settings.messageDelayMs / 1000)
  };
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((items) => items.some((item) => item.trim()));
}

function cellToText(value: unknown) {
  if (value == null) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (typeof record.text === "string") {
      return record.text;
    }

    if (typeof record.hyperlink === "string") {
      return record.hyperlink;
    }

    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    }
  }

  return String(value);
}

function replaceTemplateColumns(template: string, headers: string[], row: string[]) {
  return headers.reduce((message, header, index) => {
    const value = row[index] || "";
    return message.split(`{${header}}`).join(value);
  }, template);
}

function getHeaderIndex(headers: string[], names: string[]) {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  return names
    .map((name) => normalized.indexOf(name.toLowerCase()))
    .find((index) => index >= 0) ?? -1;
}

function normalizePhone(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  const digits = trimmed.replace(/\D/g, "");

  if (!trimmed.startsWith("+") && digits.length === 8) {
    return `65${digits}`;
  }

  return digits;
}

function rowsToQueueItems(rows: string[][], defaultText: string, file?: UploadFile) {
  if (!rows.length) {
    return [];
  }

  const headers = rows[0].map((header) => header.trim());
  const lowerHeaders = headers.map((header) => header.toLowerCase());
  const hasHeader =
    lowerHeaders.includes("mobile number") ||
    lowerHeaders.includes("phone") ||
    lowerHeaders.includes("text") ||
    lowerHeaders.includes("message");
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const phoneIndex = hasHeader
    ? getHeaderIndex(headers, ["Mobile Number", "phone", "number"])
    : 0;
  const textIndex = hasHeader ? getHeaderIndex(headers, ["text", "message", "caption"]) : 1;
  const imageUrlIndex = hasHeader ? getHeaderIndex(headers, ["ImageURL", "Image URL", "image"]) : -1;

  return dataRows
    .map((row) => {
      const phone = normalizePhone(String(row[phoneIndex] || ""));
      const rowText = textIndex >= 0 ? String(row[textIndex] || "").trim() : "";
      const template = rowText || defaultText;
      const message = hasHeader ? replaceTemplateColumns(template, headers, row) : template;
      const imageUrl = imageUrlIndex >= 0 ? String(row[imageUrlIndex] || "").trim() : "";

      if (!phone) {
        return null;
      }

      return {
        id: uid(),
        phone,
        text: message,
        file,
        url: imageUrl || undefined,
        status: "queued" as QueueStatus,
        attempts: 0,
        createdAt: new Date().toISOString()
      };
    })
    .filter(Boolean) as QueueItem[];
}

async function readUploadFile(file: File): Promise<UploadFile> {
  if (file.size > maxUploadBytes) {
    throw new Error(
      `File is too large. Max upload is ${Math.floor(maxUploadBytes / 1024 / 1024)} MB.`
    );
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

  const attachment: StoredAttachment = {
    attachmentId: uid(),
    dataUrl,
    fileName: file.name,
    mimetype: file.type || "application/octet-stream",
    size: file.size
  };

  await saveAttachment(attachment);

  return {
    attachmentId: attachment.attachmentId,
    fileName: attachment.fileName,
    mimetype: attachment.mimetype,
    size: attachment.size
  };
}

function openAttachmentDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(attachmentDbName, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(attachmentStoreName, { keyPath: "attachmentId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open attachment storage"));
  });
}

async function saveAttachment(attachment: StoredAttachment) {
  memoryAttachments.set(attachment.attachmentId, attachment);

  try {
    const db = await openAttachmentDb();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(attachmentStoreName, "readwrite");
      tx.objectStore(attachmentStoreName).put(attachment);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to save attachment"));
    });

    db.close();
  } catch (error) {
    console.warn("Attachment saved in memory only:", error);
  }
}

async function getAttachment(attachmentId: string) {
  const memoryAttachment = memoryAttachments.get(attachmentId);

  if (memoryAttachment) {
    return memoryAttachment;
  }

  try {
    const db = await openAttachmentDb();

    const attachment = await new Promise<StoredAttachment | undefined>((resolve, reject) => {
      const tx = db.transaction(attachmentStoreName, "readonly");
      const request = tx.objectStore(attachmentStoreName).get(attachmentId);
      request.onsuccess = () => resolve(request.result as StoredAttachment | undefined);
      request.onerror = () => reject(request.error || new Error("Failed to read attachment"));
    });

    db.close();
    return attachment;
  } catch (error) {
    console.warn("Could not read IndexedDB attachment:", error);
    return undefined;
  }
}

async function deleteAttachment(attachmentId: string) {
  memoryAttachments.delete(attachmentId);

  try {
    const db = await openAttachmentDb();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(attachmentStoreName, "readwrite");
      tx.objectStore(attachmentStoreName).delete(attachmentId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to delete attachment"));
    });

    db.close();
  } catch (error) {
    console.warn("Could not delete IndexedDB attachment:", error);
  }
}

async function readRecipientsFile(file: File, defaultText: string, attachment?: UploadFile) {
  if (file.name.toLowerCase().endsWith(".csv")) {
    const text = await file.text();
    return rowsToQueueItems(parseCsv(text), defaultText, attachment);
  }

  const workbook = new ExcelJS.Workbook();
  const buffer = await file.arrayBuffer();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];

  if (!sheet) {
    return [];
  }

  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const values = Array.isArray(row.values) ? row.values : [];
    rows.push(values.slice(1).map(cellToText));
  });

  return rowsToQueueItems(rows, defaultText, attachment);
}

function ResultPanel({ result }: { result: ProxyResult | null }) {
  if (!result) {
    return (
      <div className="result empty">
        <Activity size={18} />
        <span>No request yet</span>
      </div>
    );
  }

  const Icon = result.ok ? CheckCircle2 : XCircle;

  return (
    <div className={`result ${result.ok ? "good" : "bad"}`}>
      <div className="resultHeader">
        <span>
          <Icon size={18} />
          {result.ok ? "Reachable" : "Failed"}
        </span>
        <span>
          <Clock3 size={16} />
          {result.latencyMs ?? "-"} ms
        </span>
      </div>
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}

function getSendErrorMessage(result: ProxyResult) {
  const nestedError =
    result.data && typeof result.data === "object" && "error" in result.data
      ? String((result.data as { error?: unknown }).error || "")
      : "";
  const error = nestedError || result.error || "Send failed";

  if (
    error.toLowerCase().includes("not on whatsapp") ||
    error.toLowerCase().includes("invalid phone")
  ) {
    return "Send failed - Phone Number is wrong";
  }

  return error === "Send failed" ? "Send failed" : `Send failed - ${error}`;
}

export default function Home() {
  const [baseUrl, setBaseUrl] = useState(defaultBotUrl);
  const [adminToken, setAdminToken] = useState("");
  const [rememberToken, setRememberToken] = useState(false);
  const [singlePhone, setSinglePhone] = useState("");
  const [singleText, setSingleText] = useState("Hello from dashboard");
  const [singleFile, setSingleFile] = useState<UploadFile | undefined>();
  const [bulkText, setBulkText] = useState("Hello from dashboard");
  const [bulkFile, setBulkFile] = useState<UploadFile | undefined>();
  const [bulkRecipientFile, setBulkRecipientFile] = useState<File | undefined>();
  const [bulkRecipientName, setBulkRecipientName] = useState("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [activeTab, setActiveTab] = useState<"bulk" | "single">("bulk");
  const [queueSettings, setQueueSettings] = useState<QueueSettings>({
    batchSize: 5,
    batchWaitMs: 5 * 60 * 1000,
    messageDelayMs: 1200
  });
  const [queueSettingsDraft, setQueueSettingsDraft] = useState<QueueSettingsDraft>({
    batchSize: "5",
    batchWaitMinutes: "5",
    messageDelaySeconds: "1.2"
  });
  const [running, setRunning] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [result, setResult] = useState<ProxyResult | null>(null);
  const runningRef = useRef(false);
  const queueSettingsDraftDirtyRef = useRef(false);

  const endpoints = useMemo(() => {
    const token = encodeURIComponent(adminToken);

    return {
      health: joinUrl(baseUrl, "/health"),
      status: joinUrl(baseUrl, `/status?token=${token}`),
      qr: joinUrl(baseUrl, `/qr?token=${token}`),
      send: joinUrl(baseUrl, `/send?token=${token}`),
      queue: joinUrl(baseUrl, `/queue?token=${token}`),
      queueStart: joinUrl(baseUrl, `/queue/start?token=${token}`),
      queuePause: joinUrl(baseUrl, `/queue/pause?token=${token}`),
      queueRequeue: joinUrl(baseUrl, `/queue/requeue?token=${token}`),
      queueRemove: joinUrl(baseUrl, `/queue/remove?token=${token}`),
      queueClear: joinUrl(baseUrl, `/queue/clear?token=${token}`),
      queueSettings: joinUrl(baseUrl, `/queue/settings?token=${token}`)
    };
  }, [adminToken, baseUrl]);

  const counts = useMemo(
    () => ({
      all: queue.length,
      queued: queue.filter((item) => item.status === "queued").length,
      sending: queue.filter((item) => item.status === "sending").length,
      sent: queue.filter((item) => item.status === "sent").length,
      failed: queue.filter((item) => item.status === "failed").length
    }),
    [queue]
  );

  const filteredQueue = useMemo(
    () => (queueFilter === "all" ? queue : queue.filter((item) => item.status === queueFilter)),
    [queue, queueFilter]
  );

  const queueFilterTabs: { value: QueueFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.all },
    { value: "queued", label: "Queued", count: counts.queued },
    { value: "sending", label: "Sending", count: counts.sending },
    { value: "sent", label: "Sent", count: counts.sent },
    { value: "failed", label: "Failed", count: counts.failed }
  ];

  useEffect(() => {
    const storedToken = localStorage.getItem(adminTokenStorageKey);
    const storedActiveTab = localStorage.getItem(activeTabStorageKey);

    if (storedToken) {
      setAdminToken(storedToken);
      setRememberToken(true);
    }

    if (storedActiveTab === "bulk" || storedActiveTab === "single") {
      setActiveTab(storedActiveTab);
    }

  }, []);

  useEffect(() => {
    if (rememberToken && adminToken) {
      localStorage.setItem(adminTokenStorageKey, adminToken);
    }

    if (!rememberToken) {
      localStorage.removeItem(adminTokenStorageKey);
    }
  }, [adminToken, rememberToken]);

  async function callApi(
    action: string,
    url: string,
    method: "GET" | "POST" = "GET",
    payload: Record<string, unknown> | null = null
  ): Promise<ProxyResult> {
    setBusyAction(action);
    setResult(null);

    try {
      const response = await fetch("/api/ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, method, payload })
      });
      const data = (await response.json()) as ProxyResult;
      setResult(data);
      return data;
    } catch (error) {
      const data: ProxyResult = {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
      setResult(data);
      return data;
    } finally {
      setBusyAction("");
    }
  }

  function getServerQueueData(result: ProxyResult | null) {
    const data = result?.data as ServerQueueResponse | undefined;
    return data?.ok && Array.isArray(data.items) ? data : null;
  }

  function syncServerQueue(serverItems: ServerQueueItem[]) {
    setQueue(serverItems.map((item) => ({
      id: item.clientId || item.id,
      serverId: item.id,
      phone: item.phone,
      text: item.text,
      status: item.status,
      attempts: item.attempts,
      lastError: item.lastError,
      sentAt: item.sentAt,
      createdAt: ""
    })));
  }

  function syncQueueSettingsFromServer(settings: QueueSettings, overwriteDraft = false) {
    setQueueSettings(settings);

    if (overwriteDraft || !queueSettingsDraftDirtyRef.current) {
      setQueueSettingsDraft(toQueueSettingsDraft(settings));
    }
  }

  function updateQueueSettingsDraft(
    field: keyof QueueSettingsDraft,
    value: string
  ) {
    queueSettingsDraftDirtyRef.current = true;
    setQueueSettingsDraft((settings) => ({ ...settings, [field]: value }));
  }

  async function buildServerQueuePayload(item: QueueItem) {
    const payload: Record<string, unknown> = {
      clientId: item.id,
      phone: item.phone,
      text: item.text
    };

    if (item.file) {
      const attachment = await getAttachment(item.file.attachmentId);

      if (!attachment) {
        throw new Error(`Missing attachment: ${item.file.fileName}`);
      }

      const uploaded = await uploadAttachment(attachment);
      if (!uploaded.ok || !uploaded.url) {
        throw new Error(uploaded.error || `Failed to upload ${attachment.fileName}`);
      }
      payload.url = uploaded.url;
      payload.fileName = uploaded.fileName || attachment.fileName;
      payload.mimetype = uploaded.mimetype || attachment.mimetype;
    } else if (item.url) {
      payload.url = item.url;
    }

    return payload;
  }

  async function uploadAttachment(attachment: StoredAttachment): Promise<UploadResult> {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dataUrl: attachment.dataUrl,
        fileName: attachment.fileName,
        mimetype: attachment.mimetype
      })
    });

    return (await response.json()) as UploadResult;
  }

  async function sendPayloadInBrowser(item: QueueItem) {
    const payload: Record<string, unknown> = {
      phone: item.phone,
      text: item.text
    };

    if (item.file) {
      const attachment = await getAttachment(item.file.attachmentId);

      if (!attachment) {
        return {
          ok: false,
          error: `Missing attachment: ${item.file.fileName}`
        };
      }

      const uploaded = await uploadAttachment(attachment);

      if (!uploaded.ok || !uploaded.url) {
        return {
          ok: false,
          error: uploaded.error || `Failed to upload ${item.file.fileName}`
        };
      }

      payload.url = uploaded.url;
      payload.fileName = uploaded.fileName || attachment.fileName;
      payload.mimetype = uploaded.mimetype || attachment.mimetype;
    } else if (item.url) {
      payload.url = item.url;
    }

    return callApi("send", endpoints.send, "POST", payload);
  }

  async function processQueueInBrowser() {
    while (runningRef.current) {
      const next = queueRef.current.find((item) => item.status === "queued");

      if (!next) {
        break;
      }

      setQueue((items) =>
        items.map((item) =>
          item.id === next.id
            ? { ...item, status: "sending", attempts: item.attempts + 1, lastError: undefined }
            : item
        )
      );

      const health = await callApi("health", endpoints.health);

      if (!health.ok) {
        setQueue((items) =>
          moveQueueItemToEnd(items, next.id, {
            status: "queued",
            lastError: "Health check failed"
          })
        );
        break;
      }

      const sendResult = await sendPayloadInBrowser(next);

      setQueue((items) =>
        sendResult.ok
          ? items.map((item) =>
              item.id === next.id
                ? { ...item, status: "sent", sentAt: new Date().toISOString(), lastError: undefined }
                : item
            )
          : moveQueueItemToEnd(items, next.id, {
              status: "failed",
              lastError: getSendErrorMessage(sendResult)
            })
      );

      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  async function enqueueQueuedItemsOnServer(): Promise<"server" | "empty" | "unsupported" | "failed"> {
    const pending = queueRef.current.filter((item) => item.status === "queued" && !item.serverId);

    if (!pending.length) {
      return "empty";
    }

    try {
      const payloads = await Promise.all(pending.map(buildServerQueuePayload));
      const result = await callApi("queue", endpoints.queue, "POST", { items: payloads });
      const data = getServerQueueData(result);

      if (result.status === 404 || result.status === 405) {
        return "unsupported";
      }

      if (!result.ok || !data) {
        throw new Error(getSendErrorMessage(result));
      }

      syncServerQueue(data.items);
      return "server";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedIds = new Set(pending.map((item) => item.id));

      setQueue((items) =>
        items.map((item) =>
          failedIds.has(item.id) ? { ...item, status: "failed", lastError: message } : item
        )
      );
      setResult({ ok: false, error: message });
      return "failed";
    }
  }

  async function addItemsToServer(items: QueueItem[]) {
    const payloads = await Promise.all(items.map(buildServerQueuePayload));
    const response = await callApi("queue", endpoints.queue, "POST", { items: payloads });
    const data = getServerQueueData(response);
    if (!response.ok || !data) {
      throw new Error(getSendErrorMessage(response));
    }
    syncServerQueue(data.items);
    syncQueueSettingsFromServer(data.settings);
  }

  async function refreshServerQueue() {
    const result = await callApi("queue-status", endpoints.queue);
    const data = getServerQueueData(result);

    if (data) {
      syncServerQueue(data.items);
      syncQueueSettingsFromServer(data.settings);
    }

    return data;
  }

  async function pollServerQueue() {
    while (runningRef.current) {
      const data = await refreshServerQueue();

      if (!data?.running) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async function processQueue() {
    if (runningRef.current) {
      return;
    }

    runningRef.current = true;
    setRunning(true);

    try {
      const enqueueMode = await enqueueQueuedItemsOnServer();

      if (enqueueMode === "failed") {
        return;
      }

      if (enqueueMode === "unsupported") {
        setResult({
          ok: false,
          error: "Backend queue is not deployed yet. Sending from this browser tab instead."
        });
        await processQueueInBrowser();
        return;
      }

      const started = await callApi("queue-start", endpoints.queueStart, "POST", {});
      const data = getServerQueueData(started);

      if (!started.ok || !data) {
        setResult({
          ok: false,
          error: "Backend queue could not start. Sending from this browser tab instead."
        });
        await processQueueInBrowser();
        return;
      }

      if (data) {
        syncServerQueue(data.items);
      }

      await pollServerQueue();
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  const queueRef = useRef(queue);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    if (!adminToken) {
      return;
    }

    refreshServerQueue().catch(() => undefined);
    const interval = window.setInterval(() => refreshServerQueue().catch(() => undefined), 5000);
    return () => window.clearInterval(interval);
  }, [adminToken, baseUrl]);

  async function handleSingleFile(file?: File) {
    try {
      setSingleFile(file ? await readUploadFile(file) : undefined);
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function handleBulkFile(file?: File) {
    try {
      setBulkFile(file ? await readUploadFile(file) : undefined);
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function loadBulkIntoQueue() {
    const file = bulkRecipientFile;

    if (!file) {
      setResult({ ok: false, error: "Choose a CSV or Excel file first" });
      return;
    }

    setBusyAction("import");
    try {
      const imported = await readRecipientsFile(file, bulkText, bulkFile);
      await addItemsToServer(imported);
      setResult({
        ok: true,
        data: {
          imported: imported.length,
          source: file.name
        }
      });
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setBusyAction("");
    }
  }

  function stageBulkRecipients(file?: File) {
    setBulkRecipientFile(file);
    setBulkRecipientName(file?.name || "");

    if (file) {
      setResult({
        ok: true,
        data: {
          staged: file.name,
          action: "Click Load Into Queue to import recipients"
        }
      });
    }
  }

  async function enqueueSingle() {
    const phone = singlePhone.replace(/\D/g, "");

    if (!phone) {
      setResult({ ok: false, error: "Phone is required" });
      return;
    }

    try {
      await addItemsToServer([
        {
        id: uid(),
        phone,
        text: singleText,
        file: singleFile,
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString()
        }
      ]);
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function saveQueueSettings() {
    const hasEmptyValue = Object.values(queueSettingsDraft).some((value) => value.trim() === "");
    const batchSize = Number(queueSettingsDraft.batchSize);
    const batchWaitMinutes = Number(queueSettingsDraft.batchWaitMinutes);
    const messageDelaySeconds = Number(queueSettingsDraft.messageDelaySeconds);

    if (hasEmptyValue) {
      setResult({ ok: false, error: "All rate controls need a value" });
      return;
    }

    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      setResult({ ok: false, error: "Messages per batch must be a whole number from 1 to 1000" });
      return;
    }

    if (!Number.isFinite(batchWaitMinutes) || batchWaitMinutes < 0 || batchWaitMinutes > 1440) {
      setResult({ ok: false, error: "Wait between batches must be from 0 to 1440 minutes" });
      return;
    }

    if (!Number.isFinite(messageDelaySeconds) || messageDelaySeconds < 0 || messageDelaySeconds > 60) {
      setResult({ ok: false, error: "Delay between messages must be from 0 to 60 seconds" });
      return;
    }

    const settings: QueueSettings = {
      batchSize,
      batchWaitMs: Math.round(batchWaitMinutes * 60000),
      messageDelayMs: Math.round(messageDelaySeconds * 1000)
    };
    const response = await callApi("queue-settings", endpoints.queueSettings, "POST", settings);
    const data = getServerQueueData(response);
    if (data) {
      queueSettingsDraftDirtyRef.current = false;
      syncQueueSettingsFromServer(data.settings, true);
      syncServerQueue(data.items);
    }
  }

  async function clearFinished() {
    await callApi("queue-clear", endpoints.queueClear, "POST", { status: "sent" });

    const sentAttachments = queue
      .filter((item) => item.status === "sent" && item.file)
      .map((item) => item.file!.attachmentId)
      .filter(
        (attachmentId) =>
          !queue.some((item) => item.status !== "sent" && item.file?.attachmentId === attachmentId)
      );

    await Promise.all([...new Set(sentAttachments)].map(deleteAttachment));
    setQueue((items) => items.filter((item) => item.status !== "sent"));
  }

  async function retryFailed() {
    setQueue((items) =>
      items.map((item) =>
        item.status === "failed" ? { ...item, status: "queued", lastError: undefined } : item
      )
    );

    const result = await callApi("queue-requeue", endpoints.queueRequeue, "POST", {});
    const data = getServerQueueData(result);

    if (data) {
      syncServerQueue(data.items);
    }
  }

  async function requeueItem(id: string) {
    const item = queue.find((entry) => entry.id === id);

    if (item?.serverId) {
      const result = await callApi("queue-requeue", endpoints.queueRequeue, "POST", {
        id: item.serverId
      });
      const data = getServerQueueData(result);

      if (data) {
        syncServerQueue(data.items);
        return;
      }
    }

    setQueue((items) =>
      moveQueueItemToEnd(items, id, {
        status: "queued",
        lastError: undefined
      })
    );
  }

  async function pauseQueue() {
    runningRef.current = false;
    setRunning(false);

    const result = await callApi("queue-pause", endpoints.queuePause, "POST", {});
    const data = getServerQueueData(result);

    if (data) {
      syncServerQueue(data.items);
    }
  }

  async function removeQueueItem(id: string) {
    const item = queue.find((entry) => entry.id === id);

    if (!item?.serverId) {
      setResult({ ok: false, error: "This queue item has not been saved to the shared queue yet" });
      return;
    }

    const response = await callApi("queue-remove", endpoints.queueRemove, "POST", { id: item.serverId });
    const data = getServerQueueData(response);

    if (!data) {
      return;
    }

    if (
      item?.file &&
      !queue.some((entry) => entry.id !== id && entry.file?.attachmentId === item.file?.attachmentId)
    ) {
      await deleteAttachment(item.file.attachmentId);
    }

    syncServerQueue(data.items);
  }

  async function removeQueueItemAttachment(id: string) {
    const item = queue.find((entry) => entry.id === id);

    if (
      item?.file &&
      !queue.some((entry) => entry.id !== id && entry.file?.attachmentId === item.file?.attachmentId)
    ) {
      await deleteAttachment(item.file.attachmentId);
    }

    setQueue((items) =>
      items.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              file: undefined,
              status: entry.status === "failed" ? "queued" : entry.status,
              lastError: undefined
            }
          : entry
      )
    );
  }

  async function clearQueue() {
    await callApi("queue-clear", endpoints.queueClear, "POST", { all: true });

    const attachments = queue.filter((item) => item.file).map((item) => item.file!.attachmentId);

    await Promise.all([...new Set(attachments)].map(deleteAttachment));
    setQueue([]);
    setRunning(false);
    runningRef.current = false;
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Baileys WhatsApp Bot</p>
          <h1>API Dashboard</h1>
        </div>
        <div className="topActions">
          <Button asChild variant="outline">
            <a href={endpoints.qr} target="_blank" rel="noreferrer">
              <FileUp size={17} />
              QR Page
            </a>
          </Button>
          <Button onClick={() => callApi("health", endpoints.health)} disabled={busyAction !== ""}>
            {busyAction === "health" ? <Loader2 className="spin" size={17} /> : <Activity size={17} />}
            Health
          </Button>
          <Button
            variant="secondary"
            onClick={() => callApi("status", endpoints.status)}
            disabled={busyAction !== "" || !adminToken}
          >
            {busyAction === "status" ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            Status
          </Button>
        </div>
      </section>

      <section className="panel settings">
        <div className="field">
          <Label htmlFor="baseUrl">Bot base URL</Label>
          <Input
            id="baseUrl"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://your-render-app.onrender.com"
          />
        </div>
        <div className="field">
          <Label htmlFor="adminToken">Admin token</Label>
          <Input
            id="adminToken"
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
            placeholder="Paste ADMIN_TOKEN"
            type="password"
          />
          <label className="checkRow">
            <input
              checked={rememberToken}
              onChange={(event) => setRememberToken(event.target.checked)}
              type="checkbox"
            />
            <span>Remember token on this browser</span>
          </label>
        </div>
      </section>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (value === "bulk" || value === "single") {
            setActiveTab(value);
            localStorage.setItem(activeTabStorageKey, value);
          }
        }}
        className="tabsWrap"
      >
        <TabsList>
          <TabsTrigger value="bulk">
            <FileSpreadsheet size={16} />
            Bulk Messaging
          </TabsTrigger>
          <TabsTrigger value="single">
            <Send size={16} />
            Single Message
          </TabsTrigger>
        </TabsList>

        <TabsContent value="single">
          <section className="panel formPanel">
            <div className="panelTitle">
              <Send size={20} />
              <h2>Single Message</h2>
            </div>
            <div className="formGrid">
              <div className="field">
                <Label htmlFor="singlePhone">Phone</Label>
                <Input
                  id="singlePhone"
                  value={singlePhone}
                  onChange={(event) => setSinglePhone(event.target.value)}
                  placeholder="6591234567"
                />
              </div>
              <div className="field">
                <Label htmlFor="singleUpload">Image or document</Label>
                <Input
                  id="singleUpload"
                  type="file"
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                  onChange={(event) => handleSingleFile(event.target.files?.[0])}
                />
              </div>
            </div>
            <div className="field">
              <Label htmlFor="singleText">Text</Label>
              <Textarea
                id="singleText"
                value={singleText}
                onChange={(event) => setSingleText(event.target.value)}
                rows={4}
              />
            </div>
            {singleFile ? (
              <div className="fileChip">
                <Image size={16} />
                {singleFile.fileName} ({Math.ceil(singleFile.size / 1024)} KB)
              </div>
            ) : null}
            <div className="buttonRow">
              <Button onClick={enqueueSingle} disabled={!singlePhone || (!singleText && !singleFile)}>
                <Upload size={17} />
                Add To Queue
              </Button>
              <Button onClick={processQueue} disabled={running || !adminToken || !counts.queued}>
                {running ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
                Start Queue
              </Button>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="bulk">
          <section className="panel formPanel">
            <div className="panelTitle">
              <FileSpreadsheet size={20} />
              <h2>Bulk Message</h2>
            </div>
            <div className="formGrid">
              <div className="field">
                <Label htmlFor="bulkRecipients">CSV or Excel recipients</Label>
                <Input
                  id="bulkRecipients"
                  type="file"
                  accept=".csv,.xlsx"
                  onChange={(event) => stageBulkRecipients(event.target.files?.[0])}
                />
              </div>
              <div className="field">
                <Label htmlFor="bulkUpload">Shared image or document</Label>
                <Input
                  id="bulkUpload"
                  type="file"
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                  onChange={(event) => handleBulkFile(event.target.files?.[0])}
                />
              </div>
            </div>
            <div className="field">
              <Label htmlFor="bulkText">Default text</Label>
              <Textarea
                id="bulkText"
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
                rows={4}
              />
            </div>
            {bulkFile ? (
              <div className="fileChip">
                <FileUp size={16} />
                {bulkFile.fileName} ({Math.ceil(bulkFile.size / 1024)} KB)
              </div>
            ) : null}
            {bulkRecipientName ? (
              <div className="fileChip">
                <FileSpreadsheet size={16} />
                {bulkRecipientName} staged
              </div>
            ) : null}
            <div className="buttonRow">
              <Button
                onClick={loadBulkIntoQueue}
                disabled={!bulkRecipientFile || busyAction === "import"}
              >
                {busyAction === "import" ? (
                  <Loader2 className="spin" size={17} />
                ) : (
                  <Upload size={17} />
                )}
                Load Into Queue
              </Button>
            </div>
            <p className="hint">
              Recipient file columns: `Mobile Number` or `phone`, optional `text`, and optional
              `ImageURL`. Message templates can use placeholders like {"{Name}"} or{" "}
              {"{Mobile Number}"}. Add `/br` anywhere in the message to send the text before and
              after it as separate messages.
            </p>
          </section>
        </TabsContent>
      </Tabs>

      <section className="panel queuePanel">
        <div className="queueHeader">
          <div className="panelTitle">
            <Server size={20} />
            <h2>Durable Send Queue</h2>
          </div>
          <div className="queueActions">
            <Button onClick={processQueue} disabled={running || !adminToken || !counts.queued}>
              {running ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
              Resume
            </Button>
            <Button
              variant="secondary"
              onClick={pauseQueue}
              disabled={!running}
            >
              <Pause size={17} />
              Pause
            </Button>
            <Button variant="outline" onClick={refreshServerQueue} disabled={!adminToken}>
              <RefreshCw size={17} />
              Sync
            </Button>
            <Button variant="outline" onClick={retryFailed} disabled={!counts.failed}>
              <RefreshCw size={17} />
              Retry Failed
            </Button>
            <Button variant="outline" onClick={clearFinished} disabled={!counts.sent}>
              <Trash2 size={17} />
              Clear Sent
            </Button>
            <Button variant="destructive" onClick={clearQueue} disabled={!queue.length}>
              <Trash2 size={17} />
              Clear All
            </Button>
          </div>
        </div>
        <div className="formGrid queueRateControls">
          <div className="field">
            <Label htmlFor="batchSize">Messages per batch</Label>
            <Input
              id="batchSize"
              type="text"
              inputMode="numeric"
              value={queueSettingsDraft.batchSize}
              onChange={(event) => updateQueueSettingsDraft("batchSize", event.target.value)}
            />
          </div>
          <div className="field">
            <Label htmlFor="batchWait">Wait between batches (minutes)</Label>
            <Input
              id="batchWait"
              type="text"
              inputMode="decimal"
              value={queueSettingsDraft.batchWaitMinutes}
              onChange={(event) => updateQueueSettingsDraft("batchWaitMinutes", event.target.value)}
            />
          </div>
          <div className="field">
            <Label htmlFor="messageDelay">Delay between messages (seconds)</Label>
            <Input
              id="messageDelay"
              type="text"
              inputMode="decimal"
              value={queueSettingsDraft.messageDelaySeconds}
              onChange={(event) => updateQueueSettingsDraft("messageDelaySeconds", event.target.value)}
            />
          </div>
          <div className="field rateSave">
            <Label>&nbsp;</Label>
            <Button variant="secondary" onClick={saveQueueSettings} disabled={!adminToken || busyAction === "queue-settings"}>
              Save rate controls
            </Button>
          </div>
        </div>
        <div className="stats">
          <span>Queued {counts.queued}</span>
          <span>Sending {counts.sending}</span>
          <span>Sent {counts.sent}</span>
          <span>Failed {counts.failed}</span>
        </div>
        <Tabs value={queueFilter} onValueChange={(value) => setQueueFilter(value as QueueFilter)}>
          <TabsList className="queueTabs">
            {queueFilterTabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label} {tab.count}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="queueList">
          {filteredQueue.slice(0, 80).map((item) => (
            <div className={`queueItem ${item.status}`} key={item.id}>
              <div>
                <strong>{item.phone}</strong>
                <span>{item.text || item.file?.fileName || "No text"}</span>
              </div>
              <div>
                <span>{item.file ? item.file.fileName : item.url ? item.url : "text"}</span>
                <span>{item.status} · attempts {item.attempts}</span>
                {item.lastError ? <span>{item.lastError}</span> : null}
                <div className="itemActions">
                  {item.status === "failed" ? (
                    <Button size="sm" variant="secondary" onClick={() => requeueItem(item.id)}>
                      Requeue
                    </Button>
                  ) : null}
                  {item.file ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => removeQueueItemAttachment(item.id)}
                    >
                      Drop File
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => removeQueueItem(item.id)}>
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {!queue.length ? <div className="emptyQueue">No messages queued</div> : null}
          {queue.length && !filteredQueue.length ? (
            <div className="emptyQueue">No {queueFilter} messages</div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panelTitle">
          <Activity size={20} />
          <h2>Last Response</h2>
        </div>
        <ResultPanel result={result} />
      </section>
    </main>
  );
}
