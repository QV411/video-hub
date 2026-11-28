import type { InstalledPlugin } from "../client";
import type { ImageRef, MediaItem } from "../protocol";

export const PLAY_SOURCE_ID = "play-source";

export interface RawAuthor { id?: number | string; name?: string }
export interface RawVideoCard {
  id: number | string;
  title: string;
  cover?: ImageRef;
  description?: string;
  tags?: string[];
  hot?: number;
  like_count?: number;
  collect_count?: number;
  comment_count?: number;
  score?: number;
  episode_count?: number;
  total_episodes?: number;
  is_finished?: boolean;
  is_original?: boolean;
  author?: RawAuthor;
  created_at?: string;
}
export interface RawPaged<T> {
  items?: T[];
  pagination?: { page?: number; size?: number; pages?: number; total?: number };
}

export function findPlaySource(sources: InstalledPlugin[]): InstalledPlugin | undefined {
  return sources.find(p => p.meta.id === PLAY_SOURCE_ID);
}

/** Independent home browse dimension: default native immersive feed,
 *  HGhubX card renderer, or the dedicated HGsky renderer. */
export type HomeScheme = "default" | "hghubx" | "hgsky";
/** Independent category browse dimension: default native catalog or HGhubX. */
export type CategoryScheme = "default" | "hghubx";

const HOME_SCHEMES: readonly HomeScheme[] = ["default", "hghubx", "hgsky"];
const CATEGORY_SCHEMES: readonly CategoryScheme[] = ["default", "hghubx"];

function valid<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/** Home scheme persisted on the play-source plugin (`homeMode`). */
export function homeScheme(plugin: InstalledPlugin | undefined): HomeScheme {
  if (!plugin || !plugin.enabled) return "default";
  return valid(plugin.settings?.homeMode, HOME_SCHEMES, "default");
}

/** Category scheme persisted on the play-source plugin (`categoryMode`). */
export function categoryScheme(plugin: InstalledPlugin | undefined): CategoryScheme {
  if (!plugin || !plugin.enabled) return "default";
  return valid(plugin.settings?.categoryMode, CATEGORY_SCHEMES, "default");
}

export function mapRawCard(raw: RawVideoCard): MediaItem | null {
  if (!raw || raw.id === undefined || raw.id === null) return null;
  const stats: MediaItem["stats"] = {};
  if (Number.isFinite(Number(raw.hot))) stats.hot = Number(raw.hot);
  if (Number.isFinite(Number(raw.like_count))) stats.likes = Number(raw.like_count);
  if (Number.isFinite(Number(raw.collect_count))) stats.favorites = Number(raw.collect_count);
  if (Number.isFinite(Number(raw.comment_count))) stats.comments = Number(raw.comment_count);
  return {
    id: String(raw.id),
    title: raw.title || "未命名",
    type: raw.is_original ? "series" : "short",
    cover: raw.cover || undefined,
    description: raw.description || undefined,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    score: typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : undefined,
    episodeCount: raw.episode_count || undefined,
    totalEpisodes: raw.total_episodes || undefined,
    status: raw.is_finished ? "finished" : "ongoing",
    stats,
    author: raw.author ? { id: String(raw.author.id || 0), name: raw.author.name || "作者" } : undefined,
    publishedAt: raw.created_at ? Date.parse(raw.created_at) || undefined : undefined,
  };
}

export function mapPagedCards(paged: RawPaged<RawVideoCard>): { items: MediaItem[]; next: number | null } {
  const items = Array.isArray(paged?.items) ? paged.items.map(mapRawCard).filter((x): x is MediaItem => !!x) : [];
  const pagination = paged?.pagination;
  const page = Number(pagination?.page) || 1;
  const pages = Number(pagination?.pages) || 1;
  return { items, next: items.length && page < pages ? page + 1 : null };
}

/** Fixed channel catalog, aligned with upstream CHANNELS (Category.tsx:18-22). */
export const HG_CHANNELS = [
  { cate: "ai-duanju", name: "AI成人短剧" },
  { cate: "ai-manju", name: "AI成人漫剧" },
  { cate: "original", name: "原创" },
] as const;

/** Upstream CHANNEL_SORTS (Category.tsx:186-190), non-original channels. */
export const CHANNEL_SORTS = [
  { value: "latest", label: "最近更新" },
  { value: "hot_window", label: "当前热播" },
  { value: "random", label: "精选推荐" },
] as const;

/** Upstream ORIGINAL_CATES (Category.tsx:192-196), original channel sub-tabs. */
export const ORIGINAL_CATES = [
  { value: "all", label: "全部原创" },
  { value: "ai-manju", label: "原创漫剧" },
  { value: "ai-duanju", label: "原创短剧" },
] as const;

/** Original "all" keeps the upstream "new" sort; sub-categories use latest. */
export function originalSort(cate: string): string {
  return cate === "all" ? "new" : "latest";
}

export interface RawPost {
  id: number | string;
  title: string;
  desc?: string;
  content?: string;
  cover?: ImageRef;
  tags?: string[];
  hot?: number;
  video_id?: number | string;
  /** Upstream legacy direct link; the playback endpoint is authoritative. */
  video_url?: string;
  author?: RawAuthor;
  created_at?: string;
}

/** Upstream Post (types.ts:107-121) adapted onto the protocol MediaItem model. */
export function mapRawPost(raw: RawPost): MediaItem | null {
  if (!raw || raw.id === undefined || raw.id === null) return null;
  const stats: MediaItem["stats"] = {};
  if (Number.isFinite(Number(raw.hot))) stats.hot = Number(raw.hot);
  return {
    id: `post-${raw.id}`,
    title: raw.title || "未命名",
    type: "other",
    cover: raw.cover || undefined,
    description: raw.desc || raw.content || undefined,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    badge: "帖子",
    stats,
    author: raw.author ? { id: String(raw.author.id || 0), name: raw.author.name || "作者" } : undefined,
    publishedAt: raw.created_at ? Date.parse(raw.created_at) || undefined : undefined,
  };
}

export function mapPagedPosts(paged: RawPaged<RawPost>): { items: MediaItem[]; next: number | null } {
  const items = Array.isArray(paged?.items) ? paged.items.map(mapRawPost).filter((x): x is MediaItem => !!x) : [];
  const pagination = paged?.pagination;
  const page = Number(pagination?.page) || 1;
  const pages = Number(pagination?.pages) || 1;
  return { items, next: items.length && page < pages ? page + 1 : null };
}

export interface RawTopicCard {
  id: number | string;
  title: string;
  slug: string;
  cover?: ImageRef;
  intro?: string;
  video_count?: number;
}

export interface RawTopicDetail {
  topic: RawTopicCard;
  videos: RawPaged<RawVideoCard>;
  related?: RawTopicCard[];
}

/** Upstream RankItem (types.ts:66-79), served by xhome.rank. */
export interface RawRankItem {
  rank: number;
  video_id: number | string;
  title: string;
  cover?: ImageRef;
  tags?: string[];
  score?: number;
  cate_name?: string;
  episode_count?: number;
  is_finished?: boolean;
  metric_label?: string;
  metric_value?: number;
  metrics?: { collect?: number; comment?: number; like?: number; play?: number };
}

/** Upstream RANK_TABS (Search.tsx:304-308). All three hit the JSON rank
 *  endpoints; the SSR hot-rank page scrape used as a fallback upstream is not
 *  ported (no DOM scraping in the sandbox). */
export const RANK_TABS = [
  { value: "hot", label: "热播榜" },
  { value: "recommend", label: "推荐榜" },
  { value: "potential", label: "潜力榜" },
] as const;

export type RankKind = typeof RANK_TABS[number]["value"];
