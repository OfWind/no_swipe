import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { supabaseConfigPath } from "./paths.ts";

export type CloudConfig = {
  url: string;
  publishable_key: string;
  edge_function: string;
  contract_version: number;
  plugin_version: string;
  workbench_url: string;
  releases_base_url: string;
};

const BAKED: CloudConfig = {
  url: "https://kigrzhmcphrkqtuqthwb.supabase.co",
  publishable_key: "sb_publishable_Jm6gViTHXW0c4hEmX26lqw_xfcLXP78",
  edge_function: "ingest",
  contract_version: 2,
  plugin_version: "0.3.3",
  workbench_url: "https://whislte.cc.cd",
  releases_base_url: "https://kigrzhmcphrkqtuqthwb.supabase.co/storage/v1/object/public/no-swipe-releases",
};

export function hostFingerprint(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}

export function loadCloudConfig(): CloudConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(supabaseConfigPath(), "utf8"));
  } catch {
    raw = {};
  }
  const url = String(process.env.NO_SWIPE_SUPABASE_URL || raw.url || BAKED.url).replace(/\/$/, "");
  const publishable_key = String(process.env.NO_SWIPE_SUPABASE_PUBLISHABLE_KEY || raw.publishable_key || BAKED.publishable_key);
  if (!url || !publishable_key) throw new Error("incomplete Supabase upload configuration");
  return {
    url,
    publishable_key,
    edge_function: String(raw.edge_function || BAKED.edge_function),
    contract_version: Number(raw.contract_version || BAKED.contract_version),
    plugin_version: String(raw.plugin_version || BAKED.plugin_version),
    workbench_url: String(raw.workbench_url || process.env.NO_SWIPE_WORKBENCH_URL || BAKED.workbench_url).replace(/\/$/, ""),
    releases_base_url: String(raw.releases_base_url || BAKED.releases_base_url),
  };
}

export function functionUrl(config: CloudConfig, name: string): string {
  return `${config.url}/functions/v1/${name}`;
}
