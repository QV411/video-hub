import { useEffect, useState } from "react";
import { ISearch, IClose, IFireF } from "../../icons";
import { pluginError, type InstalledPlugin } from "../client";
import { Notice, type OpenMedia } from "../BrowsePages";
import MediaCards from "../MediaCards";
import { usePluginRequests } from "../usePluginRequests";
import { useHghubxList } from "./useHghubxList";

interface HotItem { videoId: number; title: string; plays?: string }

export default function HghubxSearch({ plugin, open, manage }: { plugin: InstalledPlugin; open: OpenMedia; manage: () => void }) {
  const request = usePluginRequests();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [hot, setHot] = useState<HotItem[]>([]);
  const [hotError, setHotError] = useState("");
  const list = useHghubxList(plugin, "xsearch.search", submitted ? { query: submitted } : {}, !!submitted);

  useEffect(() => {
    if (!plugin) return;
    let live = true;
    void request<{ items: HotItem[] }>("call", { id: plugin.meta.id, method: "xsearch.hot", args: {} })
      .then(r => { if (live) setHot(r.items || []); })
      .catch(e => { if (live) setHotError(pluginError(e)); });
    return () => { live = false; };
  }, [plugin.meta.id, request]);

  const submit = (q: string) => {
    const value = q.trim();
    if (!value) return;
    setQuery(value);
    setSubmitted(value);
  };

  return <div className="refined-page refined-search legacy-search-page absolute inset-0 bg-bg flex flex-col">
    <header className="refined-search-heading"><h1>搜索</h1><span>{plugin.meta.name}</span></header>
    <div className="refined-search-console shrink-0 px-4 pb-3 flex items-center gap-2.5" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
      <form className="hpp-search legacy-search-form flex-1 flex items-center gap-2 h-11 rounded-(--r-ctl) bg-s3 px-3.5 focus-within:bg-s4 transition-colors" onSubmit={e => { e.preventDefault(); submit(query); }}>
        <button type="submit" aria-label="搜索" className="text-mut shrink-0 pressable"><ISearch size={17}/></button>
        <input aria-label="搜索关键词" placeholder="搜索作品…" value={query} onChange={e => setQuery(e.target.value)} className="flex-1 min-w-0 bg-transparent text-[13.5px] text-on placeholder-dim outline-none"/>
        {query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(""); setSubmitted(""); }} className="w-5 h-5 rounded-full bg-s4 flex items-center justify-center text-mut pressable"><IClose size={11}/></button>}
      </form>
    </div>
    <div className="refined-search-scroll flex-1 min-h-0 scroll-y px-4 pb-6">
      {!submitted && <>
        {!!hot.length && <section className="mt-1 a-rise" aria-label="热门搜索">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-on/90"><IFireF size={15} className="text-primary"/>热门搜索</div>
          <div className="flex flex-wrap gap-2 mt-3">{hot.map(h => <button key={h.videoId || h.title} onClick={() => submit(h.title)} className="px-3 h-7 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable">{h.title}</button>)}</div>
        </section>}
        {hotError && <Notice error={hotError}/>}
        {!hot.length && <p className="hpp-muted mt-6">输入关键词搜索 {plugin.meta.name} 的作品。</p>}
        <button onClick={manage} className="text-primary text-xs pressable mt-4">管理插件</button>
      </>}
      {submitted && <>
        <Notice error={list.error}/>
        {list.busy && !list.items.length && <div className="hpp-skeleton" aria-label="正在搜索"/>}
        {!!list.items.length && <MediaCards pluginId={plugin.meta.id} items={list.items} open={i => open(plugin.meta.id, i.id)}/>}
        {list.next && <div className="flex justify-center py-5"><button className="primary" onClick={list.loadMore} disabled={list.busy}>加载更多</button></div>}
        {!list.busy && !list.items.length && <div className="py-12 text-center text-mut"><ISearch size={26} className="mx-auto mb-3"/><p className="text-sm">没有找到「{submitted}」相关内容</p></div>}
      </>}
    </div>
  </div>;
}
