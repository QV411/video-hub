import { createElement, useEffect, useMemo, useState, type ReactNode } from "react";
import { IBack, IFireF, IPlayF } from "../../icons";
import { openPluginLink, pluginError, type InstalledPlugin } from "../client";
import { Notice, type OpenMedia } from "../BrowsePages";
import { parseArticleHtml } from "../ArticlePage";
import { useAssetUrls } from "../MediaCards";
import { usePluginRequests } from "../usePluginRequests";
import ContentPlayer from "../ContentPlayer";
import { useStore } from "../../store";
import type { RawPost } from "./shared";

/** Upstream PostDetail treats content as HTML when it carries block tags
 *  (Posts.tsx `isHtml`); otherwise it renders plain text. */
const isHtml = (s: string) => /<(p|div|br|img|h[1-6]|ul|ol|li|blockquote|span|strong|em)\b/i.test(s);

type RichNode = string | { tag: string; children: RichNode[]; href?: string; image?: number; alt?: string };

/** Sanitized post body, reusing the host ArticlePage allow-list parser. */
function PostHtml({ plugin, html }: { plugin: InstalledPlugin; html: string }) {
  const tree = useMemo(() => parseArticleHtml(html, !!plugin.meta.allowInsecureHttp), [html, plugin.meta.allowInsecureHttp]);
  const urls = useAssetUrls(plugin.meta.id, tree.images);
  const [error, setError] = useState("");
  const render = (nodes: RichNode[], prefix = ""): ReactNode[] => nodes.map((node, i) => {
    const key = `${prefix}/${i}`;
    if (typeof node === "string") return node;
    if (node.tag === "img") return urls[node.image!] ? <img key={key} src={urls[node.image!]} alt={node.alt} loading="lazy" /> : null;
    if (node.tag === "br" || node.tag === "hr") return createElement(node.tag, { key });
    if (node.tag === "a") return node.href ? <a key={key} href={node.href} onClick={e => { e.preventDefault(); void openPluginLink(node.href!).catch(err => setError(pluginError(err))); }}>{render(node.children, key)}</a> : <span key={key}>{render(node.children, key)}</span>;
    return createElement(node.tag, { key }, render(node.children, key));
  });
  return <><Notice error={error} /><div className="hpp-article-html">{render(tree.nodes)}</div></>;
}

/** 帖子详情（网页式浏览），mirrors upstream PostDetail (Posts.tsx):
 *  list data shows immediately; full content arrives from `xdiscover.post`
 *  when the source exposes it; the post video resolves through
 *  `xdiscover.postPlayback` (upstream api_post_playback) and plays INLINE via
 *  the host article.prepare pipeline (the play source maps segments onto
 *  streams through `articles.getDetail`); a linked video falls back to the
 *  host media detail (`open` → media.getDetail → playback). */
export default function HghubxPost({ plugin, post: initial, onBack, open, onOpenTag }: {
  plugin: InstalledPlugin; post: RawPost; onBack: () => void; open: OpenMedia;
  onOpenTag: (tag: { name: string; slug?: string }) => void;
}) {
  const request = usePluginRequests();
  const app = useStore();
  /* The post page lives under stack overlays (media detail); a full-screen
   * media playback elsewhere must pause this inline player immediately. */
  const playerActive = !app.watching;
  const [post, setPost] = useState<RawPost>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canFetchDetail = plugin.methods.includes("xdiscover.post");
  /* Upstream PostDetail playback state: segment list from api.postPlayback,
   * the post's own video_url as a legacy fallback, current segment index. */
  const canPlayInline = plugin.methods.includes("articles.getDetail");
  const [segs, setSegs] = useState<string[]>([]);
  const [seg, setSeg] = useState(0);
  const [play, setPlay] = useState(false);

  useEffect(() => {
    setPost(initial);
    setError("");
    setSegs([]); setSeg(0); setPlay(false);
    if (!canFetchDetail) return;
    let alive = true;
    setBusy(true);
    request<RawPost>("call", { id: plugin.meta.id, method: "xdiscover.post", args: { id: initial.id } })
      .then(d => {
        if (!alive || !d) return;
        setPost({ ...initial, ...d });
        if (d.video_url) setSegs(prev => prev.length ? prev : [String(d.video_url)]);
      })
      .catch(e => { if (alive) setError(pluginError(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; request.cancelAll(); };
  }, [plugin.meta.id, initial, canFetchDetail, request]);

  /* Upstream resolves post segments with api.postPlayback(id) in parallel with
   * the detail fetch; the direct-link fallback only fills an empty list. */
  useEffect(() => {
    if (!canPlayInline) return;
    let alive = true;
    request<{ videos?: { url?: string }[] }>("call", {
      id: plugin.meta.id,
      method: "xdiscover.postPlayback",
      args: { id: initial.id },
    })
      .then(r => {
        if (!alive) return;
        const list = (r?.videos || []).map(v => v?.url || "").filter(Boolean);
        if (list.length) setSegs(list);
      })
      .catch(() => { /* resolution errors surface when playback starts */ });
    return () => { alive = false; };
  }, [plugin.meta.id, initial, canPlayInline, request]);

  const cover = useAssetUrls(plugin.meta.id, post.cover ? [post.cover] : [])[0];
  const content = post.content || "";
  const videoId = post.video_id !== undefined && post.video_id !== null && String(post.video_id) ? String(post.video_id) : "";
  const hot = Number(post.hot);

  return <div className="hpp-page refined-page absolute inset-0 flex flex-col">
    <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
      <div className="flex items-center gap-2">
        <button className="pressable" aria-label="返回" onClick={onBack}><IBack size={17} /></button>
        <h1 className="text-[20px] font-bold text-on leading-none flex-1 truncate">帖子详情</h1>
      </div>
    </header>
    <div className="hpp-scroll flex-1"><div className="hpp-content">
      <Notice error={error} />
      {canPlayInline && (play && segs.length ? (
        <div className="hpp-post-media is-playing">
          <ContentPlayer
            key={seg}
            plugin={plugin}
            action="article.prepare"
            contentId={String(post.id)}
            active={playerActive}
            initialStreamIndex={seg}
            onEnded={() => { if (seg < segs.length - 1) setSeg(seg + 1); }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="hpp-post-media"
          onClick={() => { if (segs.length) setPlay(true); }}
          disabled={!segs.length}
          aria-label={segs.length ? "播放视频" : "暂无视频"}
        >
          {cover ? <img src={cover} alt="" /> : <span className="hpp-post-media-ph" />}
          {!!segs.length && <span className="hpp-post-media-play" aria-hidden="true"><IPlayF size={22} /></span>}
        </button>
      ))}
      {segs.length > 1 && <div className="hpp-post-segs" role="group" aria-label="视频分段">
        {segs.map((_, i) => (
          <button key={i} aria-pressed={i === seg} className={i === seg ? "is-on" : ""}
            onClick={() => { setSeg(i); setPlay(true); }}>{i + 1}</button>
        ))}
      </div>}
      <h2 className="text-[17px] font-bold text-on leading-snug">{post.title || "未命名"}</h2>
      <div className="flex flex-wrap items-center gap-2 mt-2 text-[12px] text-mut">
        {post.created_at && <span>{post.created_at}</span>}
        {post.author?.name && <span>{post.author.name}</span>}
        {Number.isFinite(hot) && <span className="inline-flex items-center gap-1"><IFireF size={11} />{hot} 次浏览</span>}
      </div>
      {!!(post.tags || []).length && <div className="flex flex-wrap gap-1.5 mt-2.5">
        {(post.tags || []).slice(0, 8).map(t => <button key={t} className="px-2.5 h-7 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable"
          onClick={() => onOpenTag({ name: t })}>#{t}</button>)}
      </div>}
      {busy && !content && <div className="hpp-skeleton mt-4" aria-label="正在加载帖子正文" />}
      {content
        ? (isHtml(content)
          ? <div className="mt-3.5"><PostHtml plugin={plugin} html={content} /></div>
          : <p className="mt-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap select-text">{content}</p>)
        : post.desc
          ? <p className="mt-3.5 text-[14px] leading-relaxed text-on/80 whitespace-pre-wrap select-text">{post.desc}</p>
          : !busy && <p className="hpp-muted mt-4 text-[13px]">当前片源未接入帖子正文接口（xdiscover.post），仅展示列表信息。</p>}
      {videoId && !segs.length && <div className="mt-5">
        <button className="primary" onClick={() => open(plugin.meta.id, videoId)}>查看关联作品</button>
      </div>}
    </div></div>
  </div>;
}