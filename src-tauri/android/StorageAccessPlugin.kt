package com.videohub.player

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.annotation.Keep
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * All-files access bridge for the download module.
 *
 * Android 10+ scoped storage blocks direct writes to a public shared folder.
 * The app requests `MANAGE_EXTERNAL_STORAGE` (side-loaded distribution; see
 * docs/PHASE2-DOWNLOAD.md), then checks `Environment.isExternalStorageManager()`
 * and can route the user to the system all-files settings page. Only system
 * intents are used here; no network channel and no WebView file access.
 */
@Keep
@TauriPlugin
class StorageAccessPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun isManager(invoke: Invoke) {
        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            // Legacy <= API 29 installs wrote through WRITE_EXTERNAL_STORAGE; the
            // host treats this path as granted when the legacy permission exists.
            true
        }
        invoke.resolve(JSObject().put("granted", granted))
    }

    /**
     * Open the system all-files-access settings page, with a three-tier
     * fallback per Android vendor / skin:
     *
     * 1. `ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION` with our own package
     *    data URI — lands directly on this app's grant page on API 30+.
     * 2. `ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION` — the generic all-files
     *    access list when the app-specific intent is unavailable.
     * 3. `ACTION_APPLICATION_DETAILS_SETTINGS` — the app details page as a last
     *    resort, where the user can reach the permission / special-access menu.
     *
     * The resolved route action is returned so the host can record which page
     * opened. A real `ActivityNotFoundException` falls through to the next
     * scheme; rejection only happens when none launched.
     */
    @Command
    fun openAllFilesSettings(invoke: Invoke) {
        val packageUri = Uri.parse("package:${activity.packageName}")
        val schemes = listOf(
            Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, packageUri)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        var lastError: Exception? = null
        for (intent in schemes) {
            try {
                activity.startActivity(intent)
                invoke.resolve(JSObject().put("route", intent.action ?: "opened"))
                return
            } catch (error: Exception) {
                lastError = error
                continue
            }
        }
        invoke.reject(lastError?.message ?: "未找到可用的文件访问授权设置页")
    }

    /** OEM manufacturer string, used by the host to tailor the guidance copy. */
    @Command
    fun getManufacturer(invoke: Invoke) {
        invoke.resolve(JSObject().put("manufacturer", Build.MANUFACTURER ?: ""))
    }

    @Command
    fun getNativeLibraryDir(invoke: Invoke) {
        invoke.resolve(JSObject().put("dir", activity.applicationInfo.nativeLibraryDir))
    }
}
