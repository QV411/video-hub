//! Native offline download engine (host-side, never inside the QuickJS sandbox).
//!
//! The queue, HLS parsing, AES-128-CBC decryption and TS/MP4 muxing live in this
//! shell module. Every byte transfer goes through the plugin's controlled
//! `Network` via `PluginManager::host_fetch`; playlists and playback addresses are
//! resolved through the plugin's public `media.getDetail` / `media.resolvePlayback`
//! methods. No standalone reqwest client is created here.

use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use base64::Engine as _;
use hghub_hpp::PluginManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use crate::plugins::PluginHost;
#[cfg(target_os = "android")]
use crate::android_storage::AndroidMedia;
use tauri::Emitter;
use tauri::Manager;
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Android public publish folder for finished MP4s. Under the scoped-storage
/// model (TargetAPI 37, no all-files access) this is a MediaStore collection
/// target (`Movies/video-hub`), not a writable working directory: the download
/// engine works in the app-private dir and publishes results here.
#[cfg(target_os = "android")]
const ANDROID_PUBLIC_ROOT: &str = "/storage/emulated/0/Movies/video-hub";

/// Download behavior preferences, persisted next to the chosen root directory.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadConfig {
    /// User-selected absolute download root; `None` means the default `<app_data>/downloads`.
    #[serde(default)]
    dir: Option<String>,
    /// Extra retry attempts per segment / playlist fetch (0 = no retry). Clamped 0..=3.
    #[serde(default = "default_retries")]
    retries: u8,
    /// Keep the merged `video.ts` beside the MP4 after a successful remux.
    /// Default `false`: the TS is deleted once the MP4 is ready.
    #[serde(default)]
    keep_ts: bool,
}

fn default_retries() -> u8 {
    1
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self { dir: None, retries: default_retries(), keep_ts: false }
    }
}

/// Episode reference persisted on series jobs so the worker can resume enumeration
/// without re-reading the plugin.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeRef {
    pub id: String,
    pub number: u32,
    #[serde(default)]
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub plugin_id: String,
    pub media_id: String,
    pub episode_id: String,
    #[serde(default)]
    pub playlist_id: String,
    pub title: String,
    /// Plugin `ImageRef` (string or ResourceRef object), handed back to the
    /// frontend so it can prepare a local cover through `assets.prepare`.
    #[serde(default)]
    pub cover: Value,
    pub ep: u32,
    pub total_eps: u32,
    pub mode: String, // "episode" | "series"
    pub status: String, // queued|running|done|error|interrupted
    pub progress: f64,
    pub message: String,
    #[serde(default)]
    pub playlist_path: String,
    #[serde(default)]
    pub video_path: String,
    #[serde(default)]
    pub file_size: u64,
    #[serde(default)]
    pub ready_eps: Vec<u32>,
    #[serde(default)]
    pub episodes: Vec<EpisodeRef>,
    #[serde(default)]
    pub updated_at: u64,
    /// Per-episode publish record for finished MP4s that were published into
    /// the shared `Movies/video-hub` collection (scoped-storage model). The
    /// private working copy is removed after a successful publish; episodes
    /// missing here (publish failed / desktop) still resolve through
    /// `video_path`.
    #[serde(default)]
    #[cfg(target_os = "android")]
    pub published: std::collections::HashMap<u32, PublishedFile>,
}

/// One published MP4: MediaStore content URI plus the public display path.
#[cfg(target_os = "android")]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedFile {
    pub uri: String,
    pub public_path: String,
}

struct QueuedTask {
    key: String,
    /// Manager captured at start time; restored queued tasks carry `None` and
    /// resolve the shared manager from the [PluginHost] when the worker runs them.
    manager: Option<Arc<PluginManager>>,
    plugin_id: String,
    media_id: String,
    episode_id: String,
    playlist_id: String,
    title: String,
    ep: u32,
    mode: String,
    episodes: Vec<EpisodeRef>,
    total_eps: u32,
}

pub struct DownloadHost {
    /// App-private data directory. Read on desktop to locate the staged
    /// bundled FFmpeg; the Android build resolves ffmpeg from the native
    /// library directory instead.
    #[cfg_attr(target_os = "android", allow(dead_code))]
    app_data: PathBuf,
    default_root: PathBuf,
    /// Android-only public publish folder (MediaStore `Movies/video-hub`);
    /// `None` on desktop. Display-only — never used as a working directory.
    external_root: Option<PathBuf>,
    config_file: PathBuf,
    config: Mutex<DownloadConfig>,
    root: Mutex<Option<PathBuf>>,
    /// Android scoped-storage media bridge; populated during setup. `None`
    /// before the bridge registers, or on desktop.
    #[cfg(target_os = "android")]
    media: Mutex<Option<AndroidMedia>>,
    /// Cached Android native library directory (holds the bundled ffmpeg and
    /// its libav* dependencies). `None` until the bridge reports it.
    #[cfg(target_os = "android")]
    native_lib_dir: Mutex<Option<String>>,
    jobs: Mutex<HashMap<String, DownloadJob>>,
    queue: Mutex<VecDeque<QueuedTask>>,
    worker: AtomicBool,
    stopping: AtomicBool,
    handle: Mutex<Option<tauri::AppHandle>>,
    last_emit: Mutex<HashMap<String, u64>>,
    /// Active root mode: `workdir` (Android: app-private working directory,
    /// publishes to the shared collection when done), `public` (desktop:
    /// app-data default) or `custom` (desktop user-picked directory).
    dir_mode: Mutex<String>,
    /// Human-readable cause for the active root, surfaced to the UI.
    dir_reason: Mutex<String>,
}

impl DownloadHost {
    pub fn new(app_data: PathBuf) -> Self {
        let default_root = app_data.join("downloads");
        let _ = std::fs::create_dir_all(&default_root);
        let config_file = app_data.join("download_dir.json");
        let config = load_config(&config_file);
        #[cfg(target_os = "android")]
        let external_root = Some(PathBuf::from(ANDROID_PUBLIC_ROOT));
        #[cfg(not(target_os = "android"))]
        let external_root: Option<PathBuf> = None;
        let root = config
            .dir
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_root.clone());
        let _ = std::fs::create_dir_all(&root);
        Self {
            app_data: app_data.clone(),
            default_root,
            external_root,
            config_file,
            config: Mutex::new(config),
            root: Mutex::new(Some(root)),
            #[cfg(target_os = "android")]
            media: Mutex::new(None),
            #[cfg(target_os = "android")]
            native_lib_dir: Mutex::new(None),
            jobs: Mutex::new(HashMap::new()),
            queue: Mutex::new(VecDeque::new()),
            worker: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            handle: Mutex::new(None),
            last_emit: Mutex::new(HashMap::new()),
            #[cfg(target_os = "android")]
            dir_mode: Mutex::new("workdir".to_string()),
            #[cfg(target_os = "android")]
            dir_reason: Mutex::new("工作目录为应用私有缓存，无需存储权限".to_string()),
            #[cfg(not(target_os = "android"))]
            dir_mode: Mutex::new("public".to_string()),
            #[cfg(not(target_os = "android"))]
            dir_reason: Mutex::new("使用应用默认下载目录".to_string()),
        }
    }

    /// Attach the Android media bridge after the mobile plugin registers.
    #[cfg(target_os = "android")]
    pub fn set_media(&self, bridge: AndroidMedia) {
        if let Ok(mut media) = self.media.lock() {
            *media = Some(bridge);
        }
    }

    /// Clone the media bridge, if registered.
    #[cfg(target_os = "android")]
    fn media_bridge(&self) -> Option<AndroidMedia> {
        self.media.lock().ok().and_then(|m| m.clone())
    }

    /// Re-resolve the active root against the current storage grant.
    ///
    /// Desktop: persisted user directory (`custom`), otherwise the app-data
    /// default (`public`).
    /// Android: public shared root when all-files access is granted; otherwise
    /// the app-private `downloads` fallback (`fallback`). A failed bridge check
    /// or a failed public-directory creation falls back to the private
    /// directory rather than failing the download queue. The chosen mode and
    /// a human-readable reason are cached alongside the root.
    pub async fn refresh_storage(&self) {
        #[cfg(target_os = "android")]
        {
            // Scoped-storage model: the working directory is ALWAYS the
            // app-private dir — writable with zero permissions on every API
            // level. Finished MP4s are published to the shared collection
            // (`Movies/video-hub`) through the media bridge afterwards.
            if let Some(bridge) = self.media_bridge() {
                if let Some(dir) = bridge.native_lib_dir().await {
                    if let Ok(mut cache) = self.native_lib_dir.lock() {
                        *cache = Some(dir);
                    }
                }
            }
            let target = self.default_root.clone();
            let _ = std::fs::create_dir_all(&target);
            let mode = "workdir";
            let reason = "工作目录为应用私有缓存（无权限需求）；完成的 MP4 自动发布到 Movies/video-hub";
            self.store_root(&target, mode, reason);
            cleanup_legacy_nested_root(&target);
            emit_dir(self);
        }
        #[cfg(not(target_os = "android"))]
        {
            let (target, mode, reason) = {
                let config = self.config.lock().ok();
                match config.and_then(|c| c.dir.clone()).map(PathBuf::from) {
                    Some(picked) => (picked, "custom", "使用您选择的目录"),
                    None => (self.default_root.clone(), "public", "使用应用默认下载目录"),
                }
            };
            let _ = std::fs::create_dir_all(&target);
            self.store_root(&target, mode, &reason);
            emit_dir(self);
        }
    }

    /// Persist the resolved root, its mode and display reason.
    fn store_root(&self, target: &Path, mode: &str, reason: &str) {
        if let Ok(mut root) = self.root.lock() {
            *root = Some(target.to_path_buf());
        }
        if let Ok(mut m) = self.dir_mode.lock() {
            *m = mode.to_string();
        }
        if let Ok(mut r) = self.dir_reason.lock() {
            *r = reason.to_string();
        }
    }

    /// Platform default download directory: Android public shared root,
    /// otherwise the app-data `downloads` folder.
    fn default_dir_string(&self) -> String {
        #[cfg(target_os = "android")]
        {
            self.external_dir()
                .unwrap_or_else(|| self.default_root.to_string_lossy().into_owned())
        }
        #[cfg(not(target_os = "android"))]
        {
            self.default_root.to_string_lossy().into_owned()
        }
    }

    fn current_mode(&self) -> String {
        self.dir_mode.lock().ok().map(|m| m.clone()).unwrap_or_else(|| "public".to_string())
    }

    fn current_reason(&self) -> String {
        self.dir_reason.lock().ok().map(|r| r.clone()).unwrap_or_default()
    }

    /// Public external root on Android; `None` elsewhere / when unset.
    fn external_dir(&self) -> Option<String> {
        self.external_root
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
    }

    /// Attach the app handle (for event pushes) and reload persisted jobs.
    /// Must be called once during setup, before the frontend fetches the list.
    pub fn bind(&self, app: tauri::AppHandle) {
        if let Ok(mut h) = self.handle.lock() {
            *h = Some(app);
        }
        self.restore();
    }

    /// Persist every in-memory job manifest and mark the worker draining.
    /// Called from the app exit hook so no job state is left unsaved.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.persist_all();
    }

    fn persist_all(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                let _ = save_manifest(self, job);
            }
        }
    }

    /// Load persisted manifests on startup and reconcile in-memory state:
    /// - `done` / `error` / `interrupted` records are kept for inspection;
    /// - `queued` tasks are re-enqueued;
    /// - `running` tasks (the process died mid-download) are marked
    ///   `interrupted` with a reason. Partial fragments are not resumed: the
    ///   source playlist may have expired, so the user can re-trigger instead.
    fn restore(&self) {
        let Ok(root) = root(self) else { return };
        let entries = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => return,
        };
        let mut found: Vec<DownloadJob> = Vec::new();
        for media_dir in entries.flatten() {
            let sp = media_dir.path();
            if !sp.is_dir() {
                continue;
            }
            if let Some(job) = read_job_file(&sp.join("job.json")) {
                found.push(job);
            }
            if let Ok(eps) = std::fs::read_dir(&sp) {
                for e in eps.flatten() {
                    if !e.path().is_dir() {
                        continue;
                    }
                    if let Some(job) = read_job_file(&e.path().join("job.json")) {
                        found.push(job);
                    }
                }
            }
        }
        let mut queue: VecDeque<QueuedTask> = VecDeque::new();
        {
            let Ok(mut jobs) = self.jobs.lock() else { return };
            for mut job in found {
                match job.status.as_str() {
                    "running" => {
                        job.status = "interrupted".to_string();
                        job.message = "应用退出时下载中断，可重新下载".to_string();
                    }
                    "queued" => queue.push_back(task_from_job(&job)),
                    _ => {}
                }
                jobs.insert(job.id.clone(), job);
            }
        }
        if let Ok(mut q) = self.queue.lock() {
            q.extend(queue);
        }
        // Persist the normalized status (e.g. running → interrupted) so the
        // on-disk manifest matches the in-memory reconciliation.
        self.persist_all();
    }
}

fn task_from_job(job: &DownloadJob) -> QueuedTask {
    QueuedTask {
        key: job.id.clone(),
        manager: None,
        plugin_id: job.plugin_id.clone(),
        media_id: job.media_id.clone(),
        episode_id: job.episode_id.clone(),
        playlist_id: job.playlist_id.clone(),
        title: job.title.clone(),
        ep: job.ep,
        mode: job.mode.clone(),
        episodes: job.episodes.clone(),
        total_eps: job.total_eps,
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn request_id(prefix: &str) -> String {
    format!(
        "download-{prefix}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

/// Strip filesystem-unsafe characters (`/ \ : * ? " < > |`), control
/// characters and `..` so a plugin-supplied id or title can never escape its
/// download folder. May return an empty string.
fn sanitize_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(*c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect();
    cleaned.replace("..", "__").trim_matches('.').trim().to_string()
}

/// Non-empty variant of [`sanitize_component`] for ids.
fn sanitize_name(raw: &str) -> String {
    let cleaned = sanitize_component(raw);
    if cleaned.is_empty() {
        "item".to_string()
    } else {
        cleaned
    }
}

/// Per-video top folder name: the sanitized video title, falling back to the
/// sanitized media id only when the title is empty.
fn media_folder_name(title: &str, media_id: &str) -> String {
    let from_title = sanitize_component(title);
    if from_title.is_empty() {
        sanitize_name(media_id)
    } else {
        from_title
    }
}

/// Read the persisted download config. Legacy files only carried `{ "dir": "..." }`;
/// missing fields fall back to defaults.
fn load_config(cfg: &Path) -> DownloadConfig {
    let text = match std::fs::read_to_string(cfg) {
        Ok(t) => t,
        Err(_) => return DownloadConfig::default(),
    };
    serde_json::from_str::<DownloadConfig>(&text).unwrap_or_default()
}

fn persist_config(host: &DownloadHost) -> Result<(), String> {
    let config = host.config.lock().map_err(|_| "download lock".to_string())?;
    let text = serde_json::to_string_pretty(&*config).map_err(|e| e.to_string())?;
    std::fs::write(&host.config_file, text).map_err(|e| e.to_string())
}

fn retries(host: &DownloadHost) -> u8 {
    host.config
        .lock()
        .map(|c| c.retries.clamp(0, 3))
        .unwrap_or(1)
}

fn keep_ts(host: &DownloadHost) -> bool {
    host.config.lock().map(|c| c.keep_ts).unwrap_or(false)
}

fn root(host: &DownloadHost) -> Result<PathBuf, String> {
    host.root
        .lock()
        .map_err(|_| "download lock".to_string())?
        .clone()
        .ok_or_else(|| "下载目录未初始化".to_string())
}

fn media_dir(root: &Path, title: &str, media_id: &str) -> PathBuf {
    root.join(media_folder_name(title, media_id))
}

/// Episode subfolder: `视频标题-x` inside the per-video top folder.
fn episode_dir(root: &Path, title: &str, media_id: &str, ep: u32) -> PathBuf {
    media_dir(root, title, media_id).join(format!("{}-{ep}", media_folder_name(title, media_id)))
}

fn job_key(plugin_id: &str, media_id: &str, ep: u32, mode: &str) -> String {
    if mode == "series" {
        format!("series:{plugin_id}:{media_id}")
    } else {
        format!("ep:{plugin_id}:{media_id}:{ep}")
    }
}

fn manifest_path(host: &DownloadHost, job: &DownloadJob) -> Result<PathBuf, String> {
    let root = root(host)?;
    if job.mode == "series" {
        Ok(media_dir(&root, &job.title, &job.media_id).join("job.json"))
    } else {
        Ok(episode_dir(&root, &job.title, &job.media_id, job.ep).join("job.json"))
    }
}

fn save_manifest(host: &DownloadHost, job: &DownloadJob) -> Result<(), String> {
    let path = manifest_path(host, job)?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(job).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Event names pushed to the webview. The frontend subscribes once and merges
/// upsert/remove payloads incrementally; it no longer polls the list command.
const EVENT_JOB: &str = "download:job";
const EVENT_DIR: &str = "download:dir";
/// Progress pushes are throttled per job; state transitions and deletes push
/// immediately.
const EMIT_THROTTLE_MS: u64 = 600;

fn emit_job(host: &DownloadHost, action: &str, job: &DownloadJob) {
    let handle = host
        .handle
        .lock()
        .ok()
        .and_then(|h| h.clone());
    let Some(handle) = handle else { return };
    let _ = handle.emit(EVENT_JOB, json!({ "action": action, "job": job }));
}

fn emit_dir(host: &DownloadHost) {
    let handle = host
        .handle
        .lock()
        .ok()
        .and_then(|h| h.clone());
    let Some(handle) = handle else { return };
    let Ok(root) = root(host) else { return };
    let _ = handle.emit(EVENT_DIR, json!({
        "dir": root.to_string_lossy(),
        "effectiveDir": root.to_string_lossy(),
        "mode": host.current_mode(),
        "reason": host.current_reason(),
    }));
}

fn bump_job(
    host: &DownloadHost,
    job_id: &str,
    mut edit: impl FnMut(&mut DownloadJob),
    force: bool,
) {
    let Ok(mut jobs) = host.jobs.lock() else { return };
    let Some(j) = jobs.get_mut(job_id) else { return };
    let prev_status = j.status.clone();
    edit(j);
    j.updated_at = now_secs();
    let _ = save_manifest(host, j);
    let now = now_millis();
    let status_changed = j.status != prev_status;
    let should_emit = force || status_changed || {
        host.last_emit
            .lock()
            .map(|mut m| {
                let last = m.get(&j.id).copied().unwrap_or(0);
                if now - last >= EMIT_THROTTLE_MS {
                    m.insert(j.id.clone(), now);
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false)
    };
    if should_emit {
        host.last_emit
            .lock()
            .map(|mut m| {
                m.insert(j.id.clone(), now);
            })
            .ok();
        emit_job(host, "upsert", j);
    }
}

/// Canonicalize and confirm the path stays inside the download root.
fn safe_under_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    let canon = if path.exists() {
        path.canonicalize().map_err(|e| e.to_string())?
    } else {
        // Lexical normalization for not-yet-created targets. Callers build
        // `path` by joining onto the same `root`, so for an absolute path the
        // root prefix is stripped lexically and only the remainder is appended
        // once. Re-appending the full absolute path onto the root used to
        // duplicate the whole prefix — the nested
        // `Movies/video-hub/storage/emulated/0/Movies/video-hub/...` bug.
        let rest = match path.strip_prefix(root) {
            Ok(rest) => Some(rest),
            Err(_) => None,
        };
        match rest {
            Some(rest) => {
                let mut joined = root_canon.clone();
                for component in rest.components() {
                    use std::path::Component::*;
                    match component {
                        Normal(c) => joined.push(c),
                        ParentDir => {
                            joined.pop();
                        }
                        _ => {}
                    }
                }
                joined
            }
            None => {
                // Path rooted elsewhere: normalize it standalone, then the
                // containment check below rejects anything outside the root.
                let mut joined = PathBuf::new();
                for component in path.components() {
                    use std::path::Component::*;
                    match component {
                        Normal(c) => joined.push(c),
                        ParentDir => {
                            joined.pop();
                        }
                        _ => {}
                    }
                }
                joined
            }
        }
    };
    if !canon.starts_with(&root_canon) {
        return Err("下载路径越界".to_string());
    }
    Ok(canon)
}

/// Episode artifacts: the merged MP4 lives in the per-video TOP folder
/// (sibling of the episode subfolders) as `视频标题-x.mp4`; the merged TS and
/// the local playlist stay inside the episode subfolder.
fn episode_media_files(root: &Path, title: &str, media_id: &str, ep: u32) -> (PathBuf, PathBuf, PathBuf) {
    let dir = episode_dir(root, title, media_id, ep);
    let mp4 = media_dir(root, title, media_id)
        .join(format!("{}-{ep}.mp4", media_folder_name(title, media_id)));
    (mp4, dir.join("video.ts"), dir.join("index.m3u8"))
}

fn episode_ready(root: &Path, title: &str, media_id: &str, ep: u32) -> bool {
    let (mp4, ts, pl) = episode_media_files(root, title, media_id, ep);
    mp4.is_file() || ts.is_file() || pl.is_file()
}

/// Resolve the stored title for a media id (used by delete / open commands
/// that only receive ids). Falls back to scanning persisted manifests, then
/// to an empty title (which resolves to the legacy id-named folder).
fn media_title(host: &DownloadHost, root: &Path, media_id: &str) -> String {
    if let Ok(jobs) = host.jobs.lock() {
        if let Some(j) = jobs.values().find(|j| j.media_id == media_id) {
            return j.title.clone();
        }
    }
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            if let Some(job) = read_job_file(&p.join("job.json")) {
                if job.media_id == media_id {
                    return job.title;
                }
            }
            if let Ok(eps) = std::fs::read_dir(&p) {
                for sub in eps.flatten() {
                    if let Some(job) = read_job_file(&sub.path().join("job.json")) {
                        if job.media_id == media_id {
                            return job.title;
                        }
                    }
                }
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Plugin-mediated requests (detail / playback / bytes)
// ---------------------------------------------------------------------------

async fn fetch_bytes(
    manager: &PluginManager,
    plugin_id: &str,
    url: &str,
    headers: &Value,
    retries: u8,
) -> Result<Vec<u8>, String> {
    let mut attempt: u8 = 0;
    loop {
        match fetch_once(manager, plugin_id, url, headers).await {
            Ok(bytes) => return Ok(bytes),
            Err(_e) if attempt < retries => {
                attempt += 1;
                // Immediate retry; tokio's `time` feature is intentionally off,
                // so no async backoff timer is used here.
            }
            Err(e) => return Err(e),
        }
    }
}

async fn fetch_once(
    manager: &PluginManager,
    plugin_id: &str,
    url: &str,
    headers: &Value,
) -> Result<Vec<u8>, String> {
    let req = json!({
        "url": url,
        "method": "GET",
        "responseType": "bytes",
        "credentials": "include",
        "headers": headers,
        "maxBytes": 8 * 1024 * 1024,
    });
    let resp = manager
        .host_fetch(plugin_id, req)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    if resp["ok"].as_bool() != Some(true) {
        return Err(format!("下载失败 HTTP {}", resp["status"].as_u64().unwrap_or(0)));
    }
    if resp["dataBinary"].as_bool() == Some(true) {
        let b64 = resp["data"].as_str().ok_or("响应缺少字节数据")?;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| "字节数据解码失败".to_string())
    } else {
        Ok(resp["data"].as_str().unwrap_or_default().as_bytes().to_vec())
    }
}

async fn resolve_stream(
    manager: &PluginManager,
    plugin_id: &str,
    media_id: &str,
    episode_id: &str,
    playlist_id: &str,
) -> Result<(String, Value), String> {
    let params = json!({
        "mediaId": media_id,
        "episodeId": episode_id,
        "playlistId": playlist_id,
        "reason": "play",
    });
    let info = manager
        .call(
            plugin_id,
            "media.resolvePlayback",
            params,
            request_id("playback"),
        )
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let streams = info["streams"]
        .as_array()
        .ok_or_else(|| "播放信息缺少 streams".to_string())?;
    let stream = streams
        .iter()
        .find(|s| s["format"].as_str() == Some("hls"))
        .or_else(|| streams.iter().find(|s| !s["url"].is_null()))
        .ok_or_else(|| "暂无可下载的播放流".to_string())?;
    let url = stream["url"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "播放流缺少地址".to_string())?;
    Ok((url.to_string(), stream["headers"].clone()))
}

fn episodes_of_detail(detail: &Value, playlist_id: Option<&str>) -> Vec<EpisodeRef> {
    let playlists = detail["playlists"].as_array();
    let chosen = playlist_id
        .and_then(|id| playlists.and_then(|p| p.iter().find(|x| x["id"].as_str() == Some(id))))
        .or_else(|| playlists.and_then(|p| p.first()));
    let Some(list) = chosen else { return Vec::new() };
    let mut eps: Vec<EpisodeRef> = list["episodes"]
        .as_array()
        .map(|eps| {
            eps.iter()
                .map(|ep| EpisodeRef {
                    id: ep["id"].as_str().unwrap_or_default().to_string(),
                    number: ep["episodeNumber"]
                        .as_u64()
                        .or_else(|| ep["index"].as_u64())
                        .unwrap_or(1) as u32,
                    label: ep["label"].as_str().unwrap_or_default().to_string(),
                })
                .filter(|e| !e.id.is_empty())
                .collect()
        })
        .unwrap_or_default();
    // The content model allows `episodeNumber >= 0`, so some sources number
    // the first episode 0. Shift such lists to 1-based numbering; otherwise
    // episode 1 lands in folder 0 and is dropped by every `1..=total_eps`
    // ready check (download center, series completion), i.e. "整剧漏掉第1集".
    if eps.iter().any(|e| e.number == 0) {
        for e in &mut eps {
            e.number += 1;
        }
    }
    eps
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

async fn start(
    host: Arc<DownloadHost>,
    manager: Arc<PluginManager>,
    plugin_id: String,
    media_id: String,
    episode_id: Option<String>,
    playlist_id: Option<String>,
    ep: Option<u32>,
    mode: String,
) -> Result<Value, String> {
    let mode = if mode == "series" { "series" } else { "episode" };

    // Enrich from the plugin itself; the frontend never passes a playback URL.
    let detail = manager
        .call(
            &plugin_id,
            "media.getDetail",
            json!({ "id": media_id }),
            request_id("detail"),
        )
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))?;

    let title = detail["title"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("未命名作品")
        .to_string();
    let cover = detail["cover"].clone();
    let episodes = episodes_of_detail(&detail, playlist_id.as_deref());
    let total_eps = detail["totalEpisodes"]
        .as_u64()
        .or_else(|| detail["episodeCount"].as_u64())
        .unwrap_or_else(|| episodes.len() as u64)
        .max(1) as u32;

    let ep_number = ep.unwrap_or_else(|| {
        episode_id
            .as_deref()
            .and_then(|id| episodes.iter().find(|e| e.id == id))
            .map(|e| e.number)
            .unwrap_or(1)
    });
    let episode_id = episode_id.unwrap_or_else(|| {
        episodes
            .iter()
            .find(|e| e.number == ep_number)
            .map(|e| e.id.clone())
            .unwrap_or_default()
    });
    let playlist_id = playlist_id.unwrap_or_default();

    let key = job_key(&plugin_id, &media_id, ep_number, mode);
    {
        let jobs = host.jobs.lock().map_err(|_| "download lock".to_string())?;
        if jobs.get(&key).is_some_and(|j| j.status == "running" || j.status == "queued") {
            return Ok(json!(jobs.get(&key).cloned()));
        }
    }

    let root = root(&host)?;
    if mode == "episode" && episode_ready(&root, &title, &media_id, ep_number) {
        let job = existing_done_job(
            &root,
            &plugin_id,
            &media_id,
            &episode_id,
            &playlist_id,
            ep_number,
            "episode",
            &title,
            &cover,
            total_eps,
            episodes.clone(),
        );
        host.jobs
            .lock()
            .map_err(|_| "download lock".to_string())?
            .insert(job.id.clone(), job.clone());
        let _ = save_manifest(&host, &job);
        emit_job(&host, "upsert", &job);
        return Ok(json!(job));
    }
    if mode == "series" && (1..=total_eps).all(|e| episode_ready(&root, &title, &media_id, e)) {
        let job = existing_done_job(
            &root,
            &plugin_id,
            &media_id,
            &episode_id,
            &playlist_id,
            ep_number,
            "series",
            &title,
            &cover,
            total_eps,
            episodes.clone(),
        );
        host.jobs
            .lock()
            .map_err(|_| "download lock".to_string())?
            .insert(job.id.clone(), job.clone());
        let _ = save_manifest(&host, &job);
        emit_job(&host, "upsert", &job);
        return Ok(json!(job));
    }

    let job = DownloadJob {
        id: key.clone(),
        plugin_id: plugin_id.clone(),
        media_id: media_id.clone(),
        episode_id: episode_id.clone(),
        playlist_id: playlist_id.clone(),
        title: title.clone(),
        cover: cover.clone(),
        ep: if mode == "series" { 1 } else { ep_number },
        total_eps,
        mode: mode.to_string(),
        status: "queued".into(),
        progress: 0.0,
        message: "排队中".into(),
        playlist_path: String::new(),
        video_path: String::new(),
        file_size: 0,
        ready_eps: Vec::new(),
        episodes: episodes.clone(),
        updated_at: now_secs(),
    };
    host.jobs
        .lock()
        .map_err(|_| "download lock".to_string())?
        .insert(key.clone(), job.clone());
    let _ = save_manifest(&host, &job);
    emit_job(&host, "upsert", &job);

    let task = QueuedTask {
        key: key.clone(),
        manager: Some(manager),
        plugin_id,
        media_id,
        episode_id,
        playlist_id,
        title,
        ep: ep_number,
        mode: mode.to_string(),
        episodes,
        total_eps,
    };
    host.queue
        .lock()
        .map_err(|_| "download lock".to_string())?
        .push_back(task);
    kick_worker(host);

    Ok(json!(job))
}

fn existing_done_job(
    root: &Path,
    plugin_id: &str,
    media_id: &str,
    episode_id: &str,
    playlist_id: &str,
    ep: u32,
    mode: &str,
    title: &str,
    cover: &Value,
    total_eps: u32,
    episodes: Vec<EpisodeRef>,
) -> DownloadJob {
    let (mp4, ts, pl) = episode_media_files(root, title, media_id, ep);
    let path = if mp4.is_file() {
        mp4
    } else if ts.is_file() {
        ts
    } else {
        pl
    };
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let ready: Vec<u32> = if mode == "series" {
        (1..=total_eps).filter(|e| episode_ready(root, title, media_id, *e)).collect()
    } else {
        vec![ep]
    };
    DownloadJob {
        id: job_key(plugin_id, media_id, ep, mode),
        plugin_id: plugin_id.to_string(),
        media_id: media_id.to_string(),
        episode_id: episode_id.to_string(),
        playlist_id: playlist_id.to_string(),
        title: title.to_string(),
        cover: cover.clone(),
        ep,
        total_eps,
        mode: mode.to_string(),
        status: "done".into(),
        progress: 1.0,
        message: "已离线".into(),
        playlist_path: path.to_string_lossy().to_string(),
        video_path: path.to_string_lossy().to_string(),
        file_size: size,
        ready_eps: ready,
        episodes,
        updated_at: now_secs(),
    }
}

fn kick_worker(host: Arc<DownloadHost>) {
    if host
        .worker
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            if host.stopping.load(Ordering::SeqCst) {
                break;
            }
            let next = {
                let mut q = match host.queue.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                q.pop_front()
            };
            let Some(task) = next else { break };
            let _ = run_job(&host, task).await;
        }
        host.worker.store(false, Ordering::SeqCst);
        let has_more = host
            .queue
            .lock()
            .map(|q| !q.is_empty())
            .unwrap_or(false)
            && !host.stopping.load(Ordering::SeqCst);
        if has_more {
            kick_worker(host);
        }
    });
}

async fn resolve_manager(host: &DownloadHost, task: &QueuedTask) -> Result<Arc<PluginManager>, String> {
    if let Some(m) = task.manager.clone() {
        return Ok(m);
    }
    let handle = host
        .handle
        .lock()
        .ok()
        .and_then(|h| h.clone())
        .ok_or_else(|| "应用句柄未绑定".to_string())?;
    let plugin_host = handle.state::<PluginHost>();
    plugin_host
        .manager(&handle)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))
}

async fn run_job(host: &DownloadHost, task: QueuedTask) -> Result<(), String> {
    bump_job(host, &task.key, |j| {
        j.status = "running".into();
        j.message = "下载中".into();
        j.progress = 0.0;
    }, true);

    let manager = match resolve_manager(host, &task).await {
        Ok(m) => m,
        Err(e) => {
            bump_job(host, &task.key, |j| {
                j.status = "error".into();
                j.message = e.clone();
            }, true);
            return Err(e);
        }
    };

    let result = if task.mode == "series" {
        download_series(host, &task, &manager).await
    } else {
        let ep = EpisodeRef {
            id: task.episode_id.clone(),
            number: task.ep,
            label: String::new(),
        };
        download_one(host, &task, &manager, &ep, 0.0, 1.0).await.map(|_| ())
    };

    match &result {
        Ok(()) => bump_job(host, &task.key, |j| {
            j.status = "done".into();
            j.progress = 1.0;
            j.message = "已离线".into();
        }, true),
        Err(e) => bump_job(host, &task.key, |j| {
            j.status = "error".into();
            j.message = e.clone();
        }, true),
    }
    Ok(())
}

async fn download_series(
    host: &DownloadHost,
    task: &QueuedTask,
    manager: &Arc<PluginManager>,
) -> Result<(), String> {
    let n = task.total_eps.max(1);
    let mut list: Vec<EpisodeRef> = if task.episodes.is_empty() {
        (1..=n)
            .map(|e| EpisodeRef {
                id: e.to_string(),
                number: e,
                label: String::new(),
            })
            .collect()
    } else {
        task.episodes.clone()
    };
    // Jobs persisted by older builds may still carry 0-based numbering.
    if list.iter().any(|e| e.number == 0) {
        for e in &mut list {
            e.number += 1;
        }
    }
    // A whole-series download must cover every episode 1..=n — episode 1
    // included. Synthesize any missing entry (id defaults to the episode
    // number, the play-source convention) instead of silently dropping it.
    for num in 1..=n {
        if !list.iter().any(|e| e.number == num) {
            list.push(EpisodeRef {
                id: num.to_string(),
                number: num,
                label: String::new(),
            });
        }
    }
    list.sort_by_key(|e| e.number);
    for (idx, ep) in list.iter().enumerate() {
        let base_p = idx as f64 / n as f64;
        let span = 1.0 / n as f64;
        let root = root(host)?;
        if episode_ready(&root, &task.title, &task.media_id, ep.number) {
            bump_job(host, &task.key, |j| {
                j.ep = ep.number;
                j.progress = (idx + 1) as f64 / n as f64;
                j.message = format!("跳过已下载 {}/{n}", ep.number);
            }, false);
            continue;
        }
        bump_job(host, &task.key, |j| {
            j.ep = ep.number;
            j.message = format!("下载 {}/{n}", idx + 1);
        }, false);
        download_one(host, task, manager, ep, base_p, span).await?;
        bump_job(host, &task.key, |j| {
            j.ep = ep.number;
            j.progress = (idx + 1) as f64 / n as f64;
            j.message = format!("已下载 {}/{n}", ep.number);
        }, false);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn download_one(
    host: &DownloadHost,
    task: &QueuedTask,
    manager: &Arc<PluginManager>,
    ep: &EpisodeRef,
    progress_base: f64,
    progress_span: f64,
) -> Result<PathBuf, String> {
    let root = root(host)?;
    let retries = retries(host);
    if episode_ready(&root, &task.title, &task.media_id, ep.number) {
        let (mp4, ts, pl) = episode_media_files(&root, &task.title, &task.media_id, ep.number);
        let path = if mp4.is_file() { mp4 } else if ts.is_file() { ts } else { pl };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        bump_job(host, &task.key, |j| {
            j.ep = ep.number;
            j.video_path = path.to_string_lossy().to_string();
            j.playlist_path = path.to_string_lossy().to_string();
            j.file_size = size;
            j.message = format!("第 {} 集已离线", ep.number);
        }, false);
        return Ok(path);
    }

    bump_job(host, &task.key, |j| j.message = format!("获取播放地址 · 第 {} 集", ep.number), false);
    let (url, headers) = resolve_stream(
        manager,
        &task.plugin_id,
        &task.media_id,
        &ep.id,
        &task.playlist_id,
    )
    .await?;

    let dir = episode_dir(&root, &task.title, &task.media_id, ep.number);
    let dir = safe_under_root(&root, &dir)?;
    let _ = std::fs::create_dir_all(&dir);

    bump_job(host, &task.key, |j| j.message = format!("获取播放清单 · 第 {} 集", ep.number), false);
    let playlist_bytes = fetch_bytes(manager, &task.plugin_id, &url, &headers, retries).await?;
    let playlist_text = String::from_utf8_lossy(&playlist_bytes).to_string();
    if !playlist_text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("播放地址返回的不是 HLS 清单".to_string());
    }
    let base_url = Url::parse(&url).map_err(|e| e.to_string())?;

    let (playlist_text, base_url) =
        resolve_media_playlist(host, &task.key, manager, &task.plugin_id, &headers, playlist_text, base_url, ep.number)
            .await?;

    let mut out_lines = Vec::new();
    let mut downloads: Vec<(String, String)> = Vec::new();
    for line in playlist_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            if let Some(rewritten) = rewrite_attr_uris(line, &base_url, &mut downloads) {
                out_lines.push(rewritten);
            } else {
                out_lines.push(line.to_string());
            }
            continue;
        }
        let abs = base_url.join(trimmed).map_err(|e| e.to_string())?;
        let name = local_name(downloads.len(), abs.as_str());
        downloads.push((abs.to_string(), name.clone()));
        out_lines.push(name);
    }

    if downloads.is_empty() {
        return Err("清单中没有媒体分片".to_string());
    }

    let fetch_span = progress_span * 0.85;
    let mux_span = progress_span * 0.15;
    let total = downloads.len() as f64;
    for (i, (seg_url, name)) in downloads.iter().enumerate() {
        let bytes = fetch_bytes(manager, &task.plugin_id, seg_url, &headers, retries).await?;
        write_atomic(&dir, &name, &bytes)?;
        let pct = (i + 1) as f64 / total;
        bump_job(host, &task.key, |j| {
            j.ep = ep.number;
            j.progress = progress_base + fetch_span * pct;
            j.message = format!("第 {} 集 · {}/{}", ep.number, i + 1, downloads.len());
        }, false);
    }

    let index_path = dir.join("index.m3u8");
    let local_playlist = out_lines.join("\n") + "\n";
    write_atomic(&dir, "index.m3u8", local_playlist.as_bytes())?;

    bump_job(host, &task.key, |j| {
        j.ep = ep.number;
        j.message = format!("解密合并 · 第 {} 集", ep.number);
        j.progress = progress_base + fetch_span;
    }, false);

    // The converted MP4 is placed in the per-video TOP folder, next to (not
    // inside) the episode subfolder: `<标题>/<标题>-x.mp4`.
    let mp4_path = media_dir(&root, &task.title, &task.media_id).join(format!(
        "{}-{}.mp4",
        media_folder_name(&task.title, &task.media_id),
        ep.number
    ));
    let video_path = finalize_episode(
        host,
        &task.key,
        &dir,
        &mp4_path,
        &local_playlist,
        progress_base + fetch_span,
        mux_span,
    )?;
    let size = std::fs::metadata(&video_path).map(|m| m.len()).unwrap_or(0);

    bump_job(host, &task.key, |j| {
        j.ep = ep.number;
        j.playlist_path = index_path.to_string_lossy().to_string();
        j.video_path = video_path.to_string_lossy().to_string();
        j.file_size = size;
        j.progress = progress_base + progress_span;
        j.message = format!("第 {} 集已可离线", ep.number);
    }, false);
    // Scoped storage: publish the finished MP4 into the shared collection and
    // record it on the job (failure keeps the private copy + a status note).
    #[cfg(target_os = "android")]
    publish_episode(host, &task.key, ep.number, &video_path).await;
    Ok(video_path)
}

/// Publish one finished episode MP4 into the shared `Movies/video-hub`
/// collection and record the content URI on the job. On success the private
/// working copy is removed (the shared copy is authoritative); on failure the
/// private copy stays and the job message explains why.
#[cfg(target_os = "android")]
async fn publish_episode(host: &DownloadHost, job_id: &str, ep: u32, video_path: &Path) {
    let Some(bridge) = host.media_bridge() else { return };
    let Some(name) = video_path.file_name().and_then(|n| n.to_str()) else { return };
    match bridge.publish_to_movies(&video_path.to_string_lossy(), name).await {
        Ok((uri, public_path)) => {
            let _ = std::fs::remove_file(video_path);
            bump_job(host, job_id, |j| {
                j.published.insert(ep, PublishedFile { uri, public_path });
                j.message = format!("第 {} 集已离线 · 已发布到 Movies/video-hub", ep);
            }, true);
        }
        Err(e) => {
            let note = if e.contains("NEED_WRITE_PERMISSION") {
                format!("第 {ep} 集已生成；发布到公共目录需要存储写权限，可稍后点击「重新发布」")
            } else {
                format!("第 {ep} 集已离线；发布到公共目录失败：{e}")
            };
            bump_job(host, job_id, |j| {
                j.message = note;
            }, true);
        }
    }
}

/// Write a file via a temporary sibling and rename over the target, so a crash
/// mid-write leaves no half-finished segment in place.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())
}

async fn resolve_media_playlist(
    host: &DownloadHost,
    job_id: &str,
    manager: &PluginManager,
    plugin_id: &str,
    headers: &Value,
    text: String,
    base: Url,
    ep: u32,
) -> Result<(String, Url), String> {
    let has_segments = text.lines().any(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with('#') && !t.contains(".m3u8")
    });
    if has_segments {
        return Ok((text, base));
    }
    let variant = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#') && l.contains(".m3u8"))
        .ok_or_else(|| "母清单没有可下载的清晰度".to_string())?;
    let abs = base.join(variant).map_err(|e| e.to_string())?;
    bump_job(host, job_id, |j| j.message = format!("跟随媒体清单 · 第 {ep} 集"), false);
    let bytes = fetch_bytes(manager, plugin_id, abs.as_str(), headers, retries(host)).await?;
    let media = String::from_utf8_lossy(&bytes).to_string();
    if !media.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("变体清单无效".to_string());
    }
    Ok((media, abs))
}

fn local_name(idx: usize, url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path
        .rsplit('.')
        .next()
        .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("bin");
    format!("seg_{idx:04}.{ext}")
}

fn rewrite_attr_uris(
    line: &str,
    base: &Url,
    downloads: &mut Vec<(String, String)>,
) -> Option<String> {
    if !line.contains("URI=\"") {
        return None;
    }
    let mut out = String::new();
    let mut rest = line;
    while let Some(i) = rest.find("URI=\"") {
        out.push_str(&rest[..i + 5]);
        rest = &rest[i + 5..];
        let end = rest.find('"')?;
        let uri = &rest[..end];
        rest = &rest[end..];
        if let Ok(abs) = base.join(uri) {
            let name = local_name(downloads.len(), abs.as_str());
            downloads.push((abs.to_string(), name.clone()));
            out.push_str(&name);
        } else {
            out.push_str(uri);
        }
    }
    out.push_str(rest);
    Some(out)
}

// ---------------------------------------------------------------------------
// Decryption / merge / remux
// ---------------------------------------------------------------------------

fn finalize_episode(
    host: &DownloadHost,
    job_id: &str,
    dir: &Path,
    mp4_path: &Path,
    local_playlist: &str,
    progress_base: f64,
    progress_span: f64,
) -> Result<PathBuf, String> {
    let key_info = parse_hls_key_in_dir(local_playlist, dir);
    let media_seq = parse_media_sequence(local_playlist);
    let segments: Vec<String> = local_playlist
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect();
    if segments.is_empty() {
        return Err("没有可合并的分片".to_string());
    }

    let ts_path = dir.join("video.ts");
    let mut out = std::fs::File::create(&ts_path).map_err(|e| e.to_string())?;
    use std::io::Write;
    let n = segments.len().max(1) as f64;
    for (i, name) in segments.iter().enumerate() {
        let raw = std::fs::read(dir.join(name)).map_err(|e| format!("读取 {name}: {e}"))?;
        let plain = if let Some((key, iv_opt)) = key_info.as_ref() {
            let mut iv = iv_opt.unwrap_or([0u8; 16]);
            if iv_opt.is_none() {
                iv = seq_iv(media_seq.wrapping_add(i as u64));
            }
            aes128_cbc_decrypt(&raw, key, &iv).ok_or_else(|| format!("解密失败 {name}"))?
        } else {
            raw
        };
        out.write_all(&plain).map_err(|e| e.to_string())?;
        bump_job(host, job_id, |j| {
            j.progress = progress_base + progress_span * ((i + 1) as f64 / n) * 0.7;
            j.message = format!("合并 {}/{}", i + 1, n as u32);
        }, false);
    }
    drop(out);

    if ffmpeg_bin(host).is_some() {
        bump_job(host, job_id, |j| {
            j.progress = progress_base + progress_span * 0.75;
            j.message = "转封装 MP4".into();
        }, false);
        if try_ffmpeg_remux(host, &ts_path, mp4_path) {
            // Remux succeeded: the MP4 is the final artifact. Drop every
            // pre-merge file — downloaded segments, the local playlist and the
            // merged TS (unless the user opted to keep it). `job.json` stays so
            // the record survives restarts. A failed removal never fails the
            // MP4 result.
            let keep = keep_ts(host);
            if !keep {
                let _ = std::fs::remove_file(&ts_path);
            }
            cleanup_episode_dir(dir, &ts_path, keep);
            bump_job(host, job_id, |j| {
                j.progress = progress_base + progress_span;
                j.message = if keep { "MP4 已就绪（保留 TS）".into() } else { "MP4 已就绪".into() };
            }, false);
            return Ok(mp4_path.to_path_buf());
        }
    }

    bump_job(host, job_id, |j| {
        j.progress = progress_base + progress_span;
        j.message = if ffmpeg_bin(host).is_none() {
            "TS 已就绪 · 未检测到 FFmpeg，无法转封装 MP4".into()
        } else {
            "TS 已就绪 · MP4 转封装失败，已保留 TS".into()
        };
    }, false);
    Ok(ts_path)
}

/// Wipe every pre-merge artifact inside an episode working folder after the
/// MP4 has been produced: downloaded segments, leftover `.tmp` files, the
/// local playlist and HLS key files. `job.json` is kept so the download
/// record survives restarts, and the merged `video.ts` is kept when the user
/// opted into `keep_ts`. The episode folder is app-owned, so a sweep is safe.
fn cleanup_episode_dir(dir: &Path, ts_path: &Path, keep_ts: bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(p);
            continue;
        }
        if keep_ts && p == ts_path {
            continue;
        }
        if p.file_name().and_then(|n| n.to_str()) == Some("job.json") {
            continue;
        }
        let _ = std::fs::remove_file(p);
    }
}

/// Remove the duplicated-path artifact left by the pre-fix `safe_under_root`:
/// a literal `<root>/storage/emulated/0/Movies/video-hub` chain inside the
/// download root. That chain can never be produced by legitimate media
/// folders (titles are sanitized and cannot contain `/`), so matching it
/// exactly is safe. Empty parents are pruned up to (not including) the root.
#[cfg(target_os = "android")]
fn cleanup_legacy_nested_root(root: &Path) {
    let artifact = root.join("storage/emulated/0/Movies/video-hub");
    if !artifact.is_dir() {
        return;
    }
    let _ = std::fs::remove_dir_all(&artifact);
    let mut cursor = artifact.parent().map(Path::to_path_buf);
    while let Some(dir) = cursor {
        if dir == root || !dir.starts_with(root) {
            break;
        }
        // remove_dir fails on non-empty dirs, which stops the prune.
        if std::fs::remove_dir(&dir).is_err() {
            break;
        }
        cursor = dir.parent().map(Path::to_path_buf);
    }
}

fn parse_media_sequence(playlist: &str) -> u64 {
    for line in playlist.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            if let Ok(n) = rest.trim().parse::<u64>() {
                return n;
            }
        }
    }
    0
}

fn parse_hls_key_in_dir(playlist: &str, dir: &Path) -> Option<([u8; 16], Option<[u8; 16]>)> {
    for line in playlist.lines() {
        let t = line.trim();
        if !t.starts_with("#EXT-X-KEY:") {
            continue;
        }
        let attrs = &t["#EXT-X-KEY:".len()..];
        let method = attr_value(attrs, "METHOD").unwrap_or_default();
        if method.eq_ignore_ascii_case("NONE") || method.is_empty() {
            return None;
        }
        if !method.to_ascii_uppercase().contains("AES-128") {
            continue;
        }
        let uri = attr_value(attrs, "URI")?;
        let key_name = uri.trim_matches('"');
        let key_bytes = std::fs::read(dir.join(key_name)).ok()?;
        if key_bytes.len() < 16 {
            return None;
        }
        let mut key = [0u8; 16];
        key.copy_from_slice(&key_bytes[..16]);
        let iv = attr_value(attrs, "IV").and_then(|s| parse_iv(&s));
        return Some((key, iv));
    }
    None
}

fn attr_value(attrs: &str, key: &str) -> Option<String> {
    for part in attrs.split(',') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix(&format!("{key}=")) {
            return Some(rest.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn parse_iv(raw: &str) -> Option<[u8; 16]> {
    let s = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn seq_iv(seq: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..].copy_from_slice(&seq.to_be_bytes());
    iv
}

fn aes128_cbc_decrypt(data: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(key).ok()?;
    let mut prev = *iv;
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    let pad = *out.last()? as usize;
    if pad > 0 && pad <= 16 && out.len() >= pad && out[out.len() - pad..].iter().all(|b| *b as usize == pad) {
        out.truncate(out.len() - pad);
    }
    Some(out)
}

/// Resolved FFmpeg executable plus the optional directory holding its
/// shared-library dependencies (Android jniLibs extraction dir).
struct FfmpegBin {
    bin: PathBuf,
    lib_dir: Option<PathBuf>,
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn desktop_platform_dir() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows-x64"
    }
    #[cfg(target_os = "macos")]
    {
        if std::env::consts::ARCH == "aarch64" {
            "macos-arm64"
        } else {
            "macos-x64"
        }
    }
    #[cfg(target_os = "linux")]
    {
        "linux-x64"
    }
}

/// Locate FFmpeg: bundled copy first, system PATH as fallback. There is no
/// in-app download of a portable FFmpeg build.
///
/// Android: bundled `libffmpeg.so` lives in the extracted native library
/// directory; its libav* dependencies sit beside it, so the child process
/// receives `LD_LIBRARY_PATH` pointing there.
/// Desktop: staged per-platform copy under `<app_data>/tools/ffmpeg/<platform>/`,
/// then the legacy flat `tools/ffmpeg/` layout, then PATH.
fn ffmpeg_bin(host: &DownloadHost) -> Option<FfmpegBin> {
    #[cfg(target_os = "android")]
    {
        let dir = host.native_lib_dir.lock().ok().and_then(|d| d.clone())?;
        let bin = PathBuf::from(&dir).join("libffmpeg.so");
        if bin.is_file() {
            Some(FfmpegBin { bin, lib_dir: Some(PathBuf::from(dir)) })
        } else {
            None
        }
    }
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        #[cfg(target_os = "windows")]
        let name = "ffmpeg.exe";
        #[cfg(not(target_os = "windows"))]
        let name = "ffmpeg";
        let tools = host.app_data.join("tools").join("ffmpeg");
        let staged = tools.join(desktop_platform_dir()).join(name);
        if staged.is_file() {
            return Some(FfmpegBin { bin: staged, lib_dir: None });
        }
        let legacy = tools.join(name);
        if legacy.is_file() {
            return Some(FfmpegBin { bin: legacy, lib_dir: None });
        }
        path_ffmpeg().map(|bin| FfmpegBin { bin, lib_dir: None })
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn path_ffmpeg() -> Option<PathBuf> {
    #[cfg(windows)]
    let names = ["ffmpeg.exe", "ffmpeg"];
    #[cfg(not(windows))]
    let names = ["ffmpeg"];
    for name in names {
        let mut cmd = Command::new(name);
        cmd.arg("-version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if cmd.status().map(|s| s.success()).unwrap_or(false) {
            return Some(PathBuf::from(name));
        }
    }
    None
}

fn try_ffmpeg_remux(host: &DownloadHost, ts: &Path, mp4: &Path) -> bool {
    let Some(probe) = ffmpeg_bin(host) else {
        return false;
    };
    let mut cmd = Command::new(&probe.bin);
    if let Some(lib_dir) = &probe.lib_dir {
        cmd.env("LD_LIBRARY_PATH", lib_dir);
    }
    cmd.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        &ts.to_string_lossy(),
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        &mp4.to_string_lossy(),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    matches!(cmd.status(), Ok(st) if st.success()) && mp4.is_file()
}

// ---------------------------------------------------------------------------
// Listing / deletion / directory commands
// ---------------------------------------------------------------------------

fn read_job_file(path: &Path) -> Option<DownloadJob> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn list(host: &DownloadHost) -> Result<Value, String> {
    let base_dir = root(host)?;
    let mut by_id: HashMap<String, DownloadJob> = HashMap::new();
    if let Ok(series) = std::fs::read_dir(&base_dir) {
        for s in series.flatten() {
            let sp = s.path();
            if !sp.is_dir() {
                continue;
            }
            if let Some(job) = read_job_file(&sp.join("job.json")) {
                by_id.insert(job.id.clone(), job);
            }
            if let Ok(eps) = std::fs::read_dir(&sp) {
                for e in eps.flatten() {
                    let jp = e.path().join("job.json");
                    if let Some(job) = read_job_file(&jp) {
                        match by_id.get(&job.id) {
                            Some(prev) if prev.updated_at >= job.updated_at => {}
                            _ => {
                                by_id.insert(job.id.clone(), job);
                            }
                        }
                    }
                }
            }
        }
    }
    if let Ok(jobs) = host.jobs.lock() {
        for job in jobs.values() {
            by_id.insert(job.id.clone(), job.clone());
        }
    }

    for job in by_id.values_mut() {
        if job.mode == "series" {
            let n = job.total_eps.max(1);
            let mut ready = Vec::new();
            let mut total_size = 0u64;
            for ep in 1..=n {
                if !episode_ready(&base_dir, &job.title, &job.media_id, ep) {
                    continue;
                }
                ready.push(ep);
                let (mp4, ts, pl) = episode_media_files(&base_dir, &job.title, &job.media_id, ep);
                let path = if mp4.is_file() {
                    Some(mp4)
                } else if ts.is_file() {
                    Some(ts)
                } else if pl.is_file() {
                    Some(pl)
                } else {
                    None
                };
                if let Some(path) = path {
                    total_size += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                }
            }
            job.ready_eps = ready;
            job.file_size = total_size;
            continue;
        }
        let (mp4, ts, pl) = episode_media_files(&base_dir, &job.title, &job.media_id, job.ep);
        let has_video = mp4.is_file() || ts.is_file();
        let path = if mp4.is_file() {
            Some(mp4)
        } else if ts.is_file() {
            Some(ts)
        } else if pl.is_file() {
            Some(pl)
        } else {
            None
        };
        if let Some(path) = path {
            if job.video_path.is_empty() {
                job.video_path = path.to_string_lossy().to_string();
            }
            if job.file_size == 0 {
                job.file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            }
            if job.status == "running" && has_video {
                job.status = "done".into();
                job.progress = 1.0;
                job.message = "已离线".into();
            }
            job.ready_eps = vec![job.ep];
        }
    }

    let mut items: Vec<DownloadJob> = by_id.into_values().collect();
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(json!({
        "items": items,
        "dir": base_dir.to_string_lossy(),
    }))
}

pub fn delete(
    host: &DownloadHost,
    plugin_id: &str,
    media_id: &str,
    ep: Option<u32>,
) -> Result<Value, String> {
    let root = root(host)?;
    let title = media_title(host, &root, media_id);
    let removed: Vec<DownloadJob>;
    if let Some(ep) = ep {
        // The merged MP4 (the final artifact) sits in the top folder, outside
        // the episode dir — keep it. Only the episode working folder (download
        // segments, playlist, merged TS, manifest) is removed.
        let dir = episode_dir(&root, &title, media_id, ep);
        let dir = safe_under_root(&root, &dir)?;
        let _ = std::fs::remove_dir_all(dir);
        let Ok(mut jobs) = host.jobs.lock() else {
            return Ok(json!({ "ok": true }));
        };
        removed = jobs
            .extract_if(|_, j| j.plugin_id == plugin_id && j.media_id == media_id && j.ep == ep)
            .map(|(_, j)| j)
            .collect();
    } else {
        // Whole media: keep every merged MP4 in the top folder, remove all
        // episode working folders and every non-MP4 artifact (manifests etc.).
        let dir = media_dir(&root, &title, media_id);
        let dir = safe_under_root(&root, &dir)?;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let _ = std::fs::remove_dir_all(p);
                } else if p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("mp4")) != Some(true) {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        let Ok(mut jobs) = host.jobs.lock() else {
            return Ok(json!({ "ok": true }));
        };
        removed = jobs
            .extract_if(|_, j| j.plugin_id == plugin_id && j.media_id == media_id)
            .map(|(_, j)| j)
            .collect();
    }
    for job in &removed {
        emit_job(host, "remove", job);
    }
    Ok(json!({ "ok": true, "removed": removed.len() }))
}

pub fn current_dir(host: &DownloadHost) -> Result<String, String> {
    Ok(root(host)?.to_string_lossy().to_string())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub fn set_dir(host: &DownloadHost, path: &str) -> Result<Value, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("文件夹路径为空".into());
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err("请选择绝对路径的文件夹".into());
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("无法创建文件夹: {e}"))?;
    let probe = p.join(".hghub_write_test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("文件夹不可写: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    {
        let Ok(mut config) = host.config.lock() else {
            return Err("download lock".into());
        };
        config.dir = Some(p.to_string_lossy().to_string());
    }
    persist_config(host)?;
    if let Ok(mut g) = host.root.lock() {
        *g = Some(p.clone());
    }
    emit_dir(host);
    Ok(json!({ "dir": p.to_string_lossy() }))
}

pub async fn reset_dir(host: &DownloadHost) -> Result<Value, String> {
    {
        let Ok(mut config) = host.config.lock() else {
            return Err("download lock".into());
        };
        config.dir = None;
    }
    persist_config(host)?;
    // Re-run storage resolution: an Android grant picks the public root, its
    // absence the private fallback; desktop falls back to app-data/downloads.
    host.refresh_storage().await;
    let dir = root(host)?.to_string_lossy().to_string();
    Ok(json!({ "dir": dir }))
}

/// Current download settings: effective root, platform default root, mode
/// (`public` | `fallback` | `custom`), a human-readable reason, retry count,
/// storage grant state and whether folder picking is supported.
pub async fn get_settings(host: &DownloadHost) -> Result<Value, String> {
    host.refresh_storage().await;
    let dir = root(host)?.to_string_lossy().to_string();
    let default_dir = host.default_dir_string();
    let mode = host.current_mode();
    let reason = host.current_reason();
    let retries = retries(host);
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let pickable = true;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let pickable = false;
    #[cfg(target_os = "android")]
    let manufacturer = match host.media_bridge() {
        Some(bridge) => bridge.manufacturer().await,
        None => None,
    };
    #[cfg(not(target_os = "android"))]
    let manufacturer: Option<String> = None;
    // Legacy write grant only matters on API <= 29 devices; API 30+ resolves
    // true without any permission. Surfaced so the UI can offer the runtime
    // request when a publish failed with NEED_WRITE_PERMISSION.
    #[cfg(target_os = "android")]
    let storage_granted = match host.media_bridge() {
        Some(bridge) => bridge.legacy_write_status().await,
        None => false,
    };
    #[cfg(not(target_os = "android"))]
    let storage_granted = true;
    Ok(json!({
        "dir": dir,
        "effectiveDir": dir,
        "defaultDir": default_dir,
        "externalDir": host.external_dir(),
        "mode": mode,
        "reason": reason,
        "manufacturer": manufacturer,
        "retries": retries,
        "mobile": !pickable,
        "storageGranted": storage_granted,
        "fallback": mode == "fallback",
        "keepTs": keep_ts(host),
    }))
}

/// Request the legacy runtime write grant (Android API <= 29 only; the
/// shared-collection publish needs it there). API 30+ resolves immediately.
pub fn set_retries(host: &DownloadHost, retries: u8) -> Result<Value, String> {
    let clamped = retries.clamp(0, 3);
    {
        let Ok(mut config) = host.config.lock() else {
            return Err("download lock".into());
        };
        config.retries = clamped;
    }
    persist_config(host)?;
    Ok(json!({ "retries": clamped }))
}

pub fn set_keep_ts(host: &DownloadHost, keep: bool) -> Result<Value, String> {
    {
        let Ok(mut config) = host.config.lock() else {
            return Err("download lock".into());
        };
        config.keep_ts = keep;
    }
    persist_config(host)?;
    Ok(json!({ "keepTs": keep }))
}

pub async fn request_legacy_write(host: &DownloadHost) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let Some(bridge) = host.media_bridge() else {
            return Err("媒体桥接尚未就绪".into());
        };
        bridge.request_legacy_write().await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = host;
        Ok(true)
    }
}

/// Re-publish finished episodes whose publish previously failed (e.g. the
/// runtime write grant was missing). Walks done jobs, publishing every
/// episode that has a private MP4 but no publish record yet.
pub async fn publish_pending(app: tauri::AppHandle, host: &DownloadHost) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let Some(bridge) = host.media_bridge() else {
            return Err("媒体桥接尚未就绪".into());
        };
        // Snapshot the re-publish targets: every done episode that still has a
        // private MP4 (publish failed earlier, e.g. missing runtime grant on
        // API <= 29) but no publish record.
        let targets: Vec<(String, u32, PathBuf)> = {
            let jobs = host.jobs.lock().map_err(|_| "download lock".to_string())?;
            let root = &host.default_root;
            let mut out = Vec::new();
            for j in jobs.values().filter(|j| j.status == "done") {
                let folder = media_folder_name(&j.title, &j.media_id);
                if j.mode == "series" {
                    for ep in &j.ready_eps {
                        let name = format!("{folder}-{ep}.mp4");
                        let p = root.join(&j.title).join(&name);
                        if p.is_file() && !j.published.contains_key(ep) {
                            out.push((j.id.clone(), *ep, p));
                        }
                    }
                } else {
                    let name = format!("{folder}-{}.mp4", j.ep);
                    let p = root.join(&j.title).join(&name);
                    if p.is_file() && !j.published.contains_key(&j.ep) {
                        out.push((j.id.clone(), j.ep, p));
                    }
                }
            }
            out
        };
        let mut published = 0usize;
        for (job_id, ep, path) in targets {
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            match bridge.publish_to_movies(&path.to_string_lossy(), &name).await {
                Ok((uri, public_path)) => {
                    // The shared copy is authoritative now; drop the private
                    // duplicate to keep the workdir lean.
                    let _ = std::fs::remove_file(&path);
                    bump_job(host, &job_id, |j| {
                        j.published.insert(ep, PublishedFile {
                            uri: uri.clone(),
                            public_path: public_path.clone(),
                        });
                    }, true);
                    published += 1;
                }
                Err(e) => {
                    bump_job(host, &job_id, |j| {
                        j.message = format!("发布到公共目录失败：{e}");
                    }, true);
                }
            }
        }
        let _ = app;
        Ok(json!({ "published": published }))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, host);
        Ok(json!({ "published": 0 }))
    }
}




pub async fn open_dir(app: &tauri::AppHandle, host: &DownloadHost) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // Scoped storage: the private working directory is invisible to file
        // managers, so "打开目录" targets the PUBLIC publish folder
        // (Movies/video-hub). The bridge locates the newest published MP4 in
        // MT Manager; without MT it falls back to a video viewer on that file.
        let newest_uri: Option<String> = {
            let jobs = host.jobs.lock().map_err(|_| "download lock".to_string())?;
            let mut best: Option<(u64, String)> = None;
            for j in jobs.values() {
                for p in j.published.values() {
                    let at = j.updated_at;
                    if best.as_ref().map_or(true, |(t, _)| at > *t) {
                        best = Some((at, p.uri.clone()));
                    }
                }
            }
            best.map(|(_, uri)| uri)
        };
        let unused = newest_uri.is_none();
        if let Some(bridge) = host.media_bridge() {
            if let Some(uri) = newest_uri.as_deref() {
                if bridge.open_in_manager(Some(uri)).await.is_ok() {
                    return Ok(());
                }
            }
        }
        let _ = unused;
        return Err("暂无已发布的视频：完成一次下载后 MP4 会出现在 Movies/video-hub".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let dir = root(host)?;
        let path = dir.to_string_lossy().to_string();
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|e| e.to_string())
    }
}

pub async fn open_file(
    app: &tauri::AppHandle,
    host: &DownloadHost,
    plugin_id: &str,
    media_id: &str,
    ep: Option<u32>,
) -> Result<(), String> {
    let root = root(host)?;
    // Published episodes: open the shared copy via its content URI — every
    // player can read it, no FileProvider dance required.
    #[cfg(target_os = "android")]
    {
        let hit: Option<String> = {
            let jobs = host.jobs.lock().map_err(|_| "download lock".to_string())?;
            jobs.values()
                .find(|j| j.plugin_id == plugin_id && j.media_id == media_id)
                .and_then(|j| {
                    let ep_num = ep.unwrap_or(j.ep);
                    j.published.get(&ep_num).map(|p| p.uri.clone())
                })
        };
        if let Some(uri) = hit {
            let bridge = host.media_bridge().ok_or_else(|| "媒体桥接尚未就绪".to_string())?;
            return bridge.open_published(&uri).await;
        }
    }
    let path = if let Some(ep) = ep {
        let title = media_title(host, &root, media_id);
        let (mp4, ts, pl) = episode_media_files(&root, &title, media_id, ep);
        if mp4.is_file() {
            Some(mp4)
        } else if ts.is_file() {
            Some(ts)
        } else if pl.is_file() {
            Some(pl)
        } else {
            None
        }
    } else {
        let jobs = host.jobs.lock().map_err(|_| "download lock".to_string())?;
        jobs.values()
            .find(|j| j.plugin_id == plugin_id && j.media_id == media_id)
            .map(|j| PathBuf::from(j.video_path.clone()))
            .filter(|p| !p.as_os_str().is_empty())
    };
    let Some(path) = path else {
        return Err("成品文件不存在".into());
    };
    let path = safe_under_root(&root, &path)?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn download_start(
    app: tauri::AppHandle,
    host: tauri::State<'_, PluginHost>,
    dl: tauri::State<'_, Arc<DownloadHost>>,
    plugin_id: String,
    media_id: String,
    episode_id: Option<String>,
    playlist_id: Option<String>,
    ep: Option<u32>,
    mode: String,
) -> Result<Value, String> {
    let manager = host.manager(&app).await.map_err(|e| e.to_string())?;
    let dl = dl.inner().clone();
    start(
        dl,
        manager,
        plugin_id,
        media_id,
        episode_id,
        playlist_id,
        ep,
        mode,
    )
    .await
}

#[tauri::command]
pub fn download_list(dl: tauri::State<'_, Arc<DownloadHost>>) -> Result<Value, String> {
    list(dl.inner())
}

#[tauri::command]
pub fn download_delete(
    dl: tauri::State<'_, Arc<DownloadHost>>,
    plugin_id: String,
    media_id: String,
    ep: Option<u32>,
) -> Result<Value, String> {
    delete(dl.inner(), &plugin_id, &media_id, ep)
}

#[tauri::command]
pub fn download_dir(dl: tauri::State<'_, Arc<DownloadHost>>) -> Result<Value, String> {
    Ok(json!({ "dir": current_dir(dl.inner())? }))
}

#[tauri::command]
pub async fn download_reset_dir(dl: tauri::State<'_, Arc<DownloadHost>>) -> Result<Value, String> {
    reset_dir(dl.inner()).await
}

#[tauri::command]
pub async fn download_open_dir(
    app: tauri::AppHandle,
    dl: tauri::State<'_, Arc<DownloadHost>>,
) -> Result<(), String> {
    open_dir(&app, dl.inner()).await
}

#[tauri::command]
pub async fn download_open_file(
    app: tauri::AppHandle,
    dl: tauri::State<'_, Arc<DownloadHost>>,
    plugin_id: String,
    media_id: String,
    ep: Option<u32>,
) -> Result<(), String> {
    open_file(&app, dl.inner(), &plugin_id, &media_id, ep).await
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub async fn download_pick_dir(
    app: tauri::AppHandle,
    dl: tauri::State<'_, Arc<DownloadHost>>,
) -> Result<Value, String> {
    let current = current_dir(dl.inner()).ok();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(cur) = current.as_ref() {
            dialog = dialog.set_directory(PathBuf::from(cur));
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    match picked {
        Some(file) => {
            let path = file.to_string();
            set_dir(dl.inner(), &path)
        }
        None => Ok(Value::Null),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn download_pick_dir() -> Result<Value, String> {
    Err("移动端不支持任意选择目录；下载目录由系统授权状态决定".into())
}

#[tauri::command]
pub async fn download_get_settings(dl: tauri::State<'_, Arc<DownloadHost>>) -> Result<Value, String> {
    get_settings(dl.inner()).await
}

#[tauri::command]
pub async fn download_request_legacy_write(
    dl: tauri::State<'_, Arc<DownloadHost>>,
) -> Result<bool, String> {
    request_legacy_write(dl.inner()).await
}

#[tauri::command]
pub async fn download_publish_pending(
    app: tauri::AppHandle,
    dl: tauri::State<'_, Arc<DownloadHost>>,
) -> Result<Value, String> {
    publish_pending(app, dl.inner()).await
}

#[tauri::command]
pub fn download_set_retries(
    dl: tauri::State<'_, Arc<DownloadHost>>,
    retries: u8,
) -> Result<Value, String> {
    set_retries(dl.inner(), retries)
}

#[tauri::command]
pub fn download_set_keep_ts(
    dl: tauri::State<'_, Arc<DownloadHost>>,
    keep: bool,
) -> Result<Value, String> {
    set_keep_ts(dl.inner(), keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "android"))]
    #[tokio::test]
    async fn desktop_settings_expose_effective_default_mode_and_reason() {
        let dir = tempfile::tempdir().unwrap();
        let host = DownloadHost::new(dir.path().to_path_buf());
        let settings = get_settings(&host).await.unwrap();
        let expected_default = dir.path().join("downloads").to_string_lossy().into_owned();
        assert_eq!(settings["defaultDir"].as_str().unwrap(), expected_default);
        assert_eq!(settings["effectiveDir"].as_str().unwrap(), expected_default);
        assert_eq!(settings["dir"].as_str().unwrap(), expected_default);
        assert_eq!(settings["mode"].as_str().unwrap(), "public");
        assert!(!settings["reason"].as_str().unwrap().is_empty());
        assert_eq!(settings["fallback"], json!(false));
        assert_eq!(settings["storageGranted"], json!(true));
    }

    #[cfg(target_os = "android")]
    #[test]
    fn android_public_root_is_publish_target_only() {
        // The constant is the MediaStore publish target (display/legacy copy
        // path), never the download working directory.
        assert_eq!(ANDROID_PUBLIC_ROOT, "/storage/emulated/0/Movies/video-hub");
        assert!(ANDROID_PUBLIC_ROOT.starts_with("Movies/") || ANDROID_PUBLIC_ROOT.contains("/Movies/"));
    }
}
