use serde::Deserialize;
use tauri::plugin::{mobile::PluginInvokeError, PluginHandle};

/// Bridge to the Android `MediaBridgePlugin`: scoped-storage publishing of
/// finished MP4s into the shared `Movies/video-hub` collection and the
/// folder-open intent. No all-files access involved. Non-Android builds use
/// stubbed fallbacks in `download.rs`; this module is compiled for
/// `target_os = "android"` only.
#[derive(Clone)]
pub struct AndroidMedia(pub PluginHandle<tauri::Wry>);

#[derive(Deserialize)]
struct PublishResult {
    uri: String,
    #[serde(default)]
    #[allow(dead_code)]
    public_path: String,
}

#[derive(Deserialize)]
struct NativeDir {
    dir: String,
}

#[derive(Deserialize)]
struct Manufacturer {
    manufacturer: String,
}

#[derive(Deserialize)]
struct BoolStatus {
    granted: bool,
    #[serde(default)]
    #[allow(dead_code)]
    requested: bool,
}

fn bridge_error(error: PluginInvokeError) -> String {
    match error {
        PluginInvokeError::InvokeRejected(reply) => {
            reply.message.clone().unwrap_or_else(|| "媒体桥接调用被拒绝".into())
        }
        other => format!("媒体桥接失败：{other}"),
    }
}

impl AndroidMedia {
    /// Publish the remuxed MP4 into the shared `Movies/video-hub` collection.
    /// Returns the MediaStore content URI plus the public display path.
    /// `NEED_WRITE_PERMISSION` rejections surface verbatim so the caller can
    /// trigger the legacy runtime-permission flow on API <= 29 devices.
    pub async fn publish_to_movies(&self, src_path: &str, display_name: &str) -> Result<(String, String), String> {
        self.0
            .run_mobile_plugin_async::<PublishResult>(
                "publishToMovies",
                serde_json::json!({ "srcPath": src_path, "displayName": display_name }),
            )
            .await
            .map(|r| (r.uri, r.public_path))
            .map_err(bridge_error)
    }

    /// Delete a published MP4 by content URI (own files only). Used by the
    /// explicit "also drop the shared copy" flow, never by record cleanup.
    #[allow(dead_code)]
    pub async fn delete_published(&self, uri: &str) -> Result<bool, String> {
        #[derive(Deserialize)]
        struct Deleted {
            deleted: bool,
        }
        self.0
            .run_mobile_plugin_async::<Deleted>("deletePublished", serde_json::json!({ "uri": uri }))
            .await
            .map(|r| r.deleted)
            .map_err(bridge_error)
    }

    /// Open a published MP4 with an external player via its content URI.
    #[allow(dead_code)]
    pub async fn open_published(&self, uri: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<()>("openPublished", serde_json::json!({ "uri": uri }))
            .await
            .map_err(bridge_error)
    }

    /// Open the public publish folder in a file manager (MT locate on the
    /// newest published MP4's path; generic viewer fallback).
    pub async fn open_in_manager(&self, uri: Option<&str>) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<()>("openInManager", serde_json::json!({ "uri": uri.unwrap_or_default() }))
            .await
            .map_err(bridge_error)
    }

    /// Request the legacy `WRITE_EXTERNAL_STORAGE` runtime grant (API <= 29
    /// devices only; resolves granted=true immediately on API 30+).
    pub async fn request_legacy_write(&self) -> Result<bool, String> {
        self.0
            .run_mobile_plugin_async::<BoolStatus>("requestLegacyWrite", ())
            .await
            .map(|r| r.granted)
            .map_err(bridge_error)
    }

    /// Whether the legacy write grant is held (always true on API 30+).
    pub async fn legacy_write_status(&self) -> bool {
        self.0
            .run_mobile_plugin_async::<BoolStatus>("legacyWriteStatus", ())
            .await
            .map(|r| r.granted)
            .unwrap_or(false)
    }

    /// Absolute path of the extracted native library directory
    /// (`applicationInfo.nativeLibraryDir`), where the bundled ffmpeg and its
    /// libav* dependencies are placed.
    pub async fn native_lib_dir(&self) -> Option<String> {
        self.0
            .run_mobile_plugin_async::<NativeDir>("getNativeLibraryDir", ())
            .await
            .ok()
            .map(|d| d.dir)
            .filter(|d| !d.is_empty())
    }

    /// OEM (`Build.MANUFACTURER`) for UI copy; `None` on bridge failure.
    pub async fn manufacturer(&self) -> Option<String> {
        self.0
            .run_mobile_plugin_async::<Manufacturer>("getManufacturer", ())
            .await
            .ok()
            .map(|m| m.manufacturer)
            .filter(|m| !m.is_empty())
    }
}
