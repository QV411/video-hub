import type { InstalledPlugin } from "../client";
import { Notice, type OpenMedia } from "../BrowsePages";
import MediaCards from "../MediaCards";
import { useHghubxList } from "./useHghubxList";
import { IRefresh } from "../../icons";

export default function HghubxHome({ plugin, open, manage }: { plugin: InstalledPlugin; open: OpenMedia; manage: () => void }) {
  const list = useHghubxList(plugin, "xhome.feed", {});
  return <div className="hpp-page hpp-category-page refined-page">
    <header className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
      <div className="flex items-center justify-between gap-2">
        <div><h1 className="text-[24px] font-bold text-on leading-none">发现</h1><p className="text-[11.5px] text-mut mt-1">{plugin.meta.name} · HGhubX 模式</p></div>
        <button className="pressable" aria-label="刷新首页" onClick={list.refresh} disabled={list.busy}><IRefresh size={18}/></button>
      </div>
    </header>
    <div className="hpp-scroll"><div className="hpp-content">
      <Notice error={list.error}/>
      {list.busy && !list.items.length && <div className="hpp-skeleton" aria-label="正在加载内容"/>}
      {!!list.items.length && <MediaCards pluginId={plugin.meta.id} items={list.items} open={i => open(plugin.meta.id, i.id)}/>}
      {list.next && <div className="flex justify-center py-5"><button className="primary" onClick={list.loadMore} disabled={list.busy}>加载更多</button></div>}
      {!list.busy && !list.items.length && !list.error && <div className="hpp-empty"><h2>暂无内容</h2><p>片源当前没有可展示的影片。</p><button onClick={manage}>管理插件</button></div>}
    </div></div>
  </div>;
}
