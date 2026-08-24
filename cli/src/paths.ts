import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CONFIG_DIR = process.env.NO_SWIPE_AUTH_DIR
  ? path.resolve(process.env.NO_SWIPE_AUTH_DIR)
  : path.join(homedir(), ".config", "no-swipe");

export const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
export const BIN_DIR = path.join(CONFIG_DIR, "bin");

function looksLikePluginRoot(dir: string): boolean {
  return existsSync(path.join(dir, "config", "supabase.json"))
    && (existsSync(path.join(dir, ".codex-plugin", "plugin.json")) || existsSync(path.join(dir, "config", "cli-version.json")));
}

export function pluginRoot(): string {
  if (process.env.NO_SWIPE_PLUGIN_ROOT) return path.resolve(process.env.NO_SWIPE_PLUGIN_ROOT);
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (looksLikePluginRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromSource = path.resolve(import.meta.dir, "../../plugins/no-swipe");
  if (looksLikePluginRoot(fromSource)) return fromSource;
  return fromSource;
}

export function supabaseConfigPath(): string {
  if (process.env.NO_SWIPE_SUPABASE_CONFIG) return path.resolve(process.env.NO_SWIPE_SUPABASE_CONFIG);
  const cached = path.join(CONFIG_DIR, "supabase.json");
  if (existsSync(cached)) return cached;
  return path.join(pluginRoot(), "config", "supabase.json");
}
