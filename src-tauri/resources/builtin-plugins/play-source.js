// Built-in play-source plugin (HGhubX line + content provider).
//
// Runs inside the hpp QuickJS sandbox: every network call goes through
// hg.http.fetch -> the plugin's controlled Network (policy, cookie jar, proxy,
// redirect checks). No DOM, no direct fs, no bare fetch.
//
// Standard namespace methods map upstream data onto the hpp protocol model so
// the ground renderers (home / search / catalog / detail / playback) work
// unchanged. Extension methods expose the HGhubX view model for the alternate
// HGhubX renderer.

export const meta = {
  id: "play-source",
  name: "播放源",
  version: "1.0.0",
  protocol: 1,
  kind: "source",
  description: "HGhubX 播放源：固定线路、发布页镜像与自定义线路；首页与分类启动方案独立选择。",
  matches: ["huangguoai.com", "huangguoai.pages.dev", "huang-guo.pages.dev"],
  requires: [
    { type: "api", name: "http.fetch" },
    { type: "api", name: "storage.get" },
    { type: "api", name: "storage.set" },
    { type: "api", name: "storage.delete" },
    { type: "api", name: "storage.keys" },
    { type: "api", name: "html.parse" },
    { type: "api", name: "cookies.get" },
    { type: "api", name: "cookies.set" },
    { type: "api", name: "codec.base64Encode" },
    { type: "api", name: "codec.utf8Encode" }
  ],
  settings: [
    {
      key: "homeMode",
      type: "select",
      label: "首页启动方案",
      options: [
        { value: "default", label: "默认方案" },
        { value: "hghubx", label: "HGhubX方案" },
        { value: "hgsky", label: "HGsky方案" }
      ],
      default: "default"
    },
    {
      key: "categoryMode",
      type: "select",
      label: "分类启动方案",
      options: [
        { value: "default", label: "默认方案" },
        { value: "hghubx", label: "HGhubX方案" }
      ],
      default: "default"
    },
    { key: "autoLine", type: "switch", label: "自动选择线路", default: true }
  ],
  extensions: [
    "articles.list", "articles.getDetail",
    "lines.state", "lines.list", "lines.mirrors", "lines.probe", "lines.set",
    "lines.addCustom", "lines.updateCustom", "lines.removeCustom",
    "lines.addFixed", "lines.updateFixed", "lines.removeFixed",
    "lines.addMirror", "lines.removeMirror",
    "lines.addPublishPage", "lines.removePublishPage", "lines.reset",
    "lines.autoSet", "lines.autoPick", "lines.health",
    "skyhome.feed",
    "xhome.feed", "xhome.rank",
    "xsearch.search", "xsearch.hot",
    "xcategory.categories", "xcategory.list", "xcategory.original",
    "xdiscover.topics", "xdiscover.tags", "xdiscover.topic", "xdiscover.tagVideos",
    "xdiscover.posts", "xdiscover.postCategory", "xdiscover.post", "xdiscover.postPlayback",
    "xvideo.related"
  ]
};

const DEFAULT_FIXED = [{ label: "固定线路 1", url: "https://huangguoai.com" }];
// The host API is injected by the factory; module-level helpers close over it.
let hg;
const DEFAULT_PUBLISH_PAGES = [
  "https://huangguoai.pages.dev/",
  "https://huang-guo.pages.dev/",
];
const PROBE_PATH = "/api/videos?page=1&size=1";
const PROBE_TIMEOUT_MS = 6000;
// One probe call must stay inside the runtime's "read" budget (15s default):
// the plugin-wide network gate allows ~6 concurrent requests, so a 12-item
// batch × 6s worst-case fits. Callers can probe longer lists in chunks.
const PROBE_BATCH_MAX = 12;
const MIRROR_MAX = 60;
const PUBLISH_ARRAY_MAX = 256;
const PUBLISH_PAGE_TIMEOUT_MS = 8000;
const PUBLISH_MAX_BYTES = 512 * 1024;

const STORAGE = {
  current: "ps.line.current",
  fixed: "ps.line.fixed",
  custom: "ps.line.custom",
  mirrors: "ps.line.mirrors",
  trusted: "ps.line.trusted",
  auto: "ps.line.auto",
  fails: "ps.line.fails",
  pages: "ps.line.pages",
  pagesAt: "ps.line.pagesAt",
};

function fixedUrl() {
  return DEFAULT_FIXED[0].url;
}

function cleanLabel(raw, origin) {
  const label = String(raw || "").trim().slice(0, 24);
  return label || hostOf(origin);
}

/** Domains that only serve a navigation/landing page: adding them is allowed,
 *  but the probe surfaces a navigation-page hint instead of a generic timeout. */
const NAVIGATION_HOSTS = new Set(["huangguoai.ai"]);

function validationFailure(code, message) {
  return { ok: false, code, message };
}

/**
 * Authoritative line-origin validator (plugin side).
 *
 * Rules:
 *  - scheme must be HTTPS (http is rejected; no userinfo);
 *  - IP literals, localhost and reserved internal suffixes are rejected;
 *  - non-default ports 1–65535 are allowed (HTTPS is still enforced);
 *  - IDN hostnames are normalized to punycode by the runtime URL parser; the
 *    original typed host is kept in `display` for presentation;
 *  - a path prefix is preserved on the canonical base so later edge/probe
 *    requests keep it; dedup compares the full protocol+host+port+path base.
 */
function validateOrigin(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return validationFailure("EMPTY", "请输入线路地址");
  let u;
  try {
    u = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ? s : "https://" + s);
  } catch (_e) {
    return validationFailure("INVALID", "地址不合法");
  }
  if (u.protocol !== "https:") return validationFailure("SCHEME", "仅支持 HTTPS 线路");
  if (u.username || u.password) return validationFailure("CREDENTIALS", "地址不能包含账号密码");
  const host = (u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return validationFailure("INVALID", "地址不合法");
  if (
    host === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":") ||
    host.endsWith(".localhost") ||
    /\.(local|internal|home\.arpa)$/.test(host)
  ) {
    return validationFailure("PRIVATE", "不允许内网、IP 或 localhost 线路");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host) || host.length > 253) {
    return validationFailure("HOST", "域名不合法");
  }
  const labels = host.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return validationFailure("HOST", "域名不合法");
  const portRaw = u.port || "443";
  const portNum = Number(portRaw);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return validationFailure("PORT", "端口不合法（1–65535）");
  }
  const path = (u.pathname || "").replace(/\/+$/g, "");
  const url = "https://" + host + (portNum === 443 ? "" : ":" + portNum) + path;
  return { ok: true, url, host, port: portNum, path, display: hostOfDisplay(s) };
}

function hostOfDisplay(raw) {
  const s = String(raw || "").trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const at = s.indexOf("@");
  if (at >= 0) return s.slice(at + 1).split("/")[0];
  return s.split("/")[0].split("?")[0].replace(/:$/, "");
}

/** Boolean legacy wrapper: canonical HTTPS base or null when invalid. */
function normalizeOrigin(raw) {
  const v = validateOrigin(raw);
  return v.ok ? v.url : null;
}

function hostOf(origin) {
  return String(origin || "").replace(/^https:\/\//, "").replace(/\/+$/, "");
}

/** Join a base that may carry a path prefix with an API path. */
function baseJoin(base, path) {
  return base.replace(/\/+$/g, "") + path;
}

/* ── storage helpers ─────────────────────────────────────────────────── */

async function storageGet(key, fallback) {
  const value = await hg.storage.get(key);
  return value === undefined || value === null ? fallback : value;
}
async function storageSet(key, value) {
  await hg.storage.set(key, value);
}

/* ── edge envelope ──────────────────────────────────────────────────── */

/** Call a line's REST API directly. Upstream retired its `/api/edge/request`
 * relay ("接口已停用"); the site now serves the same `{status,msg,data}`
 * envelope on the plain REST routes. */
async function edgeAt(origin, method, path, body, timeoutMs) {
  const checked = validateOrigin(origin);
  if (!checked.ok) throw new hg.PluginError("INVALID_ARGUMENT", checked.message);
  const base = checked.url;
  const request = {
    method,
    url: baseJoin(base, path),
    headers: { Accept: "application/json", Referer: base + "/" },
    credentials: "include",
    responseType: "json",
  };
  if (timeoutMs) request.timeoutMs = timeoutMs;
  if (body !== undefined && body !== null) {
    request.headers["Content-Type"] = "application/json";
    request.body = { json: body };
  }
  const resp = await hg.http.fetch(request);
  const env = resp && resp.data;
  if (!env || typeof env !== "object") {
    throw new hg.PluginError("NETWORK", "响应信封无效");
  }
  if (env.status === 1 || env.status === 200) return env.data === undefined ? null : env.data;
  throw new hg.PluginError("UPSTREAM_ERROR", env.msg || "接口返回失败");
}

async function edge(method, path, body) {
  return edgeAt(currentOrigin(), method, path, body);
}

function currentOrigin() {
  const endpoint = hg.endpoint && hg.endpoint.current;
  const candidate = endpoint && endpoint.url ? endpoint.url : fixedUrl();
  return normalizeOrigin(candidate) || fixedUrl();
}

/* ── cover proxy reference ────────────────────────────────────────────
 * Upstream serves covers as AES-128-CBC ciphertext at the CDN and proxies
 * them through the host local route (media/image.rs:10-11, 107-112). Here
 * every cover is returned as a ResourceRef: the fetch still goes through the
 * plugin's controlled Network, and the host image proxy decrypts (skipping
 * plain images after magic detection) and delivers on the loopback route.
 * The fixed key/IV mirror the upstream raw ASCII bytes, base64-encoded. */

const COVER_KEY_B64 = "ZjVkOTY1ZGY3NTMzNjI3MA==";
const COVER_IV_B64 = "OTdiNjAzOTRhYmMyZmJlMQ==";

function coverRef(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  let value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith("//")) value = "https:" + value;
  else if (value.startsWith("/")) value = currentOrigin() + value;
  if (!/^https:\/\//i.test(value)) return undefined;
  let absolute = value;
  try {
    absolute = new URL(value, currentOrigin()).href;
  } catch (_e) {
    return undefined;
  }
  return {
    url: absolute,
    headers: { Referer: currentOrigin() + "/" },
    transform: { type: "aes-cbc", key: COVER_KEY_B64, iv: COVER_IV_B64, padding: "pkcs7" },
  };
}

function normalizeCover(item) {
  if (item && typeof item === "object") {
    const ref = coverRef(item.cover);
    if (ref) item.cover = ref;
    else delete item.cover;
  }
  return item;
}

function normalizePaged(paged) {
  if (paged && Array.isArray(paged.items)) paged.items = paged.items.map(normalizeCover);
  return paged;
}

function normalizeList(items) {
  return Array.isArray(items) ? items.map(normalizeCover) : items;
}

/* ── health / probe ────────────────────────────────────────────────── */

function healthyVideos(data) {
  if (!data || !Array.isArray(data.items) || !data.pagination) return false;
  const p = data.pagination;
  const num = (v) => Number(v);
  if (!Number.isFinite(num(p.page)) || num(p.page) === 0) return false;
  if (!Number.isFinite(num(p.size)) || num(p.size) === 0) return false;
  if (!Number.isFinite(num(p.pages)) || !Number.isFinite(num(p.total))) return false;
  return data.items.every((item) => {
    return (
      Number(item && item.id) > 0 &&
      typeof (item && item.title) === "string" &&
      item.title.trim().length > 0
    );
  });
}

async function loadFails() {
  const value = await storageGet(STORAGE.fails, {});
  return value && typeof value === "object" ? value : {};
}

/** Persist per-line failure counters: a success resets the count to 0, a
 *  failure increments it. The panel surfaces this next to the probe latency. */
async function noteProbeResult(origin, ok) {
  if (!origin) return;
  const fails = await loadFails();
  if (ok) {
    if (fails[origin] !== undefined) {
      delete fails[origin];
      await storageSet(STORAGE.fails, fails);
    }
  } else {
    fails[origin] = Number(fails[origin]) || 0;
    fails[origin] += 1;
    await storageSet(STORAGE.fails, fails);
  }
}

async function probeOrigin(origin, tier) {
  const started = Date.now();
  const checked = validateOrigin(origin);
  if (!checked.ok) {
    return { tier: tier || "mirror", url: origin, ok: false, reachable: false, ms: 0, status: null, at: started, error: checked.message };
  }
  const base = checked.url;
  try {
    const data = await edgeAt(base, "GET", PROBE_PATH, null, PROBE_TIMEOUT_MS);
    const ok = healthyVideos(data);
    await noteProbeResult(base, ok);
    const navHint = NAVIGATION_HOSTS.has(checked.host) ? "（该域为导航页，非线路端点）" : "";
    return {
      tier: tier || "mirror",
      url: base,
      ok,
      reachable: true,
      ms: Date.now() - started,
      status: 200,
      at: Date.now(),
      error: ok ? null : "接口未返回有效视频列表数据" + navHint,
    };
  } catch (e) {
    await noteProbeResult(base, false);
    const navHint = NAVIGATION_HOSTS.has(checked.host) ? "（该域为导航页，非线路端点）" : "";
    return {
      tier: tier || "mirror",
      url: base,
      ok: false,
      reachable: false,
      ms: Date.now() - started,
      status: null,
      at: Date.now(),
      error: (e && e.message ? e.message : String(e)) + navHint,
    };
  }
}

/* ── publish-page mirrors (JS-as-data; remote JS never executed) ────── */

function stripComments(js) {
  let out = "";
  let i = 0;
  while (i < js.length) {
    if (js[i] === "/" && js[i + 1] === "/") {
      while (i < js.length && js[i] !== "\n") i++;
      continue;
    }
    if (js[i] === "/" && js[i + 1] === "*") {
      i += 2;
      while (i < js.length && !(js[i] === "*" && js[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (js[i] === '"' || js[i] === "'" || js[i] === "`") {
      const q = js[i];
      out += q;
      i++;
      while (i < js.length && js[i] !== q) {
        if (js[i] === "\\") { out += js[i]; i++; }
        out += js[i];
        i++;
      }
      if (i < js.length) { out += js[i]; i++; }
      continue;
    }
    out += js[i];
    i++;
  }
  return out;
}

function readArray(js, name) {
  // `var urls=[` / `const urls = [` on their own line; whitespace around `=` is optional.
  const needle = new RegExp("(?:^|[\\s;])" + name + "\\s*=\\s*\\[");
  const at = needle.exec(js);
  if (!at) return [];
  let i = at.index + at[0].length;
  const values = [];
  while (i < js.length && js[i] !== "]") {
    while (i < js.length && /\s/.test(js[i])) i++;
    if (js[i] === ",") { i++; continue; }
    if (js[i] === "]") break;
    const q = js[i];
    if (q !== '"' && q !== "'") {
      // Non-literal element (identifier, expression): skip up to the next separator.
      while (i < js.length && js[i] !== "," && js[i] !== "]") i++;
      continue;
    }
    i++;
    let raw = "";
    while (i < js.length && js[i] !== q) {
      if (js[i] === "\\") { raw += js[i]; i++; }
      raw += js[i];
      i++;
    }
    if (i < js.length) i++;
    values.push(raw);
    while (i < js.length && /\s/.test(js[i])) i++;
    if (js[i] === ",") i++;
  }
  return values;
}

function readArrayBounded(js, name) {
  const values = readArray(js, name);
  if (values.length > PUBLISH_ARRAY_MAX) return { truncated: true, values: values.slice(0, PUBLISH_ARRAY_MAX) };
  return { truncated: false, values };
}

function parsePublishJs(js) {
  const clean = stripComments(js);
  const domains = readArrayBounded(clean, "urls").values;
  const subs = readArrayBounded(clean, "subdomains").values;
  // Permanent addresses the page lists verbatim (no subdomain prefix).
  const forever = readArrayBounded(clean, "foreverUrls").values;
  if (!domains.length && !forever.length) throw new hg.PluginError("UPSTREAM_ERROR", "发布页格式变化：未找到镜像域名数组");
  const items = [];
  const seen = new Set();
  const push = (host) => {
    const origin = normalizeOrigin(host);
    if (!origin) return;
    if (!seen.has(origin)) {
      seen.add(origin);
      items.push({ url: origin, host: hostOf(origin) });
    }
  };
  for (const domain of domains) {
    const d = String(domain).trim().replace(/\/+$/, "").toLowerCase();
    if (subs.length) {
      for (const sub of subs) {
        const s = String(sub).trim().toLowerCase();
        if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s)) push(s + "." + d);
      }
    } else {
      push(d);
    }
    if (items.length >= MIRROR_MAX) break;
  }
  for (const url of forever) {
    push(String(url));
    if (items.length >= MIRROR_MAX) break;
  }
  if (!items.length) throw new hg.PluginError("UPSTREAM_ERROR", "发布页没有可识别的合法镜像地址");
  return items;
}

async function getPublishText(url) {
  const resp = await hg.http.fetch({
    method: "GET",
    url,
    credentials: "omit",
    responseType: "text",
    timeoutMs: PUBLISH_PAGE_TIMEOUT_MS,
    maxBytes: PUBLISH_MAX_BYTES,
  });
  if (resp && resp.status && resp.status >= 400) {
    throw new hg.PluginError("UPSTREAM_ERROR", "HTTP " + resp.status);
  }
  return resp && resp.data ? String(resp.data) : "";
}

function resolveScript(page, html) {
  const doc = hg.html.parse(html || "");
  const scripts = doc.select("script[src]").map((n) => n.attr("src")).filter(Boolean);
  const src = scripts.find((s) => /(^|\/)publish\.js(\?|#|$)/i.test(s));
  if (!src) throw new hg.PluginError("UPSTREAM_ERROR", "未找到同源 publish.js 发布脚本");
  let jsUrl;
  try {
    jsUrl = new URL(src, page);
  } catch (_e) {
    throw new hg.PluginError("UPSTREAM_ERROR", "发布脚本地址无效");
  }
  if (jsUrl.username || jsUrl.password) {
    throw new hg.PluginError("UPSTREAM_ERROR", "发布脚本地址不能包含账号密码");
  }
  if (jsUrl.protocol !== "https:" || jsUrl.origin !== new URL(page).origin) {
    throw new hg.PluginError("UPSTREAM_ERROR", "发布脚本非同源 HTTPS，已拒绝");
  }
  const base = jsUrl.pathname.split("/").pop() || "";
  if (!/^publish\.js$/i.test(base)) {
    throw new hg.PluginError("UPSTREAM_ERROR", "只接受发布页同源的 publish.js 脚本");
  }
  jsUrl.hash = "";
  return jsUrl.href;
}

/** Persisted publish-page list; invalid entries are dropped and the list
 *  falls back to the shipped defaults when empty. */
async function loadPublishPages() {
  const stored = await storageGet(STORAGE.pages, null);
  if (!Array.isArray(stored)) return DEFAULT_PUBLISH_PAGES.slice();
  const pages = stored
    .map((p) => (typeof p === "string" ? p : p && p.url))
    .filter(Boolean)
    .map((p) => {
      const v = validateOrigin(p);
      return v.ok ? v.url : null;
    })
    .filter(Boolean);
  return pages.length ? pages : DEFAULT_PUBLISH_PAGES.slice();
}

async function fetchOnePublishPage(page) {
  try {
    const html = await getPublishText(page);
    const jsUrl = resolveScript(page, html);
    const js = await getPublishText(jsUrl);
    return { source: page, items: parsePublishJs(js), error: null };
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    const error = /网络|超时|连接|DNS|断开|refused|resolve/i.test(detail)
      ? "网络失败：" + detail
      : detail;
    return { source: page, items: [], error };
  }
}

async function fetchPublishMirrors(pages) {
  const list = pages || (await loadPublishPages());
  const results = await Promise.all(list.map((page) => fetchOnePublishPage(page)));
  const merged = [];
  const seen = new Set();
  const errors = [];
  const max = Math.max(...results.map((p) => p.items.length), 0);
  // Interleave pages so a long first list cannot hide a second publisher.
  for (let i = 0; i < max; i++) {
    for (const page of results) {
      const item = page.items[i];
      if (item && !seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
      }
    }
  }
  for (const page of results) {
    if (page.error) errors.push(page.source + ": " + page.error);
  }
  return { items: merged, errors };
}

async function loadMirrorsCached() {
  return storageGet(STORAGE.mirrors, []);
}

/** Origins already owned by the fixed/custom groups. Auto-discovered mirrors
 *  that duplicate them are not stored again, so a single origin never appears
 *  in two groups and the UI keeps exactly one "当前" badge. */
async function reservedOrigins() {
  const fixed = (await loadFixed()).map((f) => f.url);
  const custom = (await loadCustomLines()).map((c) => c.url);
  return new Set(fixed.concat(custom));
}

/** Merge freshly published mirrors with the manually kept ones, dropping
 *  duplicates and origins reserved by the fixed/custom groups. */
async function mergeMirrors(published) {
  const reserved = await reservedOrigins();
  const existing = await loadMirrorsCached();
  const manual = existing.filter((m) => m.manual);
  const auto = published.filter((p) => !reserved.has(p.url));
  const merged = [...manual, ...auto.filter((p) => !manual.some((m) => m.url === p.url))];
  return { merged, auto };
}

/** Persisted fixed-line list; invalid origins are dropped and the list falls
 *  back to the shipped defaults when the stored list is empty. */
async function loadFixed() {
  const stored = await storageGet(STORAGE.fixed, null);
  if (!Array.isArray(stored)) return DEFAULT_FIXED.map((f) => ({ ...f }));
  const items = stored
    .map((f) => {
      const v = validateOrigin(f && f.url);
      if (!v.ok) return null;
      return { label: cleanLabel(f && f.label, v.url), url: v.url, host: v.display || v.host };
    })
    .filter(Boolean);
  return items.length ? items : DEFAULT_FIXED.map((f) => ({ ...f }));
}

function requireOrigin(args, field) {
  const v = validateOrigin(args && args[field]);
  if (!v.ok) throw new hg.PluginError("INVALID_ARGUMENT", v.message);
  return v;
}

/* ── line state ────────────────────────────────────────────────────── */

/** Custom lines carry an optional user label (parity with fixed lines).
 *  Legacy string entries are migrated to { url, label } on read. */
async function loadCustomLines() {
  const stored = await storageGet(STORAGE.custom, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .map((c) => {
      const raw = typeof c === "string" ? c : c && c.url;
      const v = validateOrigin(raw);
      if (!v.ok) return null;
      return { url: v.url, label: cleanLabel(typeof c === "object" && c ? c.label : "", v.url), host: v.display || v.host };
    })
    .filter(Boolean);
}
async function loadTrusted() {
  return storageGet(STORAGE.trusted, []);
}

/** Attach a stable, group-scoped id to each line entry. Ids stay unique across
 *  groups because every prefix differs (fixed/mirror/custom). */
function withIds(fixed, mirrors, custom) {
  return {
    fixed: fixed.map((f, i) => ({ id: "fixed:" + i, ...f })),
    mirrors: mirrors.map((m) => ({ id: "mirror:" + m.host, ...m })),
    custom: custom.map((c) => ({ id: "custom:" + hostOf(c.url), ...c })),
  };
}

/** Flat, host-facing endpoint list. The runtime's endpoints.list validation
 *  requires a unique id AND a unique origin, so an origin that appears in more
 *  than one group is reported once (fixed wins, then mirror, then custom). The
 *  three groups stay fully independent in the UI; this dedup only shapes the
 *  single selected line that is reported to the 播放源 section. */
function flatEndpoints(fixed, mirrors, custom) {
  const { fixed: f, mirrors: m, custom: c } = withIds(fixed, mirrors, custom);
  const entries = [
    ...f.map((x) => ({ id: x.id, label: x.label, url: x.url })),
    ...m.map((x) => ({ id: x.id, label: x.host, url: x.url })),
    ...c.map((x) => ({ id: x.id, label: x.label, url: x.url })),
  ];
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = normalizeOrigin(e.url) || e.url;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

async function lineEntries() {
  const fixed = await loadFixed();
  const mirrors = await loadMirrorsCached();
  const custom = await loadCustomLines();
  return withIds(fixed, mirrors, custom);
}

async function currentLineState() {
  const { fixed, mirrors, custom } = await lineEntries();
  const cur = hg.endpoint && hg.endpoint.current;
  return {
    base: currentOrigin(),
    current: { id: (cur && cur.id) || null, url: currentOrigin() },
    fixed,
    mirrors,
    custom,
    pages: await loadPublishPages(),
    pagesAt: await storageGet(STORAGE.pagesAt, null),
    auto: (await storageGet(STORAGE.auto, true)) !== false,
    fails: await loadFails(),
    endpoints: flatEndpoints(fixed, mirrors, custom),
  };
}

/* ── upstream data → protocol model ────────────────────────────────── */

function toCard(v) {
  if (!v || v.id === undefined) return null;
  const stats = {};
  if (Number.isFinite(Number(v.hot))) stats.hot = Number(v.hot);
  if (Number.isFinite(Number(v.like_count))) stats.likes = Number(v.like_count);
  if (Number.isFinite(Number(v.collect_count))) stats.favorites = Number(v.collect_count);
  if (Number.isFinite(Number(v.comment_count))) stats.comments = Number(v.comment_count);
  return {
    id: String(v.id),
    title: v.title || "未命名",
    type: v.is_original ? "series" : "short",
    cover: coverRef(v.cover),
    description: v.description || undefined,
    tags: Array.isArray(v.tags) ? v.tags : [],
    score: typeof v.score === "number" && Number.isFinite(v.score) ? v.score : undefined,
    episodeCount: v.episode_count || undefined,
    totalEpisodes: v.total_episodes || undefined,
    status: v.is_finished ? "finished" : "ongoing",
    stats,
    author: v.author ? { id: String(v.author.id || 0), name: v.author.name || "作者" } : undefined,
    publishedAt: v.created_at ? Date.parse(v.created_at) || undefined : undefined,
  };
}

function pageFromPaged(paged, limit) {
  const items = Array.isArray(paged && paged.items) ? paged.items.map(toCard).filter(Boolean) : [];
  const pagination = paged && paged.pagination;
  const page = Number(pagination && pagination.page) || 1;
  const pages = Number(pagination && pagination.pages) || 1;
  const next = items.length > 0 && page < pages ? String(page + 1) : null;
  return { items, next, total: pagination && pagination.total };
}

function toDetail(d) {
  if (!d) throw new hg.PluginError("NOT_FOUND", "作品不存在");
  const rawEps = Array.isArray(d.episodes) ? d.episodes : [];
  const episodes = rawEps.length
    ? rawEps.map((ep, i) => {
        const num = Number(ep.ep ?? ep.ep_num ?? i + 1);
        return {
          id: String(num),
          index: num,
          episodeNumber: num,
          title: ep.title || undefined,
          durationSec: ep.duration || undefined,
          locked: false,
        };
      })
    : [{ id: "1", index: 1, episodeNumber: 1, title: "正片", locked: false }];
  return {
    id: String(d.id),
    title: d.title || "未命名",
    cover: coverRef(d.cover),
    description: d.description || undefined,
    tags: Array.isArray(d.tags) ? d.tags : [],
    score: typeof d.score === "number" && Number.isFinite(d.score) ? d.score : undefined,
    episodeCount: d.episode_count || episodes.length,
    totalEpisodes: d.total_episodes || episodes.length,
    author: d.author ? { id: String(d.author.id || 0), name: d.author.name || "作者" } : undefined,
    playlists: [{ id: "main", label: "正片", kind: "main", episodes }],
    related: Array.isArray(d.related) ? d.related.map(toCard).filter(Boolean) : [],
  };
}

function playbackStreams(info) {
  const main = info && (info.video_url || (info.streams && info.streams.main));
  const hevc = info && (info.video_url_hevc || (info.streams && info.streams.hevc));
  const streams = [];
  const streamOf = (url, codec, label) => {
    if (!url || typeof url !== "string" || !url.trim()) return;
    streams.push({
      url,
      format: /\.m3u8(\?|$)/i.test(url) ? "hls" : "progressive",
      codec,
      label,
    });
  };
  streamOf(main, "h264", "主线路");
  if (hevc && hevc !== main) streamOf(hevc, "hevc", "HEVC");
  return streams;
}

async function resolvePlayback(mediaId, episodeId) {
  const ep = Number(episodeId) || 1;
  let info = null;
  try {
    info = await edge("POST", `/api/videos/${mediaId}/episodes/${ep}/playback`, {});
  } catch (_e) {
    info = null;
  }
  const streams = playbackStreams(info);
  if (!streams.length) {
    info = await edge("GET", `/api/videos/${mediaId}/play?ep=${ep}&page_texts=0`, null);
    const fallback = playbackStreams(info);
    if (!fallback.length) throw new hg.PluginError("UPSTREAM_ERROR", "未获取到可用播放地址");
    return { streams: fallback, durationSec: info && info.duration || undefined };
  }
  return { streams, durationSec: info && info.duration || undefined };
}

/* ── search hot (SSR scrape) ───────────────────────────────────────── */

async function fetchHot() {
  const resp = await hg.http.fetch({
    method: "GET",
    url: currentOrigin() + "/search/",
    headers: { Accept: "text/html,application/xhtml+xml", Referer: currentOrigin() + "/" },
    credentials: "omit",
    responseType: "text",
  });
  const doc = hg.html.parse(resp.data || "");
  const sections = doc.select("section.hg-search-hot");
  const items = [];
  const seen = new Set();
  for (const section of sections) {
    for (const anchor of section.select("a.hg-search-hot__item")) {
      const href = anchor.attr("href") || "";
      const match = /^\/video\/(\d+)\/?$/.exec(href);
      if (!match) continue;
      const id = Number(match[1]);
      if (id <= 0 || seen.has(id)) continue;
      const name = anchor.select(".hg-search-hot__name").map((n) => n.text()).join(" ").trim();
      const title = name || (anchor.attr("data-search-hot") || "").trim();
      const plays = anchor.select(".hg-search-hot__plays").map((n) => n.text()).join(" ").trim();
      if (!title) continue;
      seen.add(id);
      items.push({ videoId: id, title, plays });
      if (items.length >= 20) break;
    }
  }
  return items;
}

/* ── plugin factory ────────────────────────────────────────────────── */

export default function (provided) {
  hg = provided;
  return {
    // ── standard protocol: endpoints ──
    endpoints: {
      async list(args) {
        const refresh = !!(args && args.refresh);
        if (refresh) {
          const fresh = await fetchPublishMirrors();
          await storageSet(STORAGE.pagesAt, Date.now());
          if (fresh.items.length) {
            const { merged, auto } = await mergeMirrors(fresh.items);
            await storageSet(STORAGE.mirrors, merged);
            await storageSet(STORAGE.trusted, auto.map((m) => m.url));
          }
        }
        const { fixed, mirrors, custom } = await lineEntries();
        return flatEndpoints(fixed, mirrors, custom);
      },
    },

    // ── standard protocol: home ──
    home: {
      async getSections(args) {
        const limit = Math.min(40, Number(args && args.limit) || 20);
        const paged = await edge("GET", `/api/videos?page=1&size=${limit}`, null);
        const page = pageFromPaged(paged, limit);
        return {
          items: [
            { id: "latest", title: "最新影片", layout: "row", imageAspect: "portrait", items: page.items, more: !!page.next },
          ],
          next: page.next,
        };
      },
      async listSection(args) {
        const limit = Math.min(40, Number(args && args.limit) || 20);
        const pageNo = Number(args && args.cursor) || 1;
        const paged = await edge("GET", `/api/videos?page=${pageNo}&size=${limit}`, null);
        return pageFromPaged(paged, limit);
      },
    },

    // ── standard protocol: search ──
    search: {
      async search(args) {
        const q = encodeURIComponent(String((args && args.query) || ""));
        const pageNo = Number(args && args.cursor) || 1;
        const limit = Math.min(40, Number(args && args.limit) || 20);
        const paged = await edge("GET", `/api/search?q=${q}&page=${pageNo}&size=${limit}`, null);
        return pageFromPaged(paged, limit);
      },
      async suggest() {
        return [];
      },
      async trending() {
        try {
          const hot = await fetchHot();
          return hot.map((h) => h.title);
        } catch (_e) {
          return [];
        }
      },
    },

    // ── standard protocol: catalog ──
    catalog: {
      async getCategories() {
        const data = await edge("GET", "/api/tags", null);
        const groups = (data && Array.isArray(data.categories) ? data.categories : [])
          .map((group) => ({
            id: String(group.name || group.code || group.id || "group"),
            label: group.name || "标签",
            children: (Array.isArray(group.tags) ? group.tags : []).map((tag) => ({
              id: String(tag.slug || tag.name),
              label: tag.name,
            })),
          }))
          .filter((g) => g.children.length > 0);
        return groups;
      },
      async list(args) {
        const tag = String((args && args.categoryId) || "");
        const pageNo = Number(args && args.cursor) || 1;
        const limit = Math.min(40, Number(args && args.limit) || 20);
        const encoded = encodeURIComponent(tag);
        const paged = await edge("GET", `/api/videos/tag/${encoded}?page=${pageNo}&size=${limit}&sort=latest`, null);
        return pageFromPaged(paged, limit);
      },
    },

    // ── standard protocol: media ──
    media: {
      async getDetail(args) {
        const id = String((args && args.id) || "");
        const data = await edge("GET", `/api/videos/${id}`, null);
        return toDetail(data);
      },
      async resolvePlayback(args) {
        const mediaId = String((args && args.mediaId) || "");
        const episodeId = String((args && args.episodeId) || "");
        return resolvePlayback(mediaId, episodeId);
      },
    },

    // ── standard protocol: articles (HGhubX 帖子内联视频) ──
    // The host "article.prepare" flow resolves `articles.getDetail` and turns
    // the returned `streams` into a proxied playback session. Post videos come
    // from the dedicated /api/posts/{id}/playback endpoint (upstream
    // api_post_playback → { mode, videos: [{ index, url }] }), falling back to
    // the post detail's direct video_url (upstream legacy field). Segments map
    // 1:1 onto streams so the post page can switch parts and auto-advance.
    articles: {
      // Standard articles.list: the play source has no standalone 图文 channel,
      // but the sandbox requires both namespace methods once `articles` exists.
      // Posts are surfaced here as article items so the mapping is honest.
      async list(args) {
        const pageNo = Number(args && args.cursor) || 1;
        const limit = Math.min(40, Number(args && args.limit) || 20);
        const paged = await edge("GET", `/api/posts?page=${pageNo}&size=${limit}`, null);
        const items = (Array.isArray(paged && paged.items) ? paged.items : [])
          .map((p) => {
            if (!p || p.id === undefined || p.id === null) return null;
            const stats = {};
            if (Number.isFinite(Number(p.hot))) stats.hot = Number(p.hot);
            if (Number.isFinite(Number(p.like_count))) stats.likes = Number(p.like_count);
            if (Number.isFinite(Number(p.comment_count))) stats.comments = Number(p.comment_count);
            return {
              id: String(p.id),
              title: String(p.title || "未命名"),
              ...(p.desc ? { summary: String(p.desc) } : {}),
              ...(p.cover ? { cover: p.cover } : {}),
              ...(Array.isArray(p.tags) && p.tags.length ? { tags: p.tags.slice(0, 20).map((t) => String(t).slice(0, 30)) } : {}),
              ...(p.author ? { author: { id: String(p.author.id || 0), ...(p.author.name ? { name: String(p.author.name) } : {}) } } : {}),
              ...(Object.keys(stats).length ? { stats } : {}),
              ...(p.created_at && Number.isFinite(Date.parse(p.created_at)) ? { publishedAt: Date.parse(p.created_at) } : {}),
            };
          })
          .filter(Boolean);
        const pages = Number(paged && paged.pagination && paged.pagination.pages) || 1;
        const next = items.length && pageNo < pages ? String(pageNo + 1) : undefined;
        return { items, ...(next ? { next } : {}) };
      },
      async getDetail(args) {
        const id = String((args && args.id) || "");
        if (!id) throw new hg.PluginError("UPSTREAM_ERROR", "缺少帖子 ID");
        const encoded = encodeURIComponent(id);
        let urls = [];
        try {
          const pb = await edge("GET", `/api/posts/${encoded}/playback`, null);
          const list = Array.isArray(pb && pb.videos) ? pb.videos : [];
          urls = list
            .map((v) => v && v.url)
            .filter((u) => typeof u === "string" && u.trim())
            .map((u) => u.trim());
        } catch (_e) {
          urls = [];
        }
        if (!urls.length) {
          // Legacy fallback: the post detail itself may carry a direct link.
          const data = await edge("GET", `/api/posts/${encoded}`, null);
          const p = data && data.post ? data.post : data;
          const direct = p && (p.video_url || (Array.isArray(p.videos) && p.videos[0] && p.videos[0].url));
          if (typeof direct === "string" && direct.trim()) urls = [direct.trim()];
        }
        if (!urls.length) throw new hg.PluginError("UPSTREAM_ERROR", "该帖子没有可播放的视频");
        const multi = urls.length > 1;
        return {
          id,
          streams: urls.slice(0, 16).map((url, index) => ({
            url,
            format: /\.m3u8(\?|$)/i.test(url) ? "hls" : "progressive",
            ...(multi ? { label: `第 ${index + 1} 段` } : {}),
          })),
        };
      },
    },

    // ── extension: lines ──
    lines: {
      async state() {
        return currentLineState();
      },
      async list() {
        const { endpoints } = await currentLineState();
        return { items: endpoints };
      },
      async mirrors() {
        const pages = await loadPublishPages();
        const fresh = await fetchPublishMirrors(pages);
        await storageSet(STORAGE.pagesAt, Date.now());
        let merged = await loadMirrorsCached();
        if (fresh.items.length) {
          const r = await mergeMirrors(fresh.items);
          merged = r.merged;
          await storageSet(STORAGE.mirrors, r.merged);
          await storageSet(STORAGE.trusted, r.auto.map((m) => m.url));
        }
        return { ...fresh, items: merged, pages, pagesAt: await storageGet(STORAGE.pagesAt, null) };
      },
      async probe(args) {
        const urls = Array.isArray(args && args.urls) ? args.urls.slice(0, PROBE_BATCH_MAX) : [];
        const hits = await Promise.all(urls.map((u) => probeOrigin(u, "mirror")));
        return { items: hits };
      },
      async set(args) {
        const v = requireOrigin(args, "url");
        await storageSet(STORAGE.current, v.url);
        return { base: v.url };
      },
      async addCustom(args) {
        const v = requireOrigin(args, "url");
        const custom = await loadCustomLines();
        if (custom.some((c) => c.url === v.url)) throw new hg.PluginError("INVALID_ARGUMENT", "该线路已在自定义线路中");
        custom.push({ url: v.url, label: cleanLabel(args && args.label, v.url), host: v.display || v.host });
        await storageSet(STORAGE.custom, custom);
        return { items: custom };
      },
      async updateCustom(args) {
        const oldV = validateOrigin(args && args.oldUrl);
        if (!oldV.ok) throw new hg.PluginError("INVALID_ARGUMENT", "原始线路不存在");
        const newV = requireOrigin(args, "newUrl");
        const custom = await loadCustomLines();
        const at = custom.findIndex((c) => c.url === oldV.url);
        if (at < 0) throw new hg.PluginError("NOT_FOUND", "原始线路不存在");
        if (newV.url !== oldV.url) {
          if (custom.some((c) => c.url === newV.url)) throw new hg.PluginError("INVALID_ARGUMENT", "该线路已在自定义线路中");
        }
        const label = cleanLabel(args && args.label !== undefined ? args.label : custom[at].label, newV.url);
        custom[at] = { url: newV.url, label, host: newV.display || newV.host };
        await storageSet(STORAGE.custom, custom);
        const fails = await loadFails();
        delete fails[oldV.url];
        await storageSet(STORAGE.fails, fails);
        return { items: custom };
      },
      async removeCustom(args) {
        const origin = normalizeOrigin(args && args.url);
        const custom = (await loadCustomLines()).filter((c) => c.url !== origin);
        await storageSet(STORAGE.custom, custom);
        if (origin) {
          const fails = await loadFails();
          delete fails[origin];
          await storageSet(STORAGE.fails, fails);
        }
        return { items: custom };
      },
      async addFixed(args) {
        const v = requireOrigin(args, "url");
        const fixed = await loadFixed();
        if (fixed.some((f) => f.url === v.url)) throw new hg.PluginError("INVALID_ARGUMENT", "该线路已在固定线路中");
        fixed.push({ label: cleanLabel(args && args.label, v.url), url: v.url, host: v.display || v.host });
        await storageSet(STORAGE.fixed, fixed);
        return { items: fixed };
      },
      async updateFixed(args) {
        const oldV = validateOrigin(args && args.oldUrl);
        if (!oldV.ok) throw new hg.PluginError("INVALID_ARGUMENT", "原始线路不存在");
        const newV = requireOrigin(args, "newUrl");
        const fixed = await loadFixed();
        const at = fixed.findIndex((f) => f.url === oldV.url);
        if (at < 0) throw new hg.PluginError("NOT_FOUND", "原始线路不存在");
        if (newV.url !== oldV.url) {
          if (fixed.some((f) => f.url === newV.url)) throw new hg.PluginError("INVALID_ARGUMENT", "该线路已在固定线路中");
        }
        fixed[at] = { label: cleanLabel(args && args.label, newV.url), url: newV.url, host: newV.display || newV.host };
        await storageSet(STORAGE.fixed, fixed);
        const fails = await loadFails();
        delete fails[oldV.url];
        await storageSet(STORAGE.fails, fails);
        return { items: fixed };
      },
      async removeFixed(args) {
        const v = validateOrigin(args && args.url);
        const origin = v.ok ? v.url : normalizeOrigin(args && args.url);
        const fixed = (await loadFixed()).filter((f) => f.url !== origin);
        await storageSet(STORAGE.fixed, fixed);
        if (origin) {
          const fails = await loadFails();
          delete fails[origin];
          await storageSet(STORAGE.fails, fails);
        }
        return { items: fixed };
      },
      async addMirror(args) {
        const v = requireOrigin(args, "url");
        const mirrors = await loadMirrorsCached();
        if (mirrors.some((m) => m.url === v.url)) throw new hg.PluginError("INVALID_ARGUMENT", "该线路已在镜像线路中");
        mirrors.push({ url: v.url, host: v.display || hostOf(v.url), manual: true });
        await storageSet(STORAGE.mirrors, mirrors);
        return { items: mirrors };
      },
      async removeMirror(args) {
        const origin = normalizeOrigin(args && args.url);
        const mirrors = (await loadMirrorsCached()).filter((m) => m.url !== origin);
        await storageSet(STORAGE.mirrors, mirrors);
        if (origin) {
          const fails = await loadFails();
          delete fails[origin];
          await storageSet(STORAGE.fails, fails);
        }
        return { items: mirrors };
      },
      async addPublishPage(args) {
        const v = requireOrigin(args, "url");
        const pages = await loadPublishPages();
        if (pages.includes(v.url)) throw new hg.PluginError("INVALID_ARGUMENT", "该发布页已在列表中");
        pages.push(v.url);
        await storageSet(STORAGE.pages, pages);
        return { items: pages };
      },
      async removePublishPage(args) {
        const v = validateOrigin(args && args.url);
        const origin = v.ok ? v.url : normalizeOrigin(args && args.url);
        const pages = (await loadPublishPages()).filter((p) => p !== origin);
        await storageSet(STORAGE.pages, pages);
        return { items: pages };
      },
      async reset() {
        await storageSet(STORAGE.fixed, DEFAULT_FIXED.map((f) => ({ ...f })));
        await storageSet(STORAGE.custom, []);
        await storageSet(STORAGE.mirrors, []);
        await storageSet(STORAGE.trusted, []);
        await storageSet(STORAGE.pages, DEFAULT_PUBLISH_PAGES.slice());
        await storageSet(STORAGE.pagesAt, null);
        await storageSet(STORAGE.fails, {});
        return { base: fixedUrl() };
      },
      async autoSet(args) {
        const on = !!(args && args.on);
        await storageSet(STORAGE.auto, on);
        return { auto: on };
      },
      async autoPick() {
        const main = await probeOrigin(fixedUrl(), "main");
        if (main.ok) {
          return { base: main.url, tier: main.tier, ms: main.ms, reason: "main-ok", candidates: [main] };
        }
        let mirrors = await loadMirrorsCached();
        let mirrorError = null;
        if (!mirrors.length) {
          try {
            const fresh = await fetchPublishMirrors();
            if (fresh.items.length) {
              const { merged, auto } = await mergeMirrors(fresh.items);
              mirrors = merged;
              await storageSet(STORAGE.mirrors, merged);
              await storageSet(STORAGE.trusted, auto.map((m) => m.url));
            }
            mirrorError = fresh.errors.join("；") || null;
          } catch (e) {
            mirrorError = e && e.message ? e.message : String(e);
          }
        }
        const trusted = await loadTrusted();
        const candidates = mirrors
          .filter((m) => trusted.includes(m.url))
          .slice(0, 10)
          .map((m) => m.url);
        const hits = [main, ...(await Promise.all(candidates.map((u) => probeOrigin(u, "mirror"))))];
        const winner = hits.filter((h) => h.ok).sort((a, b) => a.ms - b.ms)[0];
        if (!winner) {
          return { base: "", tier: "none", ms: 0, reason: "all-down", candidates: hits, mirrorError };
        }
        return {
          base: winner.url,
          tier: winner.tier,
          ms: winner.ms,
          reason: winner.tier === "main" ? "main-ok" : "mirror-ok",
          candidates: hits,
          mirrorError,
        };
      },
      async health() {
        return probeOrigin(currentOrigin(), "current");
      },
    },

    // ── extension: HGsky home (911218sky/HGhub 首页视图模型) ──
    skyhome: {
      async feed(args) {
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        return normalizePaged(await edge("GET", `/api/videos?page=${pageNo}&size=${size}`, null));
      },
    },

    // ── extension: HGhubX home ──
    xhome: {
      async feed(args) {
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        return normalizePaged(await edge("GET", `/api/videos?page=${pageNo}&size=${size}`, null));
      },
      async rank(args) {
        const kind = String((args && args.kind) || "hot");
        const path = ["recommend", "potential"].includes(kind)
          ? `/api/ranks/${kind}`
          : "/api/ranks/hot";
        const data = await edge("GET", path, null);
        if (data) data.items = normalizeList(data.items);
        return data;
      },
    },

    // ── extension: HGhubX search ──
    xsearch: {
      async search(args) {
        const q = encodeURIComponent(String((args && args.query) || ""));
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        const kind = args && args.kind === "post" ? "&type=post" : args && args.kind === "video" ? "&type=video" : "";
        return normalizePaged(await edge("GET", `/api/search?q=${q}&page=${pageNo}&size=${size}${kind}`, null));
      },
      async hot() {
        return { items: await fetchHot() };
      },
    },

    // ── extension: HGhubX category ──
    xcategory: {
      async categories() {
        return edge("GET", "/api/tags", null);
      },
      async list(args) {
        const cate = encodeURIComponent(String((args && args.cate) || "all"));
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        const sort = args && args.sort ? `&sort=${encodeURIComponent(args.sort)}` : "";
        return normalizePaged(await edge("GET", `/api/videos/category/${cate}?page=${pageNo}&size=${size}${sort}`, null));
      },
      /** Upstream api_original_videos: "all" hits the videos feed with
       *  is_original=1; a sub-category hits /api/videos/category/{cate} with
       *  the same flag (feed.rs:19-39). */
      async original(args) {
        const cate = String((args && args.cate) || "all");
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        const sort = args && args.sort ? `&sort=${encodeURIComponent(args.sort)}` : "";
        const query = `page=${pageNo}&size=${size}${sort}`;
        const path = cate === "all"
          ? `/api/videos?is_original=1&${query}`
          : `/api/videos/category/${encodeURIComponent(cate)}?is_original=1&${query}`;
        return normalizePaged(await edge("GET", path, null));
      },
    },

    // ── extension: HGhubX discover ──
    xdiscover: {
      async topics() {
        const data = await edge("GET", "/api/topics?size=100", null);
        if (data) data.items = normalizeList(data.items);
        return data;
      },
      async topic(args) {
        const slug = encodeURIComponent(String((args && args.slug) || ""));
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        const detail = await edge("GET", `/api/topics/${slug}?page=${pageNo}&size=${size}`, null);
        if (detail) {
          normalizeCover(detail.topic);
          normalizePaged(detail.videos);
          if (Array.isArray(detail.related)) detail.related = detail.related.map(normalizeCover);
        }
        return detail;
      },
      async tags() {
        return edge("GET", "/api/tags", null);
      },
      async tagVideos(args) {
        const tag = encodeURIComponent(String((args && args.tag) || ""));
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        const sort = args && args.sort === "hot" ? "hot" : "latest";
        return normalizePaged(await edge("GET", `/api/videos/tag/${tag}?page=${pageNo}&size=${size}&sort=${sort}`, null));
      },
      async posts(args) {
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        const sort = args && args.sort ? `&sort=${encodeURIComponent(args.sort)}` : "";
        return normalizePaged(await edge("GET", `/api/posts?page=${pageNo}&size=${size}${sort}`, null));
      },
      async postCategory(args) {
        const route = encodeURIComponent(String((args && args.route) || "remen-chigua"));
        const pageNo = Number(args && args.page) || 1;
        const size = Math.min(100, Number(args && args.size) || 20);
        const sort = args && args.sort ? `&sort=${encodeURIComponent(args.sort)}` : "";
        return normalizePaged(await edge("GET", `/api/posts/category/${route}?page=${pageNo}&size=${size}${sort}`, null));
      },
      /** Upstream api_post (feed.rs): GET /api/posts/{id} returns the full
       *  post incl. content HTML, video_url and video_id. */
      async post(args) {
        const id = encodeURIComponent(String((args && args.id) || ""));
        const data = await edge("GET", `/api/posts/${id}`, null);
        // Upstream returns the post object directly; tolerate a {post} wrapper.
        const p = data && data.post ? data.post : data;
        if (p && typeof p === "object") {
          normalizeCover(p);
          return p;
        }
        return data;
      },
      /** Upstream api_post_playback: segmented video URLs for in-post playback. */
      async postPlayback(args) {
        const id = encodeURIComponent(String((args && args.id) || ""));
        return edge("GET", `/api/posts/${id}/playback`, null);
      },
    },

    // ── extension: related ──
    xvideo: {
      async related(args) {
        const id = String((args && args.id) || "");
        return edge("GET", `/api/videos/${id}/related`, null);
      },
    },
  };
}
