import { createClient } from "@supabase/supabase-js";
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";

const TABLE_NAME = "baileys_auth";

function encode(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function decode(value) {
  if (value == null) {
    return null;
  }

  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

export async function useSupabaseAuthState() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sessionId = process.env.SESSION_ID || "main";

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  async function readData(key) {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("value")
      .eq("session_id", sessionId)
      .eq("key", key)
      .maybeSingle();

    if (error) {
      console.error(`Supabase read error for ${key}:`, error.message);
      return null;
    }

    return decode(data?.value);
  }

  async function readManyData(keys) {
    if (!keys.length) {
      return new Map();
    }

    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("key,value")
      .eq("session_id", sessionId)
      .in("key", keys);

    if (error) {
      console.error("Supabase bulk read error:", error.message);
      return new Map();
    }

    return new Map((data || []).map((row) => [row.key, decode(row.value)]));
  }

  async function writeData(key, value) {
    const { error } = await supabase
      .from(TABLE_NAME)
      .upsert(
        {
          session_id: sessionId,
          key,
          value: encode(value),
          updated_at: new Date().toISOString()
        },
        { onConflict: "session_id,key" }
      );

    if (error) {
      console.error(`Supabase write error for ${key}:`, error.message);
    }
  }

  async function writeManyData(entries) {
    if (!entries.length) {
      return;
    }

    const now = new Date().toISOString();
    const rows = entries.map(([key, value]) => ({
      session_id: sessionId,
      key,
      value: encode(value),
      updated_at: now
    }));

    const { error } = await supabase
      .from(TABLE_NAME)
      .upsert(rows, { onConflict: "session_id,key" });

    if (error) {
      console.error("Supabase bulk write error:", error.message);
    }
  }

  async function removeData(key) {
    const { error } = await supabase
      .from(TABLE_NAME)
      .delete()
      .eq("session_id", sessionId)
      .eq("key", key);

    if (error) {
      console.error(`Supabase remove error for ${key}:`, error.message);
    }
  }

  async function removeManyData(keys) {
    if (!keys.length) {
      return;
    }

    const { error } = await supabase
      .from(TABLE_NAME)
      .delete()
      .eq("session_id", sessionId)
      .in("key", keys);

    if (error) {
      console.error("Supabase bulk remove error:", error.message);
    }
  }

  const storedCreds = await readData("creds");
  const creds = storedCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          const keys = ids.map((id) => `${type}-${id}`);
          const stored = await readManyData(keys);

          for (const id of ids) {
            let value = stored.get(`${type}-${id}`);

            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }

            data[id] = value;
          }

          return data;
        },
        set: async (data) => {
          const writes = [];
          const removals = [];

          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              const key = `${type}-${id}`;

              if (value) {
                writes.push([key, value]);
              } else {
                removals.push(key);
              }
            }
          }

          await Promise.all([
            writeManyData(writes),
            removeManyData(removals)
          ]);
        }
      }
    },
    saveCreds: async () => {
      await writeData("creds", creds);
    }
  };
}
