/**
 * Frontend pre-validation mirroring the built-in play-source plugin's
 * `validateOrigin`. The plugin remains the authoritative validator and rejects
 * unsafe origins; this module only mirrors the same rules so inline form
 * feedback matches the plugin's classification.
 *
 * Keep the rules in sync with `src-tauri/resources/builtin-plugins/play-source.js`.
 */

export interface LineOriginCheck {
  ok: boolean;
  /** Canonical HTTPS base (protocol + host + port + path) when valid. */
  url?: string;
  /** Lowercased ASCII (punycode) host. */
  host?: string;
  /** Original typed host, preserved for presentation. */
  display?: string;
  code?: string;
  message?: string;
}

const fail = (code: string, message: string): LineOriginCheck => ({ ok: false, code, message });

export function validateLineOrigin(raw: string): LineOriginCheck {
  const s = String(raw ?? "").trim();
  if (!s) return fail("EMPTY", "请输入线路地址");

  let u: URL;
  try {
    u = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ? s : "https://" + s);
  } catch {
    return fail("INVALID", "地址不合法");
  }
  if (u.protocol !== "https:") return fail("SCHEME", "仅支持 HTTPS 线路");
  if (u.username || u.password) return fail("CREDENTIALS", "地址不能包含账号密码");

  const host = (u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return fail("INVALID", "地址不合法");
  if (
    host === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":") ||
    host.endsWith(".localhost") ||
    /\.(local|internal|home\.arpa)$/.test(host)
  ) {
    return fail("PRIVATE", "不允许内网、IP 或 localhost 线路");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host) || host.length > 253) {
    return fail("HOST", "域名不合法");
  }
  const labels = host.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return fail("HOST", "域名不合法");

  const portNum = Number(u.port || "443");
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return fail("PORT", "端口不合法（1–65535）");
  }

  const path = (u.pathname || "").replace(/\/+$/g, "");
  const display = displayHost(s);
  const url = "https://" + host + (portNum === 443 ? "" : ":" + portNum) + path;
  return { ok: true, url, host, display };
}

function displayHost(raw: string): string {
  const s = String(raw || "").trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const at = s.indexOf("@");
  const tail = at >= 0 ? s.slice(at + 1) : s;
  return tail.split("/")[0].split("?")[0].replace(/:$/, "");
}
