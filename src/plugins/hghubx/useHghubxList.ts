import { useCallback, useEffect, useRef, useState } from "react";
import { pluginError, type InstalledPlugin } from "../client";
import { usePluginRequests } from "../usePluginRequests";
import type { MediaItem } from "../protocol";
import { mapPagedCards, type RawPaged, type RawVideoCard } from "./shared";

type Mapper<T = unknown> = (raw: T) => { items: MediaItem[]; next: number | null };

/**
 * Shared paged loader for HGhubX extension methods. The upstream feed/search
 * endpoints return `{ items, pagination: { page, size, pages, total } }`; the
 * host maps those onto the protocol MediaItem cards. An optional mapper handles
 * alternate shapes (e.g. posts).
 */
export function useHghubxList<T = RawPaged<RawVideoCard>>(
  plugin: InstalledPlugin | undefined,
  method: string,
  baseArgs: Record<string, unknown> = {},
  enabled = true,
  mapper: Mapper<T> = mapPagedCards as Mapper<T>,
) {
  const request = usePluginRequests();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [next, setNext] = useState<number | null>(1);
  const epoch = useRef(0);
  const argsKey = JSON.stringify(baseArgs);
  const mapperRef = useRef(mapper);
  mapperRef.current = mapper;

  const load = useCallback(async (targetPage: number, append: boolean) => {
    if (!plugin || !enabled) return;
    setBusy(true);
    setError("");
    const n = ++epoch.current;
    try {
      const raw = await request<T>("call", {
        id: plugin.meta.id,
        method,
        args: { ...JSON.parse(argsKey) as Record<string, unknown>, page: targetPage, size: 20 },
      });
      if (n !== epoch.current) return;
      const mapped = mapperRef.current(raw);
      setItems(old => append
        ? [...old, ...mapped.items.filter(i => !old.some(o => o.id === i.id))]
        : mapped.items);
      setNext(mapped.next);
    } catch (e) {
      if (n === epoch.current) setError(pluginError(e));
    } finally {
      if (n === epoch.current) setBusy(false);
    }
  }, [plugin, method, argsKey, enabled, request]);

  useEffect(() => {
    epoch.current++;
    setItems([]);
    setNext(1);
    void load(1, false);
    return () => { epoch.current++; request.cancelAll(); };
  }, [load, request]);

  const loadMore = useCallback(() => { if (next && !busy) void load(next, true); }, [next, busy, load]);
  const refresh = useCallback(() => void load(1, false), [load]);
  return { items, busy, error, next, refresh, loadMore };
}
