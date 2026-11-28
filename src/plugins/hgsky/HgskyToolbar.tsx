import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { isMobile } from "../../environment";
import { useHost, libraryKey } from "../HostContext";
import { pluginError, type InstalledPlugin } from "../client";
import { usePluginRequests } from "../usePluginRequests";
import type { MediaDetail, MediaItem } from "../protocol";
import { readMetadata } from "../metadataCache";
import { downloadStart } from "../../download";
import CommentsPanel from "../CommentsPanel";
import { Sheet } from "../../components/ui";
import {
  IChevronDown, IChevronUp, ICommentF, IDownload, IHeart, IHeartF,
  ILink, IList, IStar, IStarF, IVol, IVolMute,
} from "../../icons";

/**
 * HGsky 首页右侧工具栏（对齐 911218sky/HGhub src/components/Feed.tsx 的
 * 右侧竖排互动栏：关注头像 / 点赞 / 评论 / 收藏 / 选集进入剧场 / 下载 / 分享，
 * 桌面端另带上一个/下一个翻页器）。
 *
 * 能力映射（宿主没有的云端能力按既有本地能力降级）：
 * - 关注头像 → interact.follow（如插件支持），否则本地「追更」（library.put tracking）
 * - 点赞     → interact.like（如插件支持），否则隐藏（宿主无本地点赞）
 * - 评论     → comments.list（如插件支持）弹层，否则隐藏
 * - 收藏     → interact.favorite（如插件支持），否则本地收藏（library.put favorite）
 * - 选集     → 打开作品详情页（含选集/播放/下载面板）
 * - 下载     → 整剧离线下载（download_start mode=series）并跳转下载页
 * - 分享     → 系统分享，降级为复制作品信息
 */
const fmtCount = (n?: number) => {
  if (n === undefined || !Number.isFinite(n)) return "0";
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : String(n);
};

export default function HgskyToolbar({ plugin, item, index, total, onNext, onPrevious }: {
  plugin: InstalledPlugin; item: MediaItem; index: number; total: number;
  onNext?: () => void; onPrevious?: () => void;
}) {
  const app = useStore(), host = useHost(), request = usePluginRequests();
  const methods = plugin.methods;
  const canLike = methods.includes("interact.like");
  const canCloudFav = methods.includes("interact.favorite");
  const canFollow = !!item.author && methods.includes("interact.follow");
  const canComment = methods.includes("comments.list");
  const entry = host.library.find(e => libraryKey(e.pluginId, e.mediaId) === libraryKey(plugin.meta.id, item.id));

  const [liked, setLiked] = useState<boolean | undefined>(undefined);
  const [cloudFav, setCloudFav] = useState<boolean | undefined>(undefined);
  const [followed, setFollowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [hint, setHint] = useState("");
  const lock = useRef(false);
  useEffect(() => { if (!hint) return; const t = window.setTimeout(() => setHint(""), 2200); return () => window.clearTimeout(t); }, [hint]);

  useEffect(() => {
    setLiked(undefined); setCloudFav(undefined); setFollowed(false); setCommentsOpen(false);
    if (!canLike && !canCloudFav) return;
    let live = true;
    void readMetadata<MediaDetail>(plugin, "media.getDetail", { id: item.id }).then(d => {
      if (!live) return;
      setLiked(d.interaction?.liked); setCloudFav(d.interaction?.favorited);
    }).catch(() => {});
    return () => { live = false; };
  }, [plugin.meta.id, plugin.revision, item.id, canLike, canCloudFav]);

  const act = async (method: string, args: Record<string, unknown>, done: () => void) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await request("call", { id: plugin.meta.id, method, args }); done(); }
    catch (e) { if ((e as { code?: string })?.code !== "CANCELLED") setHint(pluginError(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  const target = { kind: "media", mediaId: item.id };
  const toggleLike = () => void act("interact.like", { target, on: !liked }, () => setLiked(!liked));
  const toggleFollow = () => {
    if (canFollow) { void act("interact.follow", { authorId: item.author!.id, on: !followed }, () => setFollowed(!followed)); return; }
    void host.put(plugin.meta.id, item, { tracking: !entry?.tracking }).catch(e => setHint(pluginError(e)));
  };
  const toggleFavorite = () => {
    if (canCloudFav) { void act("interact.favorite", { target, on: !cloudFav }, () => setCloudFav(!cloudFav)); return; }
    void host.put(plugin.meta.id, item, { favorite: !entry?.favorite }).catch(e => setHint(pluginError(e)));
  };
  const openSeries = () => app.push({ kind: "media", pluginId: plugin.meta.id, mediaId: item.id });
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const detail = await readMetadata<MediaDetail>(plugin, "media.getDetail", { id: item.id });
      const list = detail.playlists[0];
      const ep = list?.episodes.find(e => !e.locked);
      await downloadStart({
        pluginId: plugin.meta.id, mediaId: item.id,
        episodeId: ep?.id, playlistId: list?.id,
        ep: ep ? ep.episodeNumber ?? ep.index : undefined,
        mode: "series",
      });
      app.push({ kind: "downloads" });
    } catch (e) { setHint(pluginError(e)); }
    finally { setDownloading(false); }
  };
  const share = async () => {
    const text = `${item.title}${item.author ? ` · ${item.author.name}` : ""} · ${plugin.meta.name}`;
    if (typeof navigator.share === "function") {
      try { await navigator.share({ title: item.title, text }); return; } catch { /* 用户取消或不支持，降级复制 */ }
    }
    try { await navigator.clipboard.writeText(text); setHint("已复制分享信息"); }
    catch { setHint("当前环境不支持分享"); }
  };

  const favoriteOn = canCloudFav ? !!cloudFav : !!entry?.favorite;
  const followOn = canFollow ? followed : !!entry?.tracking;
  const authorName = item.author?.name || plugin.meta.name;

  return <>
    <div className="hgsky-toolbar" role="toolbar" aria-label="首页互动工具栏" aria-orientation="vertical">
      {!isMobile && <div className="hgsky-toolbar-pager">
        <button aria-label="上一个" disabled={!onPrevious} onClick={onPrevious}><IChevronUp size={19}/></button>
        <button aria-label="下一个" disabled={!onNext} onClick={onNext}><IChevronDown size={19}/></button>
        <small>{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</small>
      </div>}
      <button aria-label={app.muted ? "取消静音" : "静音"} aria-pressed={app.muted} onClick={() => app.setMuted(v => !v)}>
        <span className="hgsky-toolbar-glyph">{app.muted ? <IVolMute size={22}/> : <IVol size={22}/>}</span>
        <small>{app.muted ? "静音" : "声音"}</small>
      </button>
      <button className="hgsky-toolbar-avatar" aria-label={canFollow ? (followOn ? "取消关注作者" : "关注作者") : (followOn ? "取消追更" : "追更这部作品")} aria-pressed={followOn} disabled={busy} onClick={toggleFollow}>
        <span className="hgsky-toolbar-face">{authorName.slice(0, 1).toUpperCase()}</span>
        {!followOn && <span className="hgsky-toolbar-plus" aria-hidden="true">+</span>}
        <small>{canFollow ? (followOn ? "已关注" : "关注") : (followOn ? "已追更" : "追更")}</small>
      </button>
      {canLike && <button aria-label={liked ? "取消点赞" : "点赞"} aria-pressed={!!liked} disabled={busy} onClick={toggleLike}>
        <span className="hgsky-toolbar-glyph">{liked ? <IHeartF size={28} className="hgsky-toolbar-hot"/> : <IHeart size={28}/>}</span>
        <small>{fmtCount(item.stats?.likes)}</small>
      </button>}
      {canComment && <button aria-label="评论" onClick={() => setCommentsOpen(true)}>
        <span className="hgsky-toolbar-glyph"><ICommentF size={27}/></span>
        <small>{fmtCount(item.stats?.comments)}</small>
      </button>}
      <button aria-label={favoriteOn ? "取消收藏" : "收藏"} aria-pressed={favoriteOn} disabled={busy} onClick={toggleFavorite}>
        <span className="hgsky-toolbar-glyph">{favoriteOn ? <IStarF size={27} className="hgsky-toolbar-gold"/> : <IStar size={27}/>}</span>
        <small>{fmtCount(item.stats?.favorites)}</small>
      </button>
      <button aria-label="选集并进入作品详情" onClick={openSeries}>
        <span className="hgsky-toolbar-glyph"><IList size={26}/></span>
        <small>{item.episodeCount ? `选集 · ${item.episodeCount}` : "选集"}</small>
      </button>
      <button aria-label="下载整剧" disabled={downloading} onClick={() => void download()}>
        <span className="hgsky-toolbar-glyph"><IDownload size={26}/></span>
        <small>{downloading ? "准备中" : "下载"}</small>
      </button>
      <button aria-label="分享作品" onClick={() => void share()}>
        <span className="hgsky-toolbar-glyph"><ILink size={25}/></span>
        <small>分享</small>
      </button>
    </div>
    {canComment && <Sheet open={commentsOpen} z="z-[60]" onClose={() => setCommentsOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label="评论" className="hgsky-toolbar-comments flex flex-col">
        <CommentsPanel embedded plugin={plugin} mediaId={item.id}/>
      </div>
    </Sheet>}
    {hint && <div role="status" className="hgsky-toolbar-hint">{hint}</div>}
  </>;
}
