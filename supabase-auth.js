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

  const storedCreds = await readData("creds");
  const creds = storedCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};

          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);

              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              data[id] = value;
            })
          );

          return data;
        },
        set: async (data) => {
          const tasks = [];

          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              const key = `${type}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }

          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData("creds", creds);
    }
  };
}
