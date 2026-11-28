// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

package app.tauri.opener

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import androidx.core.net.toUri
import app.tauri.annotation.InvokeArg
import java.io.File

@InvokeArg
class OpenArgs {
  lateinit var url: String
  var with: String? = null
}

// video-hub: local files must be shared through the app's FileProvider; a raw
// filesystem path is not a valid ACTION_VIEW data URI on Android 7+.
@InvokeArg
class OpenPathArgs {
  var path: String? = null
  var with: String? = null
}

// video-hub: directory open request (MT Manager first, generic viewer fallback).
@InvokeArg
class OpenDirArgs {
  var path: String? = null
}

@TauriPlugin
class OpenerPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun open(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OpenArgs::class.java)

            if (args.with == "inAppBrowser") {
                val builder = CustomTabsIntent.Builder()
                val intent = builder.build()
                intent.launchUrl(activity, args.url.toUri())
            } else {
                val intent = Intent(Intent.ACTION_VIEW, args.url.toUri())
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.applicationContext?.startActivity(intent)
            }
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message)
        }
    }

    @Command
    fun openPath(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OpenPathArgs::class.java)
            val path = args.path ?: throw IllegalStateException("缺少文件路径")
            val file = File(path)
            if (!file.exists()) {
                throw IllegalStateException("文件不存在：$path")
            }
            if (file.isDirectory) {
                throw IllegalStateException("Android 无法直接打开目录，请用文件管理器访问：$path")
            }
            val extension = file.extension.lowercase()
            val mime = when (extension) {
                "mp4", "m4v" -> "video/mp4"
                "ts" -> "video/mp2t"
                "m3u8", "m3u" -> "application/x-mpegURL"
                "webm" -> "video/webm"
                else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
            }
            val authority = activity.packageName + ".fileprovider"
            val uri = FileProvider.getUriForFile(activity, authority, file)
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.applicationContext?.startActivity(intent)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message)
        }
    }

    // video-hub: open a directory in MT Manager (bin.mt.plus). Uses MT's
    // documented external-call shortcut interface (ACTION_SHORTCUT +
    // operation=locate + path), which accepts a plain filesystem path and
    // needs no FileProvider. MT's locate semantic stops at the parent of a
    // folder (highlighting it), so pointing it at the download root lands one
    // level short (Movies). Instead we locate a marker FILE inside the
    // requested directory: whether MT locates by opening the parent or by
    // entering the target, the visible result is the download root itself.
    // When MT is not installed, falls back to a generic folder ACTION_VIEW
    // through the app's FileProvider; if nothing handles it, the call rejects
    // so Rust can fall back to `openPath`.
    @Command
    fun openDir(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OpenDirArgs::class.java)
            val path = args.path ?: throw IllegalStateException("缺少目录路径")
            val dir = File(path)
            if (!dir.isDirectory) {
                throw IllegalStateException("目录不存在：$path")
            }
            val marker = File(dir, ".video-hub-open")
            if (!marker.exists()) {
                try {
                    marker.createNewFile()
                } catch (_: Exception) {
                }
            }
            val locatePath = if (marker.exists()) marker.absolutePath else dir.absolutePath
            val mt = Intent("bin.mt.plus.ACTION_SHORTCUT").apply {
                component = ComponentName("bin.mt.plus", "bin.mt.plus.ShortcutActivity")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra("operation", "locate")
                putExtra("path", locatePath)
            }
            try {
                activity.applicationContext.startActivity(mt)
                invoke.resolve()
                return
            } catch (notFound: ActivityNotFoundException) {
                // MT Manager not installed — try any folder-capable viewer.
            }
            val authority = activity.packageName + ".fileprovider"
            val uri = FileProvider.getUriForFile(activity, authority, dir)
            val view = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "resource/folder")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.applicationContext.startActivity(view)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message)
        }
    }
}
