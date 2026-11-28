import { invoke } from "@tauri-apps/api/core";
import type { ImageRef } from "./plugins/protocol";

export interface DownloadEpisode {
  id: string;
  number: number;
  label: string;
}

export interface DownloadJob {
  id: string;
  pluginId: string;
  mediaId: string;
  episodeId: string;
  playlistId?: string;
  title: string;
  cover: ImageRef | null;
  ep: number;
  totalEps: number;
  mode: "episode" | "series";
  status: "queued" | "running" | "done" | "error" | "interrupted";
  progress: number;
  message: string;
  playlistPath: string;
  videoPath: string;
  fileSize: number;
  readyEps: number[];
  episodes: DownloadEpisode[];
  updatedAt: number;
}

/** Payload of the `download:job` event pushed by the Rust side. */
export interface DownloadJobEvent {
  action: "upsert" | "remove";
  job: DownloadJob;
}

/** Payload of the `download:dir` event pushed when the root directory changes. */
export interface DownloadDirEvent {
  dir: string;
  effectiveDir?: string;
  mode?: "public" | "fallback" | "custom";
  reason?: string;
}

export type DownloadDirMode = "public" | "fallback" | "custom";

export interface DownloadSettings {
  dir: string;
  /** Active resolved directory (same as `dir`); the only path the UI should render. */
  effectiveDir: string;
  /** Platform default directory: Android public shared root, otherwise app-data/downloads. */
  defaultDir: string;
  externalDir?: string | null;
  retries: number;
  mobile: boolean;
  /** Android: whether all-files access is granted. Desktop always true. */
  storageGranted: boolean;
  /** Android: the active directory is the app-private fallback. */
  fallback: boolean;
  /** Active root mode: public default, private fallback, or user-picked custom. */
  mode: DownloadDirMode;
  /** Human-readable cause for the active directory. */
  reason: string;
  /** Android OEM (`Build.MANUFACTURER`) for vendor-tailored guidance; null elsewhere. */
  manufacturer?: string | null;
  /** Keep the merged TS beside the MP4 after a successful remux. */
  keepTs: boolean;
}

export interface StartDownloadArgs {
  pluginId: string;
  mediaId: string;
  episodeId?: string;
  playlistId?: string;
  ep?: number;
  mode: "episode" | "series";
}

export async function downloadStart(args: StartDownloadArgs): Promise<DownloadJob> {
  return invoke<DownloadJob>("download_start", { ...args });
}

export async function downloadList(): Promise<{ items: DownloadJob[]; dir: string }> {
  return invoke<{ items: DownloadJob[]; dir: string }>("download_list");
}

export async function downloadDelete(pluginId: string, mediaId: string, ep?: number): Promise<void> {
  await invoke("download_delete", { pluginId, mediaId, ep: ep ?? null });
}

export async function downloadDir(): Promise<{ dir: string }> {
  return invoke<{ dir: string }>("download_dir");
}

export async function downloadPickDir(): Promise<string | null> {
  return invoke<string | null>("download_pick_dir");
}

export async function downloadResetDir(): Promise<{ dir: string }> {
  return invoke<{ dir: string }>("download_reset_dir");
}

export async function downloadOpenDir(): Promise<void> {
  await invoke("download_open_dir");
}

export async function downloadOpenFile(pluginId: string, mediaId: string, ep?: number): Promise<void> {
  await invoke("download_open_file", { pluginId, mediaId, ep: ep ?? null });
}

export async function downloadGetSettings(): Promise<DownloadSettings> {
  return invoke<DownloadSettings>("download_get_settings");
}

/** Android: jump to the system all-files access settings page. No-op elsewhere. */
export async function downloadOpenStorageSettings(): Promise<void> {
  await invoke("download_open_storage_settings");
}

export async function downloadSetRetries(retries: number): Promise<{ retries: number }> {
  return invoke<{ retries: number }>("download_set_retries", { retries });
}

export async function downloadSetKeepTs(keep: boolean): Promise<{ keepTs: boolean }> {
  return invoke<{ keepTs: boolean }>("download_set_keep_ts", { keep });
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
