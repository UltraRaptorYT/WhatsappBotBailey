export const runtime = "nodejs";

const ALLOWED_METHODS = new Set(["GET", "POST"]);

function parseUrl(value: unknown) {
  try {
    const url = new URL(String(value));

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return url;
  } catch (_error) {
    return null;
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const body = await request.json().catch(() => ({}));
  const targetUrl = parseUrl(body.url);
  const method = String(body.method || "GET").toUpperCase();

  if (!targetUrl) {
    return Response.json(
      { ok: false, error: "Invalid URL" },
      { status: 400 }
    );
  }

  if (!ALLOWED_METHODS.has(method)) {
    return Response.json(
      { ok: false, error: "Only GET and POST are supported" },
      { status: 400 }
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body.payload || {}) : undefined,
      cache: "no-store",
      signal: controller.signal
    });

    const raw = await upstream.text();
    let data = raw;

    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (_error) {
      data = raw;
    }

    return Response.json({
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
      latencyMs: Date.now() - startedAt,
      data
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";

    return Response.json(
      {
        ok: false,
        error: name === "AbortError" ? "Request timed out" : message,
        latencyMs: Date.now() - startedAt
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
