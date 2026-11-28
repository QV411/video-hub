import type { DownloadSettings } from "./download";

/**
 * Shared copy for the all-files-access authorization chain. The status is
 * derived from the settings snapshot; the guidance path is tailored to the
 * OEM reported by `Build.MANUFACTURER`, with a generic fallback for skins
 * we do not recognize.
 */

export type AccessStatus = "detecting" | "granted" | "denied";

export function accessStatus(settings: DownloadSettings | null | undefined): AccessStatus {
  if (!settings) return "detecting";
  return settings.storageGranted ? "granted" : "denied";
}

export const ACCESS_STATUS_LABEL: Record<AccessStatus, string> = {
  detecting: "检测中…",
  granted: "已授权",
  denied: "未授权",
};

/** Generic special-access path, used when the OEM is unknown or unsupported. */
const GENERIC_HINT = "通用路径：设置 → 应用 → video-hub → 特殊权限 → 所有文件访问权限";

function vendorHint(manufacturer?: string | null): string {
  const m = (manufacturer || "").toLowerCase().trim();
  if (!m) return GENERIC_HINT;
  if (m.includes("xiaomi") || m.includes("redmi") || m.includes("poco")) {
    return "MIUI 路径：设置 → 应用设置 → 应用管理 → video-hub → 权限 → 所有文件访问";
  }
  if (m.includes("huawei") || m.includes("honor") || m.includes("hilink")) {
    return "EMUI / HarmonyOS 路径：设置 → 应用和服务 → 应用管理 → video-hub → 权限 → 文件";
  }
  if (m.includes("oppo") || m.includes("oneplus") || m.includes("realme")) {
    return "ColorOS 路径：设置 → 权限与隐私 → 权限管理 → video-hub → 文件";
  }
  if (m.includes("vivo") || m.includes("iqoo")) {
    return "OriginOS / Funtouch 路径：设置 → 应用与权限 → 权限管理 → video-hub → 文件";
  }
  if (m.includes("samsung")) {
    return "One UI 路径：设置 → 应用程序 → video-hub → 权限 → 文件和媒体";
  }
  return GENERIC_HINT;
}

/** Full guidance line for the unauthorized state, vendor-tailored when known. */
export function accessGuidance(settings: DownloadSettings | null | undefined): string {
  const base = settings?.externalDir
    ? `未授权时仅能保存到应用专属目录；授权后使用公共目录 ${settings.externalDir}`
    : "未授权时仅能保存到应用专属目录";
  return `${base}。${vendorHint(settings?.manufacturer)}`;
}
