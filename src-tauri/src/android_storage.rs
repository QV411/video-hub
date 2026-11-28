use serde::Deserialize;
use tauri::plugin::{mobile::PluginInvokeError, PluginHandle};

/// Bridge to the Android `StorageAccessPlugin`: all-files access check and the
/// system settings page intent. Non-Android builds use a stubbed fallback in
/// `download.rs`, so this module is compiled for `target_os = "android"` only.
#[derive(Clone)]
pub struct AndroidStorage(pub PluginHandle<tauri::Wry>);

#[derive(Deserialize)]
struct ManagerStatus {
    granted: bool,
}

#[derive(Deserialize)]
struct NativeDir {
    dir: String,
}

#[derive(Deserialize)]
struct Manufacturer {
    manufacturer: String,
}

fn bridge_error(error: PluginInvokeError) -> String {
    match error {
        PluginInvokeError::InvokeRejected(reply) => {
            reply.message.clone().unwrap_or_else(|| "无法读取文件访问权限状态".into())
        }
        other => format!("文件访问桥接失败：{other}"),
    }
}

impl AndroidStorage {
    /// Whether the app holds all-files access (`MANAGE_EXTERNAL_STORAGE`).
    /// On any bridge failure the caller treats this as *not granted* and falls
    /// back to the app-private downloads directory.
    pub async fn is_manager(&self) -> bool {
        self.0
            .run_mobile_plugin_async::<ManagerStatus>("isManager", ())
            .await
            .map(|status| status.granted)
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

    /// Open the system "All files access" settings page for this app.
    pub async fn open_settings(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<()>("openAllFilesSettings", ())
            .await
            .map_err(bridge_error)
    }

    /// OEM (`Build.MANUFACTURER`) for vendor-specific guidance copy; `None` on
    /// bridge failure so the UI falls back to the generic path.
    pub async fn manufacturer(&self) -> Option<String> {
        self.0
            .run_mobile_plugin_async::<Manufacturer>("getManufacturer", ())
            .await
            .ok()
            .map(|m| m.manufacturer)
            .filter(|m| !m.is_empty())
    }
}
