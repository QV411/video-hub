package com.videohub.player

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.Keep
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import androidx.core.content.FileProvider
import android.content.ActivityNotFoundException
import android.content.ComponentName
import java.io.File

/**
 * Scoped-storage media bridge for the download module (no all-files access).
 *
 * Working directory policy (TargetAPI 37, MANAGE_EXTERNAL_STORAGE removed):
 * - ALL intermediates and the remux staging MP4 live in the app-private
 *   directory (`context.getExternalFilesDir` / app-data `downloads`) — writable
 *   with zero permissions on every API level.
 * - The finished MP4 is PUBLISHED into the shared `Movies/video-hub`
 *   collection so any player / file manager can reach it:
 *     - API >= 30: `MediaStore` insert with `RELATIVE_PATH` — no permission.
 *     - API 29:    same MediaStore flow, but the shared-collection write needs
 *                  the runtime `WRITE_EXTERNAL_STORAGE` grant (requested on
 *                  demand via [requestLegacyWrite]).
 *     - API <= 28: direct `File` copy under `/storage/emulated/0/Movies/video-hub`
 *                  after the runtime grant (legacy storage model).
 * - Deleting a download record never touches the published MP4: it is the
 *   user's file in the shared collection. Only the private working copy and
 *   intermediates are removed by the Rust side.
 *
 * Only system APIs and system intents are used here; no network channel and
 * no WebView file access.
 */
@Keep
@TauriPlugin
class MediaBridgePlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /** Public publish folder (relative path inside the shared Movies collection). */
        const val PUBLIC_SUBDIR = "video-hub"
        /** Legacy absolute path for API <= 28 direct writes and UI copy. */
        const val LEGACY_PUBLIC_ROOT = "/storage/emulated/0/Movies/$PUBLIC_SUBDIR"
        private const val LEGACY_WRITE_PERMISSION = android.Manifest.permission.WRITE_EXTERNAL_STORAGE
    }

    @InvokeArg
    class PublishArgs {
        lateinit var srcPath: String
        lateinit var displayName: String
    }

    @InvokeArg
    class UriArgs {
        lateinit var uri: String
    }

    @InvokeArg
    class OpenArgs {
        var uri: String? = null
    }

    private fun hasLegacyWrite(): Boolean =
        ContextCompat.checkSelfPermission(activity, LEGACY_WRITE_PERMISSION) == PackageManager.PERMISSION_GRANTED

    /**
     * Runtime `WRITE_EXTERNAL_STORAGE` request for API <= 29 devices. The
     * system dialog appears once; the caller re-runs [publishToMovies] after
     * the user answers. On API 30+ this resolves immediately (not needed).
     */
    @Command
    fun requestLegacyWrite(invoke: Invoke) {
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.Q || hasLegacyWrite()) {
            invoke.resolve(JSObject().put("granted", true))
            return
        }
        activity.requestPermissions(arrayOf(LEGACY_WRITE_PERMISSION), 0x4847)
        // The dialog is async; report "requested" and let the host re-probe.
        invoke.resolve(JSObject().put("granted", hasLegacyWrite()).put("requested", true))
    }

    /** Whether the legacy write grant is currently held (always true on API 30+). */
    @Command
    fun legacyWriteStatus(invoke: Invoke) {
        val granted = Build.VERSION.SDK_INT > Build.VERSION_CODES.Q || hasLegacyWrite()
        invoke.resolve(JSObject().put("granted", granted))
    }

    /**
     * Publish a finished MP4 into the shared `Movies/video-hub` collection.
     * Same-name files previously published by this app are replaced (query +
     * delete before insert) so re-downloads never pile up ` (1)` duplicates.
     */
    @Command
    fun publishToMovies(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(PublishArgs::class.java)
            val src = File(args.srcPath)
            if (!src.isFile) throw IllegalStateException("源 MP4 不存在：${args.srcPath}")
            val name = args.displayName.ifBlank { src.name }

            val uri: Uri
            val publicPath: String
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q && !hasLegacyWrite()) {
                    invoke.reject("NEED_WRITE_PERMISSION")
                    return
                }
                val resolver = activity.contentResolver
                val collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                replaceOwnDuplicate(resolver, collection, name)
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, "Movies/$PUBLIC_SUBDIR")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                }
                val inserted = resolver.insert(collection, values)
                    ?: throw IllegalStateException("MediaStore 插入失败")
                resolver.openOutputStream(inserted)?.use { out ->
                    src.inputStream().use { input -> input.copyTo(out) }
                } ?: throw IllegalStateException("MediaStore 输出流打开失败")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                    resolver.update(inserted, done, null, null)
                }
                uri = inserted
                publicPath = queryData(resolver, inserted) ?: "$LEGACY_PUBLIC_ROOT/$name"
            } else {
                if (!hasLegacyWrite()) {
                    invoke.reject("NEED_WRITE_PERMISSION")
                    return
                }
                val dir = File(LEGACY_PUBLIC_ROOT)
                if (!dir.isDirectory && !dir.mkdirs()) throw IllegalStateException("公共目录创建失败：$LEGACY_PUBLIC_ROOT")
                val dest = File(dir, name)
                src.copyTo(dest, overwrite = true)
                uri = Uri.fromFile(dest)
                publicPath = dest.absolutePath
            }
            invoke.resolve(JSObject().put("uri", uri.toString()).put("publicPath", publicPath))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "发布到公共媒体库失败")
        }
    }

    /**
     * Delete a previously published MP4 (own content URIs only). Called
     * explicitly when the user chooses to also drop the shared copy; the
     * regular "清理下载记录" flow does NOT call this.
     */
    @Command
    fun deletePublished(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(UriArgs::class.java)
            val uri = Uri.parse(args.uri)
            val deleted = try {
                activity.contentResolver.delete(uri, null, null) > 0
            } catch (_: SecurityException) {
                false
            } catch (_: UnsupportedOperationException) {
                false
            }
            invoke.resolve(JSObject().put("deleted", deleted))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "删除公共媒体文件失败")
        }
    }

    /** Open a published MP4 (content URI) with any player via ACTION_VIEW. */
    @Command
    fun openPublished(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(UriArgs::class.java)
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.parse(args.uri), "video/mp4")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.applicationContext.startActivity(intent)
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法打开视频")
        }
    }

    /**
     * Open the public publish folder in MT Manager by locating the newest
     * published MP4 (its `_data` path). MT's locate semantic on a file lands
     * inside the folder, so the user sees `Movies/video-hub` directly.
     * Fallbacks: generic ACTION_VIEW on the MP4, then reject.
     */
    @Command
    fun openInManager(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OpenArgs::class.java)
            val path: String? = args.uri?.let { uri ->
                queryData(activity.contentResolver, Uri.parse(uri))
            }
            val locatePath = path?.takeIf { it.startsWith("/storage/emulated/0/Movies/$PUBLIC_SUBDIR/") }
                ?: findNewestPublishedFile()
            if (locatePath != null) {
                val mt = Intent("bin.mt.plus.ACTION_SHORTCUT").apply {
                    component = ComponentName("bin.mt.plus", "bin.mt.plus.ShortcutActivity")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    putExtra("operation", "locate")
                    putExtra("path", locatePath)
                }
                try {
                    activity.applicationContext.startActivity(mt)
                    invoke.resolve(JSObject().put("route", "mt"))
                    return
                } catch (_: ActivityNotFoundException) {
                    // MT Manager not installed — fall through.
                }
            }
            val target = locatePath?.let { File(it) }
            if (target != null && target.isFile) {
                val authority = activity.packageName + ".fileprovider"
                val view = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(FileProvider.getUriForFile(activity, authority, target), "video/mp4")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.applicationContext.startActivity(view)
                invoke.resolve(JSObject().put("route", "viewer"))
                return
            }
            invoke.reject("暂无已发布的视频，请先完成一次下载")
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法打开目录")
        }
    }

    /** Absolute path of the extracted native library directory (bundled ffmpeg). */
    @Command
    fun getNativeLibraryDir(invoke: Invoke) {
        invoke.resolve(JSObject().put("dir", activity.applicationInfo.nativeLibraryDir))
    }

    /** OEM manufacturer string for UI copy. */
    @Command
    fun getManufacturer(invoke: Invoke) {
        invoke.resolve(JSObject().put("manufacturer", Build.MANUFACTURER ?: ""))
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** Delete our own same-name entry in `Movies/video-hub` before re-publish. */
    private fun replaceOwnDuplicate(resolver: android.content.ContentResolver, collection: Uri, name: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Legacy path overwrites via copyTo(overwrite=true) instead.
            return
        }
        var cursor: Cursor? = null
        try {
            val selection = "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?"
            cursor = resolver.query(collection, arrayOf(MediaStore.MediaColumns._ID), selection,
                arrayOf("Movies/$PUBLIC_SUBDIR/", name), null)
            while (cursor?.moveToNext() == true) {
                val id = cursor.getLong(0)
                val dup = Uri.withAppendedPath(collection, id.toString())
                try { resolver.delete(dup, null, null) } catch (_: Exception) { /* keep inserting */ }
            }
        } catch (_: Exception) {
            // Dedup is best-effort; insert proceeds either way.
        } finally {
            cursor?.close()
        }
    }

    /** `_data` filesystem path of a MediaStore entry (readable for own files). */
    private fun queryData(resolver: android.content.ContentResolver, uri: Uri): String? {
        return try {
            resolver.query(uri, arrayOf(MediaStore.MediaColumns.DATA), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Newest MP4 under the publish folder via legacy scan (API <= 28 helper). */
    private fun findNewestPublishedFile(): String? {
        val dir = File(LEGACY_PUBLIC_ROOT)
        return dir.listFiles { f -> f.isFile && f.extension.equals("mp4", true) }
            ?.maxByOrNull { it.lastModified() }?.absolutePath
    }
}
