import { useEffect, useState } from "react";
import { ICpu, IBack, IChevR, IRefresh, ILink } from "../icons";
import { pluginError, type InstalledPlugin } from "./client";
import type { Endpoint } from "./protocol";
import { usePluginRequests } from "./usePluginRequests";
import LinePicker from "./hghubx/LinePicker";
import { isMobile } from "../environment";
import { registerBackHandler } from "../back";

const statuses: Record<InstalledPlugin["status"], string> = {
  ready: "已就绪", unloaded: "待加载", failed: "运行失败", incompatible: "不兼容", disabled: "已停用",
};

function hostOf(url?: string | null): string {
  return (url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** 播放源板块：统一管理提供播放来源的插件。内置「播放源」是其中一个入口；
 *  点开任一入口进入该来源的线路管理（内置播放源用固定/镜像/自定义线路面板，
 *  其他来源用标准站点线路）。 */
export default function PlaySourceSection({ plugins, reload }: { plugins: InstalledPlugin[]; reload: () => Promise<void> }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const selected = plugins.find(p => p.meta.id === openId);

  useEffect(() => { if (openId && !plugins.some(p => p.meta.id === openId)) setOpenId(null); }, [plugins, openId]);
  useEffect(() => {
    if (isMobile && selected) return registerBackHandler(() => { setOpenId(null); return true; }, 18);
  }, [selected]);

  if (selected) {
    return <div className="ps-detail">
      <div className="ps-detail-head">
        <button className="ps-back pressable" aria-label="返回播放源列表" onClick={() => setOpenId(null)}><IBack size={18}/>播放源</button>
        <div className="ps-detail-title">
          <strong>{selected.meta.name}</strong>
          <small>{selected.endpoint?.url ? "当前：" + hostOf(selected.endpoint.url) : statuses[selected.status]}</small>
        </div>
      </div>
      {!selected.enabled
        ? <p className="hpp-muted">停用状态下不可管理线路。请先在列表中启用该播放源。</p>
        : selected.methods.includes("lines.state")
          ? <LinePicker plugin={selected} reload={reload}/>
          : selected.methods.includes("endpoints.list")
            ? <EndpointLines plugin={selected} reload={reload}/>
            : <SingleOrigin plugin={selected}/>}
    </div>;
  }

  return <div className="ps-hub">
    <p className="ps-hub-intro">统一管理提供播放来源的插件。内置「播放源」是其中一个入口，点开即可切换线路、管理镜像与自定义地址。</p>
    {error && <p role="alert" className="hpp-error">{error}</p>}
    {!plugins.length && <div className="hpp-empty"><ICpu size={40}/><h2>还没有播放源插件</h2><p>导入内容源插件后，可在这里管理它们的线路。</p></div>}
    <ul className="ps-entry-list">
      {plugins.map(p => <li key={p.meta.id}>
        <div className={`ps-entry${p.enabled ? "" : " is-off"}`}>
          <button className="ps-entry-main pressable" aria-label={"管理 " + p.meta.name + " 的线路"} onClick={() => setOpenId(p.meta.id)}>
            <span className="refined-glyph">{p.meta.name.slice(0, 1)}</span>
            <span className="ps-entry-copy">
              <strong>{p.meta.name}{p.builtIn && <span className="ps-badge">内置</span>}</strong>
              <small>{p.endpoint?.url ? hostOf(p.endpoint.url) : (p.methods.includes("lines.state") || p.methods.includes("endpoints.list") ? "多线路 · 待选择" : "单一来源")} · {statuses[p.status]}</small>
            </span>
            <IChevR size={16}/>
          </button>
          <EnableSwitch plugin={p} reload={reload} onError={setError}/>
        </div>
      </li>)}
    </ul>
  </div>;
}

function EnableSwitch({ plugin, reload, onError }: { plugin: InstalledPlugin; reload: () => Promise<void>; onError: (message: string) => void }) {
  const request = usePluginRequests();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true); onError("");
    try { await request("enable", { id: plugin.meta.id, enabled: !plugin.enabled }); await reload(); }
    catch (e) { onError(pluginError(e)); }
    finally { setBusy(false); }
  };
  return <button className="plugin-enable-switch" role="switch" aria-checked={plugin.enabled} aria-label={"启用 " + plugin.meta.name} disabled={busy} onClick={() => void toggle()}><span/></button>;
}

interface EndpointProbe { id: string; ok: boolean; latencyMs: number; status?: number; error?: string }

/** 标准站点线路管理：复用既有 endpoint.list / endpoint.probe / endpoint.set 命令，
 *  与内置线路面板共用同一套 vh 卡片/行/状态样式。 */
function EndpointLines({ plugin, reload }: { plugin: InstalledPlugin; reload: () => Promise<void> }) {
  const request = usePluginRequests();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [probes, setProbes] = useState<Record<string, EndpointProbe>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void request<Endpoint[]>("endpoint.list", { id: plugin.meta.id, refresh: false })
      .then(e => { setEndpoints(e); setLoaded(true); }).catch(e => setError(pluginError(e)));
    return () => request.cancelAll();
  }, [plugin.meta.id]);

  const current = plugin.endpoint?.id || endpoints[0]?.id;
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(pluginError(e)); } finally { setBusy(false); } };
  const switchTo = (id: string) => run(async () => { await request("endpoint.set", { id: plugin.meta.id, endpointId: id }); await reload(); });
  const refresh = () => run(async () => { const e = await request<Endpoint[]>("endpoint.list", { id: plugin.meta.id, refresh: true }); setEndpoints(e); setProbes({}); await reload(); });
  const probe = () => run(async () => { const r = await request<EndpointProbe[]>("endpoint.probe", { id: plugin.meta.id }); const m: Record<string, EndpointProbe> = {}; for (const x of r) m[x.id] = x; setProbes(m); });

  return <div className="hpp-lines-panel">
    {error && <p role="alert" className="hpp-error">{error}</p>}
    {!loaded && !error && <div className="hpp-skeleton" aria-label="正在加载站点线路" />}
    {loaded && <>
      <div className="line-current-head"><span>当前线路</span><strong>{hostOf(plugin.endpoint?.url || endpoints[0]?.url) || "未选择"}</strong></div>
      <div className="line-toolbar">
        <button className="line-btn line-btn-secondary pressable" disabled={busy} onClick={() => void probe()}><IRefresh size={14}/>探测全部</button>
        <button className="line-btn line-btn-secondary pressable" disabled={busy} onClick={() => void refresh()}>刷新线路</button>
      </div>
      <section className="line-group">
        <header className="line-group-head"><h3>站点线路</h3><small>该来源提供的入口域名，点选切换</small></header>
        <ul className="line-list">
          {endpoints.map(e => {
            const p = probes[e.id];
            const active = current === e.id;
            const tone = p ? (p.ok ? "ready" : "failed") : "unloaded";
            const statusText = p ? (p.ok ? `可达 · ${p.latencyMs} ms` : p.error || `HTTP ${p.status ?? "不可达"}`) : "未探测";
            return <li className="line-row" key={e.id}>
              <button className="line-main pressable" aria-pressed={active} disabled={busy} onClick={() => void switchTo(e.id)}>
                <span className={`line-status ${tone}`} aria-label={statusText}><span className="line-status-dot"/>{statusText}</span>
                <span className="line-label">{e.label || e.id}</span>
                <span className="line-url">{e.url}</span>
              </button>
              {active && <span className="line-current">当前</span>}
            </li>;
          })}
          {!endpoints.length && <li className="line-empty">该来源没有可用的站点线路</li>}
        </ul>
      </section>
    </>}
  </div>;
}

function SingleOrigin({ plugin }: { plugin: InstalledPlugin }) {
  return <div className="hpp-lines-panel">
    <div className="line-current-head"><span>当前来源</span><strong>{hostOf(plugin.endpoint?.url) || plugin.meta.name}</strong></div>
    <p className="line-note"><ILink size={13}/> 该来源为单一地址，没有可切换的备用线路。</p>
  </div>;
}