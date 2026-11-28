import { useCallback, useEffect, useRef, useState } from "react";
import { IGrid, IChevR, IBack, IFireF, ISparkF, ITrophy, IRefresh } from "../../icons";
import { pluginError, type InstalledPlugin } from "../client";
import { Notice, type OpenMedia } from "../BrowsePages";
import type { ImageRef } from "../protocol";
import MediaCards, { MediaRow, useAssetUrls } from "../MediaCards";
import { usePluginRequests } from "../usePluginRequests";
import { useHghubxList } from "./useHghubxList";
import HghubxPost from "./HghubxPost";
import {
  HG_CHANNELS, CHANNEL_SORTS, ORIGINAL_CATES, originalSort,
  mapPagedPosts, mapRawPost, type RawPost, type RawPaged, type RawTopicCard, type RawTopicDetail,
  type RawRankItem, RANK_TABS, type RankKind,
} from "./shared";

type View =
  | { kind: "overview" }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "posts" }
  | { kind: "post"; post: RawPost }
  | { kind: "topics" }
  | { kind: "topic"; slug: string; title: string }
  | { kind: "tags" }
  | { kind: "tag"; tag: string; name: string }
  | { kind: "ranks" };

interface RawGroup { name: string; tags: { name: string; slug?: string; hot_score?: number }[] }

/** Preview card plus the raw post fields needed to open a post detail. */
interface PreviewItem {
  id: string; title: string; cover?: ImageRef; tags?: string[]; stats?: { hot?: number };
  desc?: string; content?: string; video_id?: number | string; created_at?: string;
}

/** Independent preview loader for one overview channel; mirrors upstream
 *  PreviewStatus: per-section loading / error / retry, no cross-section block. */
function usePreview(plugin: InstalledPlugin, method: string, args: Record<string, unknown>, enabled = true) {
  const request = usePluginRequests();
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const argsKey = JSON.stringify(args);

  const load = useCallback(async () => {
    if (!plugin || !enabled) return;
    setBusy(true);
    setError("");
    const n = ++epoch.current;
    try {
      const raw = await request<{ items: { id: number | string; title: string; cover?: string; tags?: string[]; hot?: number; desc?: string; content?: string; video_id?: number | string; created_at?: string }[] }>("call", {
        id: plugin.meta.id,
        method,
        args: { ...JSON.parse(argsKey) as Record<string, unknown>, page: 1, size: 8 },
      });
      if (n !== epoch.current) return;
      setItems((raw.items || []).map(v => ({
        id: String(v.id),
        title: v.title || "未命名",
        cover: v.cover || undefined,
        tags: Array.isArray(v.tags) ? v.tags : [],
        stats: Number.isFinite(Number(v.hot)) ? { hot: Number(v.hot) } : undefined,
        desc: v.desc || undefined,
        content: v.content || undefined,
        video_id: v.video_id,
        created_at: v.created_at || undefined,
      })));
    } catch (e) {
      if (n === epoch.current) setError(pluginError(e));
    } finally {
      if (n === epoch.current) setBusy(false);
    }
  }, [plugin, method, argsKey, enabled, request]);

  useEffect(() => { epoch.current++; void load(); return () => { epoch.current++; request.cancelAll(); }; }, [load, request]);
  return { items, busy, error, reload: load };
}

/* ── overview channel preview section ──────────────────────────────── */

function ChannelPreview({ plugin, cate, name, open, onEnter }: {
  plugin: InstalledPlugin; cate: string; name: string; open: OpenMedia; onEnter: () => void;
}) {
  const isOriginal = cate === "original";
  const method = isOriginal ? "xcategory.original" : "xcategory.list";
  const args = isOriginal ? { cate: "all", sort: originalSort("all") } : { cate, sort: "latest" };
  const preview = usePreview(plugin, method, args);

  return <section aria-label={name} className="hpp-category-preview mb-5">
    <button className="w-full flex items-center gap-3 mb-3 text-left pressable" onClick={onEnter}>
      <span className="w-9 h-9 rounded-[12px] bg-s3 text-on flex items-center justify-center shrink-0"><ISparkF size={18} /></span>
      <span className="flex-1 min-w-0">
        <span role="heading" className="block text-[16px] font-bold text-on leading-tight">{name}</span>
      </span>
      <span className="inline-flex items-center gap-0.5 text-[13px] font-medium text-mut shrink-0">全部<IChevR size={14} /></span>
    </button>
    {preview.busy && !preview.items.length && <div className="hpp-skeleton" />}
    {!!preview.items.length && <MediaRow pluginId={plugin.meta.id} items={preview.items} open={i => open(plugin.meta.id, i.id)} />}
    {!preview.items.length && (
      <div role="status" className="hpp-muted py-3 text-[12px]">
        {preview.busy ? "加载中…" : preview.error || "暂无内容"}
        {!preview.busy && preview.error && <button className="ml-2 text-primary pressable" onClick={preview.reload}>重试</button>}
      </div>
    )}
  </section>;
}

function PostsPreview({ plugin, onEnter, onOpenPost }: { plugin: InstalledPlugin; onEnter: () => void; onOpenPost: (p: RawPost) => void }) {
  const preview = usePreview(plugin, "xdiscover.postCategory", { route: "remen-chigua" });
  const raws: RawPost[] = preview.items.map(p => ({
    id: p.id, title: p.title, cover: p.cover, tags: p.tags, hot: p.stats?.hot,
    desc: p.desc, content: p.content, video_id: p.video_id, created_at: p.created_at,
  }));
  const items = raws.map(mapRawPost).filter((x): x is NonNullable<typeof x> => !!x);
  return <section aria-label="吃瓜" className="hpp-category-preview mb-5">
    <button className="w-full flex items-center gap-3 mb-3 text-left pressable" onClick={onEnter}>
      <span className="w-9 h-9 rounded-[12px] bg-s3 text-on flex items-center justify-center shrink-0"><IFireF size={18} /></span>
      <span className="flex-1 min-w-0"><span role="heading" className="block text-[16px] font-bold text-on leading-tight">吃瓜</span></span>
      <span className="inline-flex items-center gap-0.5 text-[13px] font-medium text-mut shrink-0">全部<IChevR size={14} /></span>
    </button>
    {preview.busy && !preview.items.length && <div className="hpp-skeleton" />}
    {!!items.length && <MediaRow pluginId={plugin.meta.id} items={items} open={i => {
      const raw = raws.find(r => `post-${r.id}` === i.id);
      if (raw) onOpenPost(raw);
    }} />}
    {!preview.items.length && (
      <div role="status" className="hpp-muted py-3 text-[12px]">
        {preview.busy ? "加载中…" : preview.error || "暂无内容"}
        {!preview.busy && preview.error && <button className="ml-2 text-primary pressable" onClick={preview.reload}>重试</button>}
      </div>
    )}
  </section>;
}

/* ── channel detail ────────────────────────────────────────────────── */

function ChannelDetail({ plugin, view, onBack, open }: {
  plugin: InstalledPlugin; view: Extract<View, { kind: "channel" }>; onBack: () => void; open: OpenMedia;
}) {
  const isOriginal = view.cate === "original";
  const [sort, setSort] = useState<string>("latest");
  const [originalCate, setOriginalCate] = useState<string>("all");
  const method = isOriginal ? "xcategory.original" : "xcategory.list";
  const args = isOriginal ? { cate: originalCate, sort: originalSort(originalCate) } : { cate: view.cate, sort };
  const list = useHghubxList(plugin, method, args);

  const changeSort = (value: string) => setSort(value);
  const changeOriginal = (value: string) => setOriginalCate(value);

  return <div className="hpp-page refined-page absolute inset-0 flex flex-col">
    <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
      <div className="flex items-center gap-2">
        <button className="pressable" aria-label="返回分类" onClick={onBack}><IBack size={17} /></button>
        <h1 className="text-[20px] font-bold text-on leading-none flex-1">{view.name}</h1>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {isOriginal
          ? ORIGINAL_CATES.map(s => <button key={s.value} aria-pressed={originalCate === s.value} className="hx-pill pressable" onClick={() => changeOriginal(s.value)}>{s.label}</button>)
          : CHANNEL_SORTS.map(s => <button key={s.value} aria-pressed={sort === s.value} className="hx-pill pressable" onClick={() => changeSort(s.value)}>{s.label}</button>)}
      </div>
    </header>
    <div className="hpp-scroll flex-1"><div className="hpp-content">
      <Notice error={list.error} />
      {list.busy && !list.items.length && <div className="hpp-skeleton" aria-label="正在加载内容" />}
      {!!list.items.length && <MediaCards pluginId={plugin.meta.id} items={list.items} open={i => open(plugin.meta.id, i.id)} />}
      {list.next && <div className="flex justify-center py-5"><button className="primary" onClick={list.loadMore} disabled={list.busy}>加载更多</button></div>}
      {!list.busy && !list.items.length && !list.error && <div className="hpp-empty"><IGrid size={36} /><h2>该筛选下暂无内容</h2><p>换个筛选试试。</p></div>}
      {!list.busy && !list.items.length && list.error && <div className="flex justify-center py-8"><button className="primary" onClick={list.refresh}>重试</button></div>}
    </div></div>
  </div>;
}

/* ── posts list ─────────────────────────────────────────────────────── */

function PostsPage({ plugin, onBack, onOpenPost }: { plugin: InstalledPlugin; onBack: () => void; onOpenPost: (p: RawPost) => void }) {
  const raws = useRef(new Map<string, RawPost>());
  const mapper = useCallback((paged: RawPaged<RawPost>) => {
    for (const p of paged.items || []) if (p && p.id !== undefined && p.id !== null) raws.current.set(`post-${p.id}`, p);
    return mapPagedPosts(paged);
  }, []);
  const list = useHghubxList<RawPaged<RawPost>>(plugin, "xdiscover.posts", {}, true, mapper);
  return <div className="hpp-page refined-page absolute inset-0 flex flex-col">
    <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
      <div className="flex items-center gap-2">
        <button className="pressable" aria-label="返回分类" onClick={onBack}><IBack size={17} /></button>
        <h1 className="text-[20px] font-bold text-on leading-none">吃瓜</h1>
      </div>
    </header>
    <div className="hpp-scroll flex-1"><div className="hpp-content">
      <Notice error={list.error} />
      {list.busy && !list.items.length && <div className="hpp-skeleton" aria-label="正在加载内容" />}
      {!!list.items.length && <MediaCards pluginId={plugin.meta.id} items={list.items} open={i => {
        const raw = raws.current.get(i.id);
        if (raw) onOpenPost(raw);
      }} />}
      {list.next && <div className="flex justify-center py-5"><button className="primary" onClick={list.loadMore} disabled={list.busy}>加载更多</button></div>}
      {!list.busy && !list.items.length && !list.error && <div className="hpp-empty"><IFireF size={36} /><h2>暂无帖子</h2><p>片源当前没有可展示的内容。</p></div>}
    </div></div>
  </div>;
}

/* ── topics ────────────────────────────────────────────────────────── */

function TopicsPage({ plugin, onBack, onOpenTopic }: {
  plugin: InstalledPlugin; onBack: () => void; onOpenTopic: (t: RawTopicCard) => void;
}) {
  const request = usePluginRequests();
  const [topics, setTopics] = useState<RawTopicCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const raw = await request<{ items: RawTopicCard[] }>("call", { id: plugin.meta.id, method: "xdiscover.topics", args: {} });
      setTopics(raw.items || []);
    } catch (e) { setError(pluginError(e)); } finally { setBusy(false); }
  }, [plugin.meta.id, request]);
  useEffect(() => { void load(); return () => request.cancelAll(); }, [load, request]);

  const coverUrls = useAssetUrls(plugin.meta.id, topics.flatMap(t => t.cover ? [t.cover] : []));
  let coverIndex = 0;

  return <div className="hpp-page refined-page absolute inset-0 flex flex-col">
    <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
      <div className="flex items-center gap-2">
        <button className="pressable" aria-label="返回分类" onClick={onBack}><IBack size={17} /></button>
        <h1 className="text-[20px] font-bold text-on leading-none">专题</h1>
      </div>
    </header>
    <div className="hpp-scroll flex-1"><div className="hpp-content">
      <Notice error={error} />
      {busy && !topics.length && <div className="hpp-skeleton" />}
      {!!topics.length && <div className="grid grid-cols-2 gap-3">
        {topics.map(t => {
          const cover = t.cover ? coverUrls[coverIndex++] : undefined;
          return <button key={t.slug || t.id} className="topic-card pressable text-left" onClick={() => onOpenTopic(t)}>
            {cover ? <img src={cover} alt="" loading="lazy" className="topic-card-cover" /> : <div className="topic-card-cover hpp-muted grid place-items-center text-[12px]">{t.title.slice(0, 2)}</div>}
            <div className="topic-card-body">
              <strong className="clamp-1">{t.title}</strong>
              {t.intro && <p className="clamp-2">{t.intro}</p>}
              {Number.isFinite(Number(t.video_count)) && <span className="hpp-muted">{t.video_count} 部</span>}
            </div>
          </button>;
        })}
      </div>}
      {!busy && !topics.length && !error && <div className="hpp-empty"><IGrid size={36} /><h2>暂无专题</h2><p>片源当前没有可展示的专题。</p></div>}
    </div></div>
  </div>;
}

function TopicDetail({ plugin, view, onBack, open, onOpenTopic }: {
  plugin: InstalledPlugin; view: Extract<View, { kind: "topic" }>; onBack: () => void;
  open: OpenMedia; onOpenTopic: (t: RawTopicCard) => void;
}) {
  const request = usePluginRequests();
  const [detail, setDetail] = useState<RawTopicDetail | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const raw = await request<RawTopicDetail>("call", { id: plugin.meta.id, method: "xdiscover.topic", args: { slug: view.slug, page: 1, size: 20 } });
      setDetail(raw);
    } catch (e) { setError(pluginError(e)); } finally { setBusy(false); }
  }, [plugin.meta.id, request, view.slug]);
  useEffect(() => { void load(); return () => request.cancelAll(); }, [load, request]);

  const videos = (detail?.videos?.items || []).map(v => ({
    id: String(v.id), title: v.title || "未命名", cover: v.cover || undefined,
    tags: Array.isArray(v.tags) ? v.tags : [],
  }));

  return <div className="hpp-page refined-page absolute inset-0 flex flex-col">
    <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
      <div className="flex items-center gap-2">
        <button className="pressable" aria-label="返回专题" onClick={onBack}><IBack size={17} /></button>
        <h1 className="text-[20px] font-bold text-on leading-none flex-1 truncate">{view.title}</h1>
      </div>
    </header>
    <div className="hpp-scroll flex-1"><div className="hpp-content">
      <Notice error={error} />
      {busy && <div className="hpp-skeleton" />}
      {!busy && !error && detail && <>
        {detail.topic?.intro && <p className="hpp-muted mb-4">{detail.topic.intro}</p>}
        {!!videos.length && <MediaRow pluginId={plugin.meta.id} items={videos} open={i => open(plugin.meta.id, i.id)} />}
        {!videos.length && <p className="hpp-muted py-3">该专题下暂无内容。</p>}
        {!!(detail.related || []).length && <section className="mt-6">
          <h2 className="text-[15px] font-semibold text-on mb-3">相关专题</h2>
          <div className="flex gap-3 overflow-x-auto">
            {(detail.related || []).map(t => <button key={t.slug || t.id} className="topic-card-related pressable" onClick={() => onOpenTopic(t)}>
              <strong className="clamp-1">{t.title}</strong>
            </button>)}
          </div>
        </section>}
      </>}
      {!busy && error && <div className="flex justify-center py-8"><button className="primary" onClick={load}>重试</button></div>}
    </div></div>
  </div>;
}

/* ── tags ──────────────────────────────────────────────────────────── */

function TagsPage({ plugin, onBack, onOpenTag }: {
  plugin: InstalledPlugin; onBack: () => void; onOpenTag: (tag: { name: string; slug?: string }) => void;
}) {
  const request = usePluginRequests();
  const [groups, setGroups] = useState<RawGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const raw = await request<{ categories: RawGroup[] }>("call", { id: plugin.meta.id, method: "xdiscover.tags", args: {} });
      setGroups(raw.categories || []);
    } catch (e) { setError(pluginError(e)); } finally { setBusy(false); }
  }, [plugin.meta.id, request]);
  useEffect(() => { void load(); return () => request.cancelAll(); }, [load, request]);

  return <div className="hpp-page refined-page absolute inset-0 flex flex-col">
    <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
      <div className="flex items-center gap-2">
        <button className="pressable" aria-label="返回分类" onClick={onBack}><IBack size={17} /></button>
        <h1 className="text-[20px] font-bold text-on leading-none">标签</h1>
      </div>
    </header>
    <div className="hpp-scroll flex-1"><div className="hpp-content">
      <Notice error={error} />
      {busy && !groups.length && <div className="hpp-skeleton" />}
      {groups.map(group => <section key={group.name} className="hpp-category-preview mb-5">
        <h2 className="flex items-center gap-2.5 text-[15.5px] font-semibold text-on mb-2.5"><IGrid size={18} />{group.name}</h2>
        <div className="flex flex-wrap gap-2">
          {(group.tags || []).map(tag => <button key={tag.slug || tag.name} className="px-3 h-8 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable"
            onClick={() => onOpenTag(tag)}>{tag.name}<IChevR size={12} className="ml-1 inline-block" /></button>)}
        </div>
      </section>)}
      {!busy && !groups.length && !error && <div className="hpp-empty"><IGrid size={36} /><h2>暂无标签</h2><p>片源当前没有可展示的标签。</p></div>}
    </div></div>
  </div>;
}

function TagPage({ plugin, view, onBack, open }: {
  plugin: InstalledPlugin; view: Extract<View, { kind: "tag" }>; onBack: () => void; open: OpenMedia;
}) {
  const [sort, setSort] = useState<"latest" | "hot">("latest");
  const list = useHghubxList(plugin, "xdiscover.tagVideos", { tag: view.tag, sort });
  return <div className="hpp-page refined-page absolute inset-0 flex flex-col">
    <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
      <div className="flex items-center gap-2">
        <button className="pressable" aria-label="返回标签" onClick={onBack}><IBack size={17} /></button>
        <h1 className="text-[20px] font-bold text-on leading-none flex-1 truncate">{view.name}</h1>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {(["latest", "hot"] as const).map(s => <button key={s} aria-pressed={sort === s} className="hx-pill pressable"
          onClick={() => setSort(s)}>{s === "latest" ? "最新" : "最热"}</button>)}
      </div>
    </header>
    <div className="hpp-scroll flex-1"><div className="hpp-content">
      <Notice error={list.error} />
      {list.busy && !list.items.length && <div className="hpp-skeleton" aria-label="正在加载内容" />}
      {!!list.items.length && <MediaCards pluginId={plugin.meta.id} items={list.items} open={i => open(plugin.meta.id, i.id)} />}
      {list.next && <div className="flex justify-center py-5"><button className="primary" onClick={list.loadMore} disabled={list.busy}>加载更多</button></div>}
      {!list.busy && !list.items.length && !list.error && <div className="hpp-empty"><IGrid size={36} /><h2>该标签下暂无内容</h2><p>换个标签试试。</p></div>}
    </div></div>
  </div>;
}

/* ── ranks ─────────────────────────────────────────────────────────── */

interface RankState { items: RawRankItem[]; loadedAt: number; loading: boolean; error: string }

function RankRow({ item, cover, metricMax, onOpen }: {
  item: RawRankItem; cover?: string; metricMax: number; onOpen: () => void;
}) {
  const value = Number(item.metric_value) || 0;
  const top = Number(item.rank) < 4;
  const meter = Math.max(6, (value / metricMax) * 100);
  const tags = [item.cate_name, ...(item.tags || [])].slice(0, 2).filter(Boolean).join(" · ");
  return (
    <button className="hx-rank-row pressable" onClick={onOpen}>
      <span className={top ? "hx-rank-number is-top" : "hx-rank-number"}>{String(item.rank).padStart(2, "0")}</span>
      <span className="hx-rank-cover">{cover ? <img src={cover} alt="" loading="lazy" /> : <span>{item.title.slice(0, 2)}</span>}</span>
      <span className="hx-rank-copy">
        <strong className="clamp-1">{item.title}</strong>
        <span className="clamp-1">{tags}</span>
        <span className="hx-rank-meter" aria-hidden="true"><span style={{ width: `${meter}%` }}></span></span>
      </span>
      <span className="hx-rank-metric">
        {item.metric_label ? <em>{item.metric_label}</em> : null}
        <b>{value || ""}</b>
      </span>
    </button>
  );
}

function RankPage({ plugin, onBack, open }: {
  plugin: InstalledPlugin; onBack: () => void; open: OpenMedia;
}) {
  const request = usePluginRequests();
  const [tab, setTab] = useState<RankKind>("hot");
  const [states, setStates] = useState<Partial<Record<RankKind, RankState>>>({});
  const cache = useRef<Partial<Record<RankKind, RankState>>>({});
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (kind: RankKind) => {
    if (!plugin) return;
    if (pending.current.has(kind)) return;
    pending.current.add(kind);
    const previous = cache.current[kind];
    const update = (state: RankState) => {
      cache.current[kind] = state;
      if (alive.current) setStates(cur => ({ ...cur, [kind]: state }));
    };
    update({ items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0, loading: true, error: "" });
    try {
      const res = await request<{ items?: RawRankItem[] }>("call", {
        id: plugin.meta.id, method: "xhome.rank", args: { kind },
      });
      update({ items: res?.items || [], loadedAt: Date.now(), loading: false, error: "" });
    } catch (e) {
      update({
        items: previous?.items ?? [], loadedAt: previous?.loadedAt ?? 0,
        loading: false, error: pluginError(e),
      });
    } finally { pending.current.delete(kind); }
  }, [plugin, request]);

  useEffect(() => {
    const current = cache.current[tab];
    if (!current?.loadedAt || Date.now() - current.loadedAt > 60_000) void load(tab);
  }, [tab, load]);

  const state = states[tab];
  const items = state?.items ?? [];
  const loading = state?.loading ?? true;
  const err = state?.error ?? "";
  const max = Math.max(1, ...items.map(x => Number(x.metric_value) || 0));
  const coverUrls = useAssetUrls(plugin.meta.id, items.flatMap(i => i.cover ? [i.cover] : []));
  let coverIndex = 0;
  const meta = RANK_TABS.find(t => t.value === tab)!;

  return (
    <div className="hpp-page refined-page absolute inset-0 flex flex-col">
      <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="flex items-center gap-2">
          <button className="pressable" aria-label="返回分类" onClick={onBack}><IBack size={17} /></button>
          <span className="w-9 h-9 rounded-[12px] bg-s3 text-on flex items-center justify-center shrink-0"><ITrophy size={18} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[20px] font-bold text-on leading-none">排行榜</h1>
            <div className="text-[12px] text-mut mt-0.5">{meta.label}{items.length ? ` · TOP ${items.length}` : ""}</div>
          </div>
          <button className="pressable" aria-label="刷新榜单" disabled={loading} onClick={() => void load(tab)}>
            <IRefresh size={18} />
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          {RANK_TABS.map(t => (
            <button key={t.value} aria-pressed={tab === t.value} className="hx-pill pressable"
              onClick={() => setTab(t.value)}>{t.label}</button>
          ))}
        </div>
      </header>
      <div className="hpp-scroll flex-1"><div className="hpp-content">
        {err && <div role="alert" className="flex flex-wrap items-center gap-2 mb-3 text-[13px]" style={{ color: "var(--p-danger)" }}>
          <span>榜单加载失败：{err}{items.length ? "；已保留上次榜单" : ""}</span>
          <button className="px-3 text-primary pressable" onClick={() => void load(tab)} disabled={loading}>重试</button>
        </div>}
        {items.length > 0 ? (
          <>
            {loading && <p role="status" className="text-[12px] text-mut mb-2">正在刷新，当前显示上次榜单…</p>}
            <div className="grid gap-2.5">
              {items.map(it => {
                const cover = it.cover ? coverUrls[coverIndex++] : undefined;
                return (
                  <RankRow key={`${it.video_id}-${it.rank}`} item={it} cover={cover} metricMax={max}
                    onOpen={() => open(plugin.meta.id, String(it.video_id))} />
                );
              })}
            </div>
          </>
        ) : loading ? (
          <div className="flex justify-center py-12"><div className="hpp-skeleton" /></div>
        ) : !err && (
          <div className="hpp-empty"><ITrophy size={36} /><h2>榜单暂时为空</h2><p>换个榜单类型试试。</p></div>
        )}
      </div></div>
    </div>
  );
}

/* ── root with internal navigation stack ────────────────────────────── */

export default function HghubxCategory({ plugin, open }: { plugin: InstalledPlugin; open: OpenMedia }) {
  const [nav, setNav] = useState<View[]>([{ kind: "overview" }]);
  const push = useCallback((v: View) => setNav(n => [...n, v]), []);
  const back = useCallback(() => setNav(n => (n.length > 1 ? n.slice(0, -1) : n)), []);
  const view = nav[nav.length - 1];

  const openTopic = useCallback((t: RawTopicCard) => push({ kind: "topic", slug: t.slug, title: t.title }), [push]);
  const openTag = useCallback((tag: { name: string; slug?: string }) => push({ kind: "tag", tag: tag.slug || tag.name, name: tag.name }), [push]);
  const openPost = useCallback((post: RawPost) => push({ kind: "post", post }), [push]);

  return <div className="hpp-page hpp-category-page refined-page">
    {view.kind === "overview" && <div className="hpp-scroll"><div className="hpp-content">
      <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <h1 className="text-[24px] font-bold text-on leading-none">分类</h1>
      </header>
      <div className="grid grid-cols-2 gap-3 mb-6">
        <button className="hx-entry pressable col-span-2 w-full" onClick={() => push({ kind: "ranks" })}><ITrophy size={18} /><span>排行榜</span></button>
        <button className="hx-entry pressable" onClick={() => push({ kind: "topics" })}><ISparkF size={18} /><span>专题</span></button>
        <button className="hx-entry pressable" onClick={() => push({ kind: "tags" })}><IGrid size={18} /><span>标签</span></button>
      </div>
      {HG_CHANNELS.map(c => <ChannelPreview key={c.cate} plugin={plugin} cate={c.cate} name={c.name} open={open}
        onEnter={() => push({ kind: "channel", cate: c.cate, name: c.name })} />)}
      <PostsPreview plugin={plugin} onEnter={() => push({ kind: "posts" })} onOpenPost={openPost} />
      <div className="text-center text-[12px] text-dim pt-1">— 已展示全部频道 —</div>
    </div></div>}

    {view.kind === "channel" && <ChannelDetail plugin={plugin} view={view} onBack={back} open={open} />}
    {view.kind === "posts" && <PostsPage plugin={plugin} onBack={back} onOpenPost={openPost} />}
    {view.kind === "post" && <HghubxPost plugin={plugin} post={view.post} onBack={back} open={open} onOpenTag={openTag} />}
    {view.kind === "topics" && <TopicsPage plugin={plugin} onBack={back} onOpenTopic={openTopic} />}
    {view.kind === "topic" && <TopicDetail plugin={plugin} view={view} onBack={back} open={open} onOpenTopic={openTopic} />}
    {view.kind === "tags" && <TagsPage plugin={plugin} onBack={back} onOpenTag={openTag} />}
    {view.kind === "tag" && <TagPage plugin={plugin} view={view} onBack={back} open={open} />}
    {view.kind === "ranks" && <RankPage plugin={plugin} onBack={back} open={open} />}
  </div>;
}
