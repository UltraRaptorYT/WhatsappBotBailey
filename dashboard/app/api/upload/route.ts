import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type UploadBody = {
  dataUrl?: string;
  fileName?: string;
  mimetype?: string;
};

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);

  if (!match) {
    throw new Error("Invalid dataUrl");
  }

  return {
    mimetype: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

export async function POST(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "whatsapp-temp";
  const signedUrlTtl = Number(process.env.SUPABASE_SIGNED_URL_TTL_SECONDS || 1800);

  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json(
      { ok: false, error: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required" },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as UploadBody;

  if (!body.dataUrl || !body.fileName) {
    return Response.json(
      { ok: false, error: "dataUrl and fileName are required" },
      { status: 400 }
    );
  }

  try {
    const parsed = parseDataUrl(body.dataUrl);
    const mimetype = body.mimetype || parsed.mimetype || "application/octet-stream";
    const storagePath = `uploads/${Date.now()}-${crypto.randomUUID()}-${sanitizeFileName(body.fileName)}`;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(storagePath, parsed.buffer, {
        contentType: mimetype,
        upsert: false
      });

    if (uploadError) {
      return Response.json(
        { ok: false, error: uploadError.message },
        { status: 500 }
      );
    }

    const { data, error: signedUrlError } = await supabase.storage
      .from(bucket)
      .createSignedUrl(storagePath, signedUrlTtl);

    if (signedUrlError || !data?.signedUrl) {
      return Response.json(
        { ok: false, error: signedUrlError?.message || "Failed to create signed URL" },
        { status: 500 }
      );
    }

    return Response.json({
      ok: true,
      url: data.signedUrl,
      path: storagePath,
      fileName: body.fileName,
      mimetype,
      expiresIn: signedUrlTtl
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
