import { useCallback, useEffect, useState } from "react";
import { IRefresh, IPlus, ITrash, ICheck, IClose, IRotate } from "../../icons";
import { pluginError, type InstalledPlugin } from "../client";
import { usePluginRequests } from "../usePluginRequests";
import { validateLineOrigin } from "./lineOrigin";

interface FixedLine { label: string; url: string }
interface CustomLine { label: string; url: string }
interface MirrorLine { url: string; host: string; manual?: boolean }
interface ProbeResult { tier: string; url: string; ok: boolean; reachable: boolean; ms: number; status: number | null; at?: number; error?: string | null }
interface LineState {
  base: string;
  current?: { id: string | null; url: string };
  fixed: FixedLine[];
  mirrors: MirrorLine[];
  custom: CustomLine[];
  pages: string[];
  pagesAt: number | null;
  auto: boolean;
  fails: Record<string, number>;
  endpoints: { id: string; label: string; url: string }[];
}
interface PickResult { base: string; tier: string; ms: number; reason: string; mirrorError?: string | null }

type Editing = { group: "fixed" | "custom"; url: string } | null;

/* Custom tags are a frontend-only decoration layered on top of the line url
 * (the plugin label field stays untouched). Persisted locally so a tag
 * survives restarts; entries for removed lines are simply never read. */
const TAG_STORE_KEY = "hpp.line.tags";
const TAG_MAX_LEN = 14;

function loadLineTags(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(TAG_STORE_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(([, v]) => typeof v === "string" && v.trim()),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function normalize(url: string): string { return url.trim().replace(/\/+$/, ""); }

/** Frontend pre-validation mirrored from the plugin's validateOrigin; the
 *  plugin remains the authoritative validator and rejects unsafe origins. */
function validateOrigin(raw: string): string | null {
  const check = validateLineOrigin(raw);
  return check.ok ? null : (check.message || "地址不合法");
}

export default function LinePicker({ plugin, reload }: { plugin: InstalledPlugin; reload: () => Promise<void> }) {
  const request = usePluginRequests();
  const [state, setState] = useState<LineState | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mirrorError, setMirrorError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [pick, setPick] = useState<PickResult | null>(null);
  /* Long-press tag editor: which line is being tagged + its draft text. */
  const [tagEdit, setTagEdit] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [tags, setTags] = useState<Record<string, string>>(() => loadLineTags());

  // Draft forms: fixed / mirror / custom groups each keep their own inputs.
  const [fixedUrl, setFixedUrl] = useState("");
  const [fixedError, setFixedError] = useState("");
  const [mirrorUrl, setMirrorUrl] = useState("");
  const [mirrorAddError, setMirrorAddError] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [pageError, setPageError] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customError, setCustomError] = useState("");
  const [editUrl, setEditUrl] = useState("");

  const saveTag = (url: string, tag: string) => {
    const cleaned = tag.trim().slice(0, TAG_MAX_LEN);
    const next = { ...tags };
    if (cleaned) next[url] = cleaned;
    else delete next[url];
    setTags(next);
    try { localStorage.setItem(TAG_STORE_KEY, JSON.stringify(next)); } catch { /* tags are decorative */ }
  };

  const loadState = useCallback(async () => {
    try {
      const s = await request<LineState>("call", { id: plugin.meta.id, method: "lines.state", args: {} });
      setState(s);
      setLoaded(true);
    } catch (e) {
      setError(pluginError(e));
    }
  }, [plugin.meta.id, request]);

  useEffect(() => { void loadState(); return () => request.cancelAll(); }, [loadState, request]);

  const run = async (action: string, params: Record<string, unknown>, refreshState = true) => {
    setBusy(true); setError("");
    try {
      await request(action, { id: plugin.meta.id, ...params });
      if (refreshState) await loadState();
      await reload();
    } catch (e) { setError(pluginError(e)); } finally { setBusy(false); }
  };

  const probeAll = async (urls: string[]) => {
    if (!urls.length) return;
    setBusy(true); setError("");
    try {
      // lines.probe batches to stay inside the plugin-call budget; probing a
      // long list in chunks avoids the "插件调用超时" ceiling.
      const chunkSize = 12;
      const map: Record<string, ProbeResult> = {};
      for (let i = 0; i < urls.length; i += chunkSize) {
        const result = await request<{ items: ProbeResult[] }>("call", { id: plugin.meta.id, method: "lines.probe", args: { urls: urls.slice(i, i + chunkSize) } });
        for (const item of result.items) map[item.url] = item;
      }
      setProbes(prev => ({ ...prev, ...map }));
    } catch (e) { setError(pluginError(e)); } finally { setBusy(false); }
  };

  // Independent per-line probe: only calls lines.probe. It never switches the
  // current endpoint and does not write current / lastGood keys; the result is
  // held in the local probes map with a timestamp for short-term caching.
  const probeOne = async (url: string) => {
    setProbing(prev => ({ ...prev, [url]: true }));
    setError("");
    try {
      const result = await request<{ items: ProbeResult[] }>("call", { id: plugin.meta.id, method: "lines.probe", args: { urls: [url] } });
      const hit = result.items.find(i => i.url === url);
      if (hit) setProbes(prev => ({ ...prev, [url]: hit }));
    } catch (e) { setError(pluginError(e)); }
    finally { setProbing(prev => ({ ...prev, [url]: false })); }
  };

  const refreshMirrors = async () => {
    setBusy(true); setMirrorError("");
    try {
      const result = await request<{ items: MirrorLine[]; errors: string[]; pagesAt: number | null }>("call", { id: plugin.meta.id, method: "lines.mirrors", args: {} });
      if (result.errors?.length) setMirrorError(result.errors.join("；"));
      await loadState();
      await reload();
    } catch (e) { setMirrorError(pluginError(e)); } finally { setBusy(false); }
  };

  const autoPick = async () => {
    setBusy(true); setError(""); setPick(null);
    try {
      const result = await request<PickResult>("call", { id: plugin.meta.id, method: "lines.autoPick", args: {} });
      setPick(result);
      if (result.base) { await loadState(); await reload(); }
      else setError(result.mirrorError || "全部线路不可用，请检查网络后重试");
    } catch (e) { setError(pluginError(e)); } finally { setBusy(false); }
  };

  const switchLine = async (url: string) => {
    const entry = state?.endpoints.find(e => e.url === url);
    if (!entry) return;
    if (currentUrl === url) return;
    setPick(null);
    const wasAuto = !!state?.auto;
    setBusy(true); setError("");
    try {
      // Upstream parity: a manual pick closes auto-pick first; if the apply
      // fails, restore the previous auto state instead of leaving it off.
      if (wasAuto) await request("call", { id: plugin.meta.id, method: "lines.autoSet", args: { on: false } });
      await request("endpoint.set", { id: plugin.meta.id, endpointId: entry.id });
    } catch (e) {
      if (wasAuto) {
        try { await request("call", { id: plugin.meta.id, method: "lines.autoSet", args: { on: true } }); } catch { /* best-effort rollback */ }
      }
      setError(pluginError(e));
    } finally {
      setBusy(false);
      await loadState();
      await reload();
    }
  };

  /* ── fixed lines ── */
  const submitFixed = async () => {
    const url = normalize(fixedUrl);
    const problem = validateOrigin(url);
    if (problem) { setFixedError(problem); return; }
    setFixedError("");
    setFixedUrl("");
    await run("call", { method: "lines.addFixed", args: { url } });
  };

  const startEditFixed = (line: FixedLine) => {
    setEditing({ group: "fixed", url: line.url });
    setEditUrl(line.url); setFixedError("");
  };

  const saveEditFixed = async () => {
    if (!editing) return;
    const url = normalize(editUrl);
    const problem = validateOrigin(url);
    if (problem) { setFixedError(problem); return; }
    setFixedError("");
    await run("call", { method: "lines.updateFixed", args: { oldUrl: editing.url, newUrl: url } });
    setEditing(null); setEditUrl("");
  };

  const removeFixed = async (url: string) => {
    await run("call", { method: "lines.removeFixed", args: { url } });
  };

  /* ── mirrors ── */
  const submitMirror = async () => {
    const url = normalize(mirrorUrl);
    const problem = validateOrigin(url);
    if (problem) { setMirrorAddError(problem); return; }
    setMirrorAddError("");
    setMirrorUrl("");
    await run("call", { method: "lines.addMirror", args: { url } });
  };

  const removeMirror = async (url: string) => {
    await run("call", { method: "lines.removeMirror", args: { url } });
  };

  /* ── publish pages ── */
  const submitPage = async () => {
    const url = normalize(pageUrl);
    const problem = validateOrigin(url);
    if (problem) { setPageError(problem); return; }
    setPageError("");
    setPageUrl("");
    await run("call", { method: "lines.addPublishPage", args: { url } });
  };

  const removePage = async (url: string) => {
    await run("call", { method: "lines.removePublishPage", args: { url } });
  };

  /* ── custom lines ── */
  const submitCustom = async () => {
    const url = normalize(customUrl);
    const problem = validateOrigin(url);
    if (problem) { setCustomError(problem); return; }
    setCustomError("");
    setCustomUrl("");
    await run("call", { method: "lines.addCustom", args: { url } });
  };

  const startEditCustom = (line: CustomLine) => {
    setEditing({ group: "custom", url: line.url });
    setEditUrl(line.url); setCustomError("");
  };

  const saveEditCustom = async () => {
    if (!editing) return;
    const url = normalize(editUrl);
    const problem = validateOrigin(url);
    if (problem) { setCustomError(problem); return; }
    setCustomError("");
    await run("call", { method: "lines.updateCustom", args: { oldUrl: editing.url, newUrl: url } });
    setEditing(null); setEditUrl("");
  };

  const removeCustom = async (url: string) => {
    await run("call", { method: "lines.removeCustom", args: { url } });
  };

  const cancelEdit = () => { setEditing(null); setEditUrl(""); setFixedError(""); setCustomError(""); };

  const currentUrl = plugin.endpoint?.url || state?.base;
  const fails = state?.fails || {};
  const probeOf = (url: string) => probes[url];

  function probeTime(probe?: ProbeResult): string {
    return probe && probe.at ? new Date(probe.at).toLocaleTimeString() : "";
  }

  function healthText(url: string, probe?: ProbeResult): string {
    const failCount = Number(fails[url]) || 0;
    const when = probeTime(probe);
    const suffix = when ? ` · ${when}` : "";
    if (probe) {
      if (probe.ok) return (failCount > 0 ? `${probe.ms} ms · 失败 ${failCount} 次` : `${probe.ms} ms`) + suffix;
      return (probe.error || `HTTP ${probe.status ?? "不可达"}`) + suffix;
    }
    return failCount > 0 ? `连续失败 ${failCount} 次` : "未探测";
  }

  function Row({ url, badge, actions, plain, isProbing }: { url: string; badge?: string; actions?: React.ReactNode; plain?: boolean; isProbing?: boolean }) {
    const probe = probeOf(url);
    const active = !plain && currentUrl === url;
    const tone = isProbing ? "loading" : probe ? (probe.ok ? "ready" : "failed") : (Number(fails[url]) > 0 ? "failed" : "unloaded");
    const statusText = isProbing ? "探测中…" : healthText(url, probe);
    const tag = tags[url] || "";
    const editingTag = tagEdit === url;
    /* Single-line design (mirrors the clean publish-page rows): a semantic
     * status dot, the url as the row's subject, then optional tag / badges.
     * Full status text lives in the long-press tag editor, not on the row. */
    const body = <>
      {!plain && <span className={`line-status ${tone}`} aria-label={statusText}>
        <span className="line-status-dot" />
      </span>}
      <span className="line-url">{url}</span>
      {tag && <span className="line-tag">{tag}</span>}
      {badge && <span className="line-badge">{badge}</span>}
    </>;
    const openTagEditor = (e: { preventDefault: () => void }) => {
      e.preventDefault();
      setTagEdit(url); setTagDraft(tag);
    };
    return <li className="line-row">
      {editingTag ? <div className="line-tag-form">
        <input aria-label="线路标签" placeholder="标签（留空并保存即删除）" maxLength={TAG_MAX_LEN}
          value={tagDraft} autoFocus onChange={e => setTagDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { saveTag(url, tagDraft); setTagEdit(null); } }} />
        <button className="line-btn line-btn-primary pressable" disabled={busy} onClick={() => { saveTag(url, tagDraft); setTagEdit(null); }}><ICheck size={14}/>保存</button>
        <button className="line-btn line-btn-secondary pressable" disabled={busy} onClick={() => setTagEdit(null)}><IClose size={14}/>取消</button>
        <small className="line-tag-status">{plain ? url : statusText}</small>
      </div>
      : <>
        {plain
          ? <span className="line-main">{body}</span>
          : <button className="line-main pressable" aria-pressed={active} aria-label={`切换线路 ${url}${tag ? ` · ${tag}` : ""}`}
              onClick={() => void switchLine(url)} onContextMenu={openTagEditor}>{body}</button>}
        {active && <span className="line-current">当前</span>}
        {actions && <span className="line-actions">{actions}</span>}
      </>}
    </li>;
  }

  /* Long-press (mobile) / right-click (desktop) hint chip. */
  const tagHint = <p className="line-note">长按或右键线路卡片可为网址添加自定义标签</p>;

  const editButton = (onEdit: () => void) => <button className="line-btn pressable" aria-label="编辑线路" disabled={busy} onClick={onEdit}>编辑</button>;
  const deleteButton = (onDelete: () => void, label: string) => <button className="line-btn line-btn-danger pressable" aria-label={label} disabled={busy} onClick={onDelete}><ITrash size={13} /></button>;
  const probeButton = (url: string) => <button className="line-btn line-btn-secondary pressable" aria-label="探测该线路" disabled={busy || !!probing[url]} onClick={() => void probeOne(url)}><IRefresh size={13}/>探测</button>;

  return <div className="hpp-lines-panel">
    {error && <p role="alert" className="hpp-error">{error}<button className="line-inline-action pressable" onClick={() => void loadState()}>重试</button></p>}

    {!loaded && !error && <div className="hpp-skeleton" aria-label="正在加载线路状态" />}

    {loaded && state && <div className="line-current-head">
      <span>当前线路</span>
      <strong>{(currentUrl || "").replace(/^https:\/\//, "").replace(/\/+$/, "") || "未选择"}</strong>
    </div>}

    <div className="line-setting">
      <label htmlFor={`auto-line-${plugin.meta.id}`}>自动选择线路<small>故障时在镜像线路间自动切换；手动点选线路后可随时再次自动优选</small></label>
      <input id={`auto-line-${plugin.meta.id}`} type="checkbox" disabled={busy} checked={!!state?.auto}
        onChange={e => void run("call", { method: "lines.autoSet", args: { on: e.target.checked } })} />
    </div>

    <div className="line-toolbar">
      <button className="line-btn line-btn-secondary pressable" disabled={busy} onClick={() => void probeAll([...(state?.fixed || []).map(f => f.url), ...(state?.mirrors || []).map(m => m.url), ...(state?.custom || []).map(c => c.url)])}><IRefresh size={14}/>探测全部</button>
      <button className="line-btn line-btn-primary pressable" disabled={busy} onClick={autoPick}>自动优选线路</button>
      <button className="line-btn line-btn-secondary pressable" disabled={busy} onClick={refreshMirrors}>刷新镜像</button>
      <button className="line-btn line-btn-ghost-danger pressable" disabled={busy} onClick={() => void run("call", { method: "lines.reset", args: {} })}><IRotate size={14}/>恢复默认</button>
    </div>
    {mirrorError && <p className="line-note line-note-error">{mirrorError}</p>}
    {pick && pick.base && <p className="line-note">已优选 {pick.tier === "main" ? "固定线路" : "镜像线路"} · {pick.ms} ms{pick.reason === "mirror-ok" ? "（镜像可用）" : ""}</p>}
    {pick && !pick.base && <p className="line-note line-note-error">全部线路不可用 <button className="line-inline-action pressable" onClick={autoPick} disabled={busy}>重试</button></p>}

    {loaded && state && <>
      <section className="line-group">
        <header className="line-group-head">
          <h3>固定线路</h3><small>优先直连，可自行增删改</small>
        </header>
        <ul className="line-list">
          {state.fixed.map(f => <Row key={f.url} url={f.url} isProbing={!!probing[f.url]}
            actions={<>{probeButton(f.url)}{editButton(() => startEditFixed(f))}{deleteButton(() => void removeFixed(f.url), "删除固定线路")}</>} />)}
          {!state.fixed.length && <li className="line-empty">暂无固定线路，可在下方添加</li>}
        </ul>
        {editing?.group === "fixed" ? <div className="line-form">
          <input aria-label="线路地址" value={editUrl} onChange={e => setEditUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void saveEditFixed(); }} />
          <button className="line-btn line-btn-primary pressable" disabled={busy} onClick={saveEditFixed}><ICheck size={14}/>保存</button>
          <button className="line-btn line-btn-secondary pressable" disabled={busy} onClick={cancelEdit}><IClose size={14}/>取消</button>
        </div> : <div className="line-form">
          <input aria-label="新增固定线路地址" placeholder="https://example.com" value={fixedUrl} onChange={e => setFixedUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void submitFixed(); }} />
          <button className="line-btn line-btn-secondary pressable" disabled={busy || !normalize(fixedUrl)} onClick={submitFixed}><IPlus size={14}/>添加</button>
        </div>}
        {fixedError && <p role="alert" className="hpp-error line-form-error">{fixedError}</p>}
      </section>

      <section className="line-group">
        <header className="line-group-head">
          <h3>镜像线路</h3><small>来自地址发布页，通常直连、仅游客浏览；可手动补充信任地址</small>
          <span className="line-group-actions">
            <button className="line-inline-action pressable" disabled={busy} onClick={() => void probeAll(state.mirrors.map(m => m.url))}>全部检测（{state.mirrors.length}）</button>
          </span>
        </header>
        <ul className="line-list">
          {state.mirrors.map(m => <Row key={m.url} url={m.url} badge={m.manual ? "手动" : undefined}
            actions={m.manual ? deleteButton(() => void removeMirror(m.url), "删除镜像线路") : undefined} />)}
          {!state.mirrors.length && <li className="line-empty">地址发布页里没有可用的镜像地址，可手动添加</li>}
        </ul>
        <div className="line-form">
          <input aria-label="新增镜像线路地址" placeholder="https://mirror.example.com" value={mirrorUrl} onChange={e => setMirrorUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void submitMirror(); }} />
          <button className="line-btn line-btn-secondary pressable" disabled={busy || !normalize(mirrorUrl)} onClick={submitMirror}><IPlus size={14}/>添加</button>
        </div>
        {mirrorAddError && <p role="alert" className="hpp-error line-form-error">{mirrorAddError}</p>}
      </section>

      <section className="line-group">
        <header className="line-group-head">
          <h3>地址发布页</h3><small>公布镜像线路的页面，可自行增删；脚本按文本保守解析，不执行远端 JS</small>
          {state?.pagesAt && <small>上次刷新 {new Date(state.pagesAt).toLocaleString()}</small>}
        </header>
        <ul className="line-list">
          {(state?.pages || []).map(p => <Row key={p} url={p} plain
            actions={deleteButton(() => void removePage(p), "删除发布页")} />)}
          {!state?.pages?.length && <li className="line-empty">暂无发布页，使用内置默认页</li>}
        </ul>
        <div className="line-form">
          <input aria-label="新增地址发布页" placeholder="https://publish.example.com/" value={pageUrl} onChange={e => setPageUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void submitPage(); }} />
          <button className="line-btn line-btn-secondary pressable" disabled={busy || !normalize(pageUrl)} onClick={submitPage}><IPlus size={14}/>添加</button>
        </div>
        {pageError && <p role="alert" className="hpp-error line-form-error">{pageError}</p>}
      </section>

      <section className="line-group">
        <header className="line-group-head">
          <h3>自定义线路</h3><small>手动添加的直连地址，仅保存在本机；通常仅游客浏览，切换到其他站点后需重新登录</small>
        </header>
        <ul className="line-list">
          {state.custom.map(c => <Row key={c.url} url={c.url} isProbing={!!probing[c.url]}
            actions={<>{probeButton(c.url)}{editButton(() => startEditCustom(c))}{deleteButton(() => void removeCustom(c.url), "删除自定义线路")}</>} />)}
          {!state.custom.length && <li className="line-empty">暂无自定义线路</li>}
        </ul>
        {editing?.group === "custom" ? <div className="line-form">
          <input aria-label="编辑自定义线路地址" value={editUrl} onChange={e => setEditUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void saveEditCustom(); }} />
          <button className="line-btn line-btn-primary pressable" disabled={busy} onClick={saveEditCustom}><ICheck size={14}/>保存</button>
          <button className="line-btn line-btn-secondary pressable" disabled={busy} onClick={cancelEdit}><IClose size={14}/>取消</button>
        </div> : <div className="line-form">
          <input aria-label="自定义线路地址" placeholder="https://example.com" value={customUrl} onChange={e => setCustomUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void submitCustom(); }} />
          <button className="line-btn line-btn-secondary pressable" disabled={busy || !normalize(customUrl)} onClick={submitCustom}><IPlus size={14}/>添加</button>
        </div>}
        {customError && <p role="alert" className="hpp-error line-form-error">{customError}</p>}
      </section>
    </>}
    {tagHint}
  </div>;
}
