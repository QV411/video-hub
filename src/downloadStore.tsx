import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  downloadGetSettings,
  downloadList,
  type DownloadJob,
  type DownloadJobEvent,
  type DownloadSettings,
} from "./download";

/**
 * Shared download state. The provider subscribes once at the app root, fetches
 * the persisted list as the initial source, and merges `download:job` events
 * incrementally. Both the download center page and the detail/player panel read
 * the same store, so there is a single source of truth for task status.
 *
 * The directory/settings snapshot is refreshed on startup, on `download:dir`
 * pushes, and whenever the WebView regains focus or becomes visible (Android
 * resume returns from the system settings page), so the grant state and the
 * active directory stay true without a manual reload.
 */
interface DownloadState {
  jobs: DownloadJob[];
  dir: string;
  settings: DownloadSettings | null;
  ready: boolean;
  /** Whether the latest list fetch failed; the page shows an error banner with a retry entry. */
  listError: boolean;
  refresh: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  jobFor: (pluginId: string, mediaId: string, ep?: number) => DownloadJob | undefined;
  activeCount: number;
}

const Ctx = createContext<DownloadState>(null!);
export const useDownloads = () => useContext(Ctx);

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [dir, setDir] = useState("");
  const [settings, setSettings] = useState<DownloadSettings | null>(null);
  const [ready, setReady] = useState(false);
  const [listError, setListError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await downloadList();
      setJobs(list.items);
      setDir(list.dir);
      setListError(false);
      setReady(true);
    } catch {
      setListError(true);
      setReady(true);
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const s = await downloadGetSettings();
      setSettings(s);
      setDir(s.effectiveDir || s.dir);
    } catch {
      /* keep previous snapshot */
    }
  }, []);

  useEffect(() => {
    let live = true;
    let unlistenJob: UnlistenFn | undefined;
    let unlistenDir: UnlistenFn | undefined;

    void refresh();
    void refreshSettings();

    void listen<DownloadJobEvent>("download:job", (event) => {
      if (!live) return;
      const { action, job } = event.payload;
      setJobs((prev) => {
        if (action === "remove") return prev.filter((j) => j.id !== job.id);
        const exists = prev.some((j) => j.id === job.id);
        return exists ? prev.map((j) => (j.id === job.id ? job : j)) : [job, ...prev];
      });
    })
      .then((fn) => {
        if (!live) void fn();
        else unlistenJob = fn;
      })
      .catch(() => {});

    void listen<{ dir: string; effectiveDir?: string; mode?: string; reason?: string }>("download:dir", (event) => {
      if (!live) return;
      const { dir: d, effectiveDir, mode, reason } = event.payload;
      const effective = effectiveDir || d;
      setDir(effective);
      if (mode || reason) {
        setSettings((prev) =>
          prev ? { ...prev, dir: effective, effectiveDir: effective, mode: (mode as DownloadSettings["mode"]) ?? prev.mode, reason: reason ?? prev.reason } : prev,
        );
      }
    })
      .then((fn) => {
        if (!live) void fn();
        else unlistenDir = fn;
      })
      .catch(() => {});

    const recheck = () => { if (live) void refreshSettings(); };
    const onVisibility = () => { if (!document.hidden) recheck(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      live = false;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisibility);
      void unlistenJob?.();
      void unlistenDir?.();
    };
  }, [refresh, refreshSettings]);

  const jobFor = useCallback(
    (pluginId: string, mediaId: string, ep?: number) =>
      jobs.find(
        (j) =>
          j.pluginId === pluginId &&
          j.mediaId === mediaId &&
          (ep === undefined || j.mode === "series" || j.ep === ep),
      ),
    [jobs],
  );

  const activeCount = useMemo(
    () => jobs.filter((j) => j.status === "running" || j.status === "queued").length,
    [jobs],
  );

  return (
    <Ctx.Provider value={{ jobs, dir, settings, ready, listError, refresh, refreshSettings, jobFor, activeCount }}>
      {children}
    </Ctx.Provider>
  );
}
