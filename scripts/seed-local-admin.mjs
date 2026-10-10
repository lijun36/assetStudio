#!/usr/bin/env node
/** Create the documented local login through Supabase Auth, including its DB bootstrap trigger. */
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { parseEnvValue } from "./parse-env-value.mjs";

const EMAIL = "admin@loomic.test";
const PASSWORD = "admin123";

async function main() {
  const content = await readFile(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of content.split("\n")) {
    const match = /^([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = parseEnvValue(match[2]);
  }

  const url = new URL(process.env.SUPABASE_URL);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("seed:local-admin only accepts a local Supabase URL.");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

  const auth = createClient(url.toString(), process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: listed, error: listError } = await auth.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw listError;
  const existing = listed.users.find((user) => user.email === EMAIL);
  const result = existing
    ? await auth.auth.admin.updateUserById(existing.id, { password: PASSWORD, email_confirm: true })
    : await auth.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "Admin" },
    });
  if (result.error || !result.data.user) throw result.error ?? new Error("Failed to create local admin.");

  const { data: workspace, error: workspaceError } = await auth.from("workspaces")
    .select("id")
    .eq("owner_user_id", result.data.user.id)
    .eq("type", "personal")
    .single();
  if (workspaceError || !workspace) throw workspaceError ?? new Error("Local admin workspace was not created.");
  console.log(`${existing ? "Updated" : "Created"} local login: ${EMAIL}`);
}

main().catch((error) => {
  console.error(`Local admin seed failed: ${error.message}`);
  process.exitCode = 1;
});
