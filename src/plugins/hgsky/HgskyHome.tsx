import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { type InstalledPlugin } from "../client";
import { Notice, type OpenMedia } from "../BrowsePages";
import PluginMediaDetail from "../PluginMediaDetail";
import { useAssetUrls } from "../MediaCards";
import { useHghubxList } from "../hghubx/useHghubxList";
import { Logo } from "../../icons";
import HgskyToolbar from "./HgskyToolbar";
import "./hgsky-toolbar.css";

/**
 * HGsky 专用首页渲染器（911218sky/HGhub 首页视图）。
 *
 * 与 HGhubX 渲染器同架构：数据来自插件声明的 `skyhome.feed` 扩展方法，
 * 沙箱内只回传结构化卡片，宿主 React 负责竖滑队列与详情/播放链路。
 * 上游 `src/pages/Home.tsx` 即单源 `api.feed` 分页 + 竖滑 Feed；这里复用既有
 * 预览详情链路承载队列，右侧互动工具栏由 HgskyToolbar 对齐上游 Feed 右侧栏
 * （关注/点赞/评论/收藏/选集/下载/分享，按插件能力降级）。
 */
export default function HgskyHome({ plugin, manage }: { plugin: InstalledPlugin; open: OpenMedia; manage: () => void }) {
  const app = useStore();
  const list = useHghubxList(plugin, "skyhome.feed", {});
  const [index, setIndex] = useState(0);

  const items = list.items;
  const current = items[index];
  const before = items[index - 1];
  const after = items[index + 1];
  const beforePoster = useAssetUrls(plugin.meta.id, before?.cover ? [before.cover] : [])[0];
  const afterPoster = useAssetUrls(plugin.meta.id, after?.cover ? [after.cover] : [])[0];

  // A refresh empties the list; keep the queue index inside the visible range.
  useEffect(() => {
    if (index > items.length - 1) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  const next = () => {
    if (index + 1 < items.length) setIndex(index + 1);
    else if (list.next && !list.busy) void list.loadMore();
  };
  const previous = () => setIndex(Math.max(0, index - 1));

  useEffect(() => {
    if (after && items.length - index < 4 && list.next && !list.busy) void list.loadMore();
  }, [after, items.length, index, list.next, list.busy]);

  if (!current) {
    return <div className="legacy-home">
      <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-4 text-white/60 text-xs">
        <Logo size={42} />
        <p>{list.busy ? "正在加载…" : list.error ? "首页加载失败" : "暂无可播放内容"}</p>
        {list.error && <button className="rounded-full px-5 py-2 bg-white/10" onClick={list.refresh}>重试</button>}
        {!list.busy && !list.error && <button className="rounded-full px-5 py-2 bg-white/10" onClick={manage}>管理插件</button>}
      </div>
      {!!list.error && <Notice error={list.error} />}
    </div>;
  }

  return <div className="legacy-home hgsky-home">
    <PluginMediaDetail
      key={JSON.stringify([plugin.meta.id, plugin.revision, current.id])}
      active
      plugin={plugin}
      mediaId={current.id}
      entryItem={current}
      manage={manage}
      onSwitch={(pluginId, mediaId, start) => app.push({ kind: "media", pluginId, mediaId, start })}
      presentation={{
        mode: "preview",
        title: current.title,
        queueIndex: index,
        total: items.length,
        onNext: index + 1 < items.length || list.next ? next : undefined,
        onPrevious: index ? previous : undefined,
        nextPreview: after ? { title: after.title, poster: afterPoster } : undefined,
        previousPreview: before ? { title: before.title, poster: beforePoster } : undefined,
      }}
    />
    {!app.clean && <HgskyToolbar
      plugin={plugin}
      item={current}
      index={index}
      total={items.length}
      onNext={index + 1 < items.length || list.next ? next : undefined}
      onPrevious={index ? previous : undefined}
    />}
  </div>;
}
