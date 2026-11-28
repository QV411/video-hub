import { useState } from "react";
import {
  downloadDelete,
  downloadPickDir,
  downloadResetDir,
  downloadOpenDir,
  downloadOpenFile,
  downloadOpenStorageSettings,
  downloadStart,
  formatSize,
  type DownloadJob,
} from "../download";
import { useDownloads } from "../downloadStore";
import { accessStatus, accessGuidance } from "../download-access";
import { isMobile } from "../environment";
import { useAssetUrls } from "../plugins/MediaCards";
import {
  IBack,
  IDownload,
  ITrash,
  IChevronDown,
  IChevronUp,
  ICheck,
} from "../icons";

type JobTone = "running" | "converting" | "queued" | "done" | "error" | "interrupted";

const TONE_LABEL: Record<JobTone, string> = {
  running: "下载中",
  converting: "转换中",
  queued: "排队中",
  done: "已离线",
  error: "失败",
  interrupted: "已中断",
};

function jobTone(job: DownloadJob): JobTone {
  switch (job.status) {
    case "done":
      return "done";
    case "queued":
      return "queued";
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    default:
      // TS→MP4 合并 / 转封装阶段归入"转换中"，与分片下载区分呈现。
      return job.message.includes("转封装") || job.message.includes("合并") ? "converting" : "running";
  }
}

function CoverThumb({ job }: { job: DownloadJob }) {
  const urls = useAssetUrls(job.pluginId, job.cover ? [job.cover] : []);
  const cover = urls[0];
  return (
    <div className="dl-cover">
      {cover ? (
        <img src={cover} alt="" loading="lazy" />
      ) : (
        <span className="dl-cover-placeholder">
          <IDownload size={22} />
        </span>
      )}
    </div>
  );
}

function StatusBadge({ job }: { job: DownloadJob }) {
  const tone = jobTone(job);
  return (
    <span className={`dl-badge is-${tone}`}>
      <span className="dl-badge-dot" />
      {TONE_LABEL[tone]}
    </span>
  );
}

function JobRow({
  job,
  expanded,
  onToggle,
  onDeleted,
  onRetry,
}: {
  job: DownloadJob;
  expanded: boolean;
  onToggle: () => void;
  onDeleted: () => void;
  onRetry: () => void;
}) {
  const tone = jobTone(job);
  const active = tone === "running" || tone === "converting" || tone === "queued";
  const done = tone === "done";
  const readyCount = job.readyEps.length;
  const pct = job.mode === "series" && job.totalEps > 0
    ? Math.min(1, readyCount / job.totalEps)
    : job.progress;

  const remove = async () => {
    const label = job.mode === "series" ? `《${job.title}》整剧` : `第 ${job.ep} 集`;
    if (!window.confirm(`清理${label}的下载缓存？\n已转换的 MP4 会保留在本机。`)) return;
    try {
      await downloadDelete(job.pluginId, job.mediaId, job.mode === "episode" ? job.ep : undefined);
      onDeleted();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  const openFile = async (ep?: number) => {
    try {
      await downloadOpenFile(job.pluginId, job.mediaId, ep);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "无法打开文件");
    }
  };

  return (
    <article className="dl-card">
      <div className="dl-card-body">
      <CoverThumb job={job} />
      <div className="dl-main">
        <div className="dl-title-row">
          <div className="dl-title">{job.title}</div>
          <StatusBadge job={job} />
        </div>
        <p className="dl-meta">
          {job.mode === "series" ? `整剧 · ${job.totalEps} 集` : `第 ${job.ep} 集`}
          {job.fileSize > 0 ? ` · ${formatSize(job.fileSize)}` : ""}
        </p>

        {active && tone !== "queued" && (
          <div className="dl-progress">
            <div className="dl-progress-track">
              <span className="dl-progress-bar" style={{ width: `${Math.round(pct * 100)}%` }} />
            </div>
            <div className="dl-progress-meta">
              <span className="dl-message">{job.message}</span>
              {job.mode === "series" && (
                <span className="dl-count">{readyCount}/{job.totalEps}</span>
              )}
            </div>
          </div>
        )}
        {tone === "queued" && <p className="dl-meta">{job.message || "排队等待下载"}</p>}
        {(done || tone === "error" || tone === "interrupted") && job.message && (
          <p className="dl-meta">{job.message}</p>
        )}

        <div className="dl-actions">
          {done && job.mode === "episode" && (
            <button onClick={() => void openFile(job.ep)} className="dl-btn dl-btn-secondary">
              打开文件
            </button>
          )}
          {job.mode === "series" && (
            <button
              onClick={onToggle}
              className="dl-btn dl-btn-secondary"
              aria-expanded={expanded}
            >
              选集 {readyCount}/{job.totalEps}
              {expanded ? <IChevronUp size={14} /> : <IChevronDown size={14} />}
            </button>
          )}
          {(tone === "error" || tone === "interrupted") && (
            <button onClick={onRetry} className="dl-btn dl-btn-primary">
              重新下载
            </button>
          )}
          <button
            onClick={() => void remove()}
            aria-label="清理下载缓存（保留 MP4）"
            className="dl-btn dl-btn-icon dl-btn-danger"
          >
            <ITrash size={15} />
          </button>
        </div>
      </div>
      </div>

      {job.mode === "series" && expanded && (
        <SeriesEps job={job} onOpen={(ep) => void openFile(ep)} onDeleted={onDeleted} />
      )}
    </article>
  );
}

function SeriesEps({
  job,
  onOpen,
  onDeleted,
}: {
  job: DownloadJob;
  onOpen: (ep: number) => void;
  onDeleted: () => void;
}) {
  const total = Math.max(1, job.totalEps);
  const ready = new Set(job.readyEps);
  const eps = Array.from({ length: total }, (_, i) => i + 1);
  return (
    <div className="dl-eps">
      <div className="dl-eps-grid">
        {eps.map((ep) => {
          const has = ready.has(ep);
          return (
            <button
              key={ep}
              disabled={!has}
              onClick={() => onOpen(ep)}
              className={`dl-ep ${has ? "is-ready" : "is-pending"}`}
            >
              {has && <ICheck size={11} />}
              {ep}
            </button>
          );
        })}
      </div>
      <p className="dl-eps-note">已缓存 {ready.size}/{total} 集 · 点击已缓存集数可打开成品</p>
      {ready.size > 0 && (
        <button
          className="dl-eps-danger pressable"
          onClick={() => void downloadDelete(job.pluginId, job.mediaId).then(onDeleted).catch(() => {})}
        >
          清理整剧下载缓存（保留 MP4）
        </button>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="hpp-empty">
      <IDownload size={38} />
      <h2>还没有离线内容</h2>
      <p>在作品详情或播放器里选择剧集下载，离线文件会保存在本机。</p>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="dl-skeleton">
      {[0, 1].map((i) => (
        <div className="dl-skeleton-card" key={i}>
          <div className="dl-skeleton-cover" />
          <div className="dl-skeleton-body">
            <div className="dl-skeleton-line w70" />
            <div className="dl-skeleton-line w40" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DownloadsPage({ onBack }: { onBack?: () => void }) {
  const { jobs, dir, settings, ready, listError, refresh, refreshSettings } = useDownloads();
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [authBusy, setAuthBusy] = useState(false);

  const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const history = jobs.filter((j) => j.status !== "running" && j.status !== "queued");
  const fallback = settings?.mode === "fallback";
  const access = accessStatus(settings);
  const needAuth = !!settings?.mobile && access === "denied";
  const checkingAuth = !!settings?.mobile && access === "detecting";

  const modeLabel = settings?.mode === "fallback"
    ? "应用专属目录"
    : settings?.mode === "custom"
      ? "自选目录"
      : "默认目录";
  const activeDir = settings ? (settings.effectiveDir || settings.dir) : dir;

  const authorize = async () => {
    setAuthBusy(true);
    setError("");
    try {
      await downloadOpenStorageSettings();
      await refreshSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法打开文件访问设置");
    } finally {
      setAuthBusy(false);
    }
  };

  const retryJob = async (job: DownloadJob) => {
    setError("");
    try {
      await downloadStart({
        pluginId: job.pluginId,
        mediaId: job.mediaId,
        episodeId: job.episodeId || undefined,
        playlistId: job.playlistId || undefined,
        ep: job.mode === "episode" ? job.ep : undefined,
        mode: job.mode,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重新下载失败");
    }
  };

  const pickDir = async () => {
    try {
      const picked = await downloadPickDir();
      if (picked) await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法选择文件夹");
    }
  };
  const resetDir = async () => {
    try {
      await downloadResetDir();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法恢复默认目录");
    }
  };
  const openDir = async () => {
    try {
      await downloadOpenDir();
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法打开目录");
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="dl-page absolute inset-0 bg-bg">
      <header className="dl-header" style={{ paddingTop: "var(--sat, 0px)" }}>
        {onBack && (
          <button
            onClick={onBack}
            aria-label="返回"
            className="dl-btn dl-btn-icon rounded-full"
          >
            <IBack size={20} />
          </button>
        )}
        <div className="dl-header-title">
          <h1>下载中心</h1>
          <div className="dl-header-dir">
            <span className={`dl-chip ${fallback ? "is-fallback" : settings?.mode === "custom" ? "is-custom" : ""}`}>
              {modeLabel}
            </span>
            <span className="path">{activeDir || "读取目录中…"}</span>
          </div>
        </div>
        <button onClick={() => void openDir()} className="dl-btn dl-btn-secondary">
          打开目录
        </button>
        {!isMobile && (
          <>
            <button onClick={() => void pickDir()} className="dl-btn dl-btn-secondary">
              更改目录
            </button>
            <button onClick={() => void resetDir()} className="dl-btn dl-btn-secondary">
              默认目录
            </button>
          </>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-10">
        {error && <p role="alert" className="dl-alert">{error}</p>}
        {listError && (
          <p role="alert" className="dl-alert">
            下载列表加载失败
            <button className="dl-btn dl-btn-secondary" style={{ marginLeft: 8 }} onClick={() => void refresh()}>
              重试
            </button>
          </p>
        )}

        {needAuth && (
          <div className="dl-banner is-denied">
            <div className="dl-banner-body">
              <p className="dl-banner-title">文件访问未授权</p>
              <p className="dl-banner-guidance">{accessGuidance(settings)}</p>
            </div>
            <button onClick={() => void authorize()} disabled={authBusy} className="dl-btn dl-btn-primary">
              授权所有文件访问
            </button>
          </div>
        )}
        {checkingAuth && <p className="dl-note">正在检测文件访问授权状态…</p>}
        {fallback && !needAuth && settings?.reason && (
          <p className="dl-note">{settings.reason}</p>
        )}

        {!ready && <SkeletonCards />}
        {ready && !jobs.length && !listError && <EmptyState />}

        {active.length > 0 && (
          <section className="dl-section">
            <h2 className="dl-section-head">进行中</h2>
            <div className="dl-list">
              {active.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  expanded={expanded.has(job.id)}
                  onToggle={() => toggle(job.id)}
                  onDeleted={() => void refresh()}
                  onRetry={() => void retryJob(job)}
                />
              ))}
            </div>
          </section>
        )}

        {history.length > 0 && (
          <section className="dl-section">
            <h2 className="dl-section-head">历史记录</h2>
            <div className="dl-list">
              {history.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  expanded={expanded.has(job.id)}
                  onToggle={() => toggle(job.id)}
                  onDeleted={() => void refresh()}
                  onRetry={() => void retryJob(job)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
