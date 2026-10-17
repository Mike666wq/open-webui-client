package local.openwebui.connectioncontrols

import android.app.Activity
import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.provider.DocumentsContract
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

private const val MAX_CHUNK_BYTES = 128 * 1024
private const val MAX_TRANSFER_BYTES = 2L * 1024 * 1024 * 1024
private const val MAX_BASE64_CHARS = ((MAX_CHUNK_BYTES + 2) / 3) * 4
private const val PICKER_EXPIRY_MS = 10 * 60 * 1000L
private const val LOG_TAG = "ConnectionControls"
private const val DIAGNOSTICS_FILE = "android-diagnostics.txt"

@InvokeArg
internal class ConfigureArgs {
    lateinit var settingsUrl: String
}

@InvokeArg
internal class BeginSaveArgs {
    lateinit var transferId: String
    lateinit var filename: String
    lateinit var mimeType: String
    var expectedBytes: Long? = null
}

@InvokeArg
internal class WriteChunkArgs {
    lateinit var transferId: String
    var sequence: Long = 0
    lateinit var chunkBase64: String
}

@InvokeArg
internal class TransferArgs {
    lateinit var transferId: String
}

private data class SaveTransfer(
    val uri: Uri,
    val output: OutputStream,
    val expectedBytes: Long?,
    var bytesWritten: Long = 0,
    var nextSequence: Long = 0,
)

@TauriPlugin
class ConnectionControlsPlugin(private val activity: Activity) : Plugin(activity) {
    private var settingsUri: Uri? = null
    private var backCallback: OnBackPressedCallback? = null
    private var webView: WebView? = null

    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lifecycleRing by lazy {
        LifecycleRing(File(activity.noBackupFilesDir, "android-lifecycle.log"))
    }
    private val ioExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "connection-controls-save-io").apply { isDaemon = true }
    }
    private val transfers = mutableMapOf<String, SaveTransfer>()
    private val cancelledTransfers = mutableSetOf<String>()
    private var pendingPickerTransferId: String? = null
    private var pendingPickerInvoke: Invoke? = null
    private var pendingPickerTimeout: Runnable? = null
    private var pendingDiagnosticsInvoke: Invoke? = null
    private var pendingDiagnosticsReport: String? = null
    private var pendingDiagnosticsTimeout: Runnable? = null
    private var pendingDiagnosticsExpired = false
    private var destroyed = false

    @Command
    fun configure(invoke: Invoke) {
        val args = invoke.parseArgs(ConfigureArgs::class.java)
        val uri = Uri.parse(args.settingsUrl)
        if (uri.scheme != "http" || uri.host != "tauri.localhost" || uri.port != -1) {
            invoke.reject("settingsUrl must be the Android bundled entry origin")
            return
        }
        settingsUri = uri
        invoke.resolve()
    }

    @Command
    fun saveBegin(invoke: Invoke) {
        val args = invoke.parseArgs(BeginSaveArgs::class.java)
        val expectedBytes = args.expectedBytes
        if (args.transferId.isBlank()) {
            invoke.reject("transferId is required")
            return
        }
        if (expectedBytes != null && (expectedBytes < 0L || expectedBytes > MAX_TRANSFER_BYTES)) {
            invoke.reject("expectedBytes must be between 0 and 2 GiB")
            return
        }

        val canStart = synchronized(lock) {
            if (destroyed || pendingPickerTransferId != null || pendingDiagnosticsInvoke != null || transfers.containsKey(args.transferId)) {
                false
            } else {
                cancelledTransfers.remove(args.transferId)
                pendingPickerTransferId = args.transferId
                pendingPickerInvoke = invoke
                true
            }
        }
        if (!canStart) {
            invoke.reject("A document picker is already active or this plugin is shutting down")
            return
        }

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = args.mimeType.takeIf { it.isNotBlank() } ?: "application/octet-stream"
            putExtra(Intent.EXTRA_TITLE, safeDisplayName(args.filename))
        }
        try {
            startActivityForResult(invoke, intent, "onSaveDocument")
            recordLifecycle(LifecycleMarker.SAVE_PICKER_OPENED)
            schedulePickerExpiry(args.transferId)
        } catch (error: Exception) {
            Log.e(LOG_TAG, "Could not open the Android save picker", error)
            var timeout: Runnable? = null
            synchronized(lock) {
                if (pendingPickerTransferId == args.transferId) {
                    pendingPickerTransferId = null
                    pendingPickerInvoke = null
                    timeout = pendingPickerTimeout
                    pendingPickerTimeout = null
                }
                cancelledTransfers.remove(args.transferId)
            }
            timeout?.let(mainHandler::removeCallbacks)
            invoke.reject("Could not open the Android save picker")
        }
    }

    @Command
    fun exportDiagnostics(invoke: Invoke) {
        val canStart = synchronized(lock) {
            if (destroyed || pendingPickerTransferId != null || pendingDiagnosticsInvoke != null || transfers.isNotEmpty()) {
                false
            } else {
                pendingDiagnosticsInvoke = invoke
                true
            }
        }
        if (!canStart) {
            invoke.reject("Finish or cancel the current document operation before exporting diagnostics")
            return
        }

        val report = try {
            diagnosticsReport()
        } catch (error: Exception) {
            Log.e(LOG_TAG, "Could not collect local Android diagnostics", error)
            synchronized(lock) { pendingDiagnosticsInvoke = null }
            invoke.reject("Could not prepare Android diagnostics")
            return
        }
        synchronized(lock) { pendingDiagnosticsReport = report }
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "text/plain"
            putExtra(Intent.EXTRA_TITLE, DIAGNOSTICS_FILE)
        }
        try {
            startActivityForResult(invoke, intent, "onDiagnosticsDocument")
            scheduleDiagnosticsExpiry()
        } catch (error: Exception) {
            Log.e(LOG_TAG, "Could not open the Android diagnostics picker", error)
            synchronized(lock) {
                pendingDiagnosticsInvoke = null
                pendingDiagnosticsReport = null
                pendingDiagnosticsExpired = false
                pendingDiagnosticsTimeout?.let(mainHandler::removeCallbacks)
                pendingDiagnosticsTimeout = null
            }
            invoke.reject("Could not open the Android diagnostics picker")
        }
    }

    @ActivityCallback
    fun onDiagnosticsDocument(invoke: Invoke, result: ActivityResult) {
        val report: String?
        val ownerInvoke: Invoke?
        val expired: Boolean
        synchronized(lock) {
            pendingDiagnosticsTimeout?.let(mainHandler::removeCallbacks)
            pendingDiagnosticsTimeout = null
            report = pendingDiagnosticsReport
            pendingDiagnosticsReport = null
            ownerInvoke = pendingDiagnosticsInvoke
            pendingDiagnosticsInvoke = null
            expired = pendingDiagnosticsExpired
            pendingDiagnosticsExpired = false
        }
        val uri = result.data?.data
        if (expired) {
            if (result.resultCode == Activity.RESULT_OK && uri != null) {
                runCatching { DocumentsContract.deleteDocument(activity.contentResolver, uri) }
            }
            return
        }
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            ownerInvoke?.resolve(diagnosticsReply("cancelled"))
            return
        }
        if (report == null) {
            ownerInvoke?.reject("Android diagnostics export expired")
            return
        }
        executeIo {
            try {
                val bytes = report.toByteArray(Charsets.UTF_8)
                if (bytes.size > AndroidDiagnosticsReport.MAX_REPORT_BYTES) {
                    throw IllegalStateException("Diagnostics report exceeds its size limit")
                }
                val output = activity.contentResolver.openOutputStream(uri, "w")
                    ?: throw IllegalStateException("Selected document could not be opened")
                output.use { it.write(bytes) }
                ownerInvoke?.resolve(diagnosticsReply("exported"))
            } catch (error: Exception) {
                Log.e(LOG_TAG, "Could not write Android diagnostics", error)
                ownerInvoke?.reject("Could not write Android diagnostics")
            }
        }
    }

    @ActivityCallback
    fun onSaveDocument(invoke: Invoke, result: ActivityResult) {
        var beginInvoke: Invoke? = null
        var timeout: Runnable? = null
        val transferId = synchronized(lock) {
            val id = pendingPickerTransferId
            if (id != null) {
                pendingPickerTransferId = null
                beginInvoke = pendingPickerInvoke
                pendingPickerInvoke = null
                timeout = pendingPickerTimeout
                pendingPickerTimeout = null
            }
            id
        }
        timeout?.let(mainHandler::removeCallbacks)
        if (transferId == null) {
            invoke.reject("The Android save picker returned without a pending transfer")
            return
        }

        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            synchronized(lock) { cancelledTransfers.remove(transferId) }
            beginInvoke?.resolve(beginReply("cancelled"))
            return
        }

        val beginArgs = invoke.parseArgs(BeginSaveArgs::class.java)
        executeIo {
            val stale = synchronized(lock) { destroyed || cancelledTransfers.contains(transferId) }
            if (stale) {
                val cleanupError = deleteDocument(uri)
                synchronized(lock) { cancelledTransfers.remove(transferId) }
                if (cleanupError != null) {
                    if (beginInvoke != null) beginInvoke?.reject(cleanupError)
                    else Log.e(LOG_TAG, cleanupError)
                } else beginInvoke?.resolve(beginReply("cancelled"))
                return@executeIo
            }

            try {
                val output = activity.contentResolver.openOutputStream(uri, "w")
                    ?: throw IllegalStateException("The selected document could not be opened for writing")
                val transfer = SaveTransfer(uri, output, beginArgs.expectedBytes)
                val accepted = synchronized(lock) {
                    if (destroyed || cancelledTransfers.contains(transferId)) false
                    else {
                        transfers[transferId] = transfer
                        true
                    }
                }
                if (!accepted) {
                    output.close()
                    val cleanupError = deleteDocument(uri)
                    synchronized(lock) { cancelledTransfers.remove(transferId) }
                    if (cleanupError != null) {
                        if (beginInvoke != null) beginInvoke?.reject(cleanupError)
                        else Log.e(LOG_TAG, cleanupError)
                    } else beginInvoke?.resolve(beginReply("cancelled"))
                } else {
                    beginInvoke?.resolve(beginReply("started", transferId))
                }
            } catch (error: Exception) {
                Log.e(LOG_TAG, "Could not open the selected document", error)
                val cleanupError = deleteDocument(uri)
                val message = cleanupError ?: "Could not open the selected document"
                if (beginInvoke != null) beginInvoke?.reject(message) else Log.e(LOG_TAG, message)
            }
        }
    }

    @Command
    fun saveWriteChunk(invoke: Invoke) {
        val args = invoke.parseArgs(WriteChunkArgs::class.java)
        if (args.chunkBase64.isEmpty() || args.chunkBase64.length > MAX_BASE64_CHARS) {
            executeIo {
                val cleanupError = abortTransfer(args.transferId)
                invoke.reject(cleanupError ?: "chunkBase64 must encode between 1 byte and 128 KiB")
            }
            return
        }
        executeIo {
            try {
                val bytes = Base64.decode(args.chunkBase64, Base64.NO_WRAP)
                if (bytes.isEmpty() || bytes.size > MAX_CHUNK_BYTES) {
                    throw IllegalArgumentException("Decoded chunk must be at most 128 KiB")
                }
                val transfer = synchronized(lock) { transfers[args.transferId] }
                    ?: throw IllegalStateException("Unknown or finished transferId")
                if (args.sequence != transfer.nextSequence) {
                    throw IllegalArgumentException("Chunk sequence must be ${transfer.nextSequence}")
                }
                val nextSize = transfer.bytesWritten + bytes.size
                if (nextSize > MAX_TRANSFER_BYTES) {
                    throw IllegalArgumentException("A saved document cannot exceed 2 GiB")
                }
                if (transfer.expectedBytes != null && nextSize > transfer.expectedBytes) {
                    throw IllegalArgumentException("The saved document exceeds expectedBytes")
                }
                transfer.output.write(bytes)
                transfer.bytesWritten = nextSize
                transfer.nextSequence += 1
                invoke.resolve()
            } catch (error: Exception) {
                Log.e(LOG_TAG, "Could not write document chunk", error)
                val cleanupError = abortTransfer(args.transferId)
                invoke.reject(cleanupError ?: "Could not write document chunk")
            }
        }
    }

    @Command
    fun saveFinish(invoke: Invoke) {
        val args = invoke.parseArgs(TransferArgs::class.java)
        executeIo {
            val transfer = synchronized(lock) { transfers.remove(args.transferId) }
            if (transfer == null) {
                invoke.reject("Unknown or finished transferId")
                return@executeIo
            }
            try {
                if (transfer.expectedBytes != null && transfer.bytesWritten != transfer.expectedBytes) {
                    throw IllegalStateException("Written byte count does not match expectedBytes")
                }
                transfer.output.flush()
                transfer.output.close()
                recordLifecycle(LifecycleMarker.SAVE_FINISHED)
                invoke.resolve()
            } catch (error: Exception) {
                Log.e(LOG_TAG, "Could not finish document", error)
                try {
                    transfer.output.close()
                } catch (_: Exception) {
                    // The selected document is still deleted below.
                }
                val cleanupError = deleteDocument(transfer.uri)
                invoke.reject(cleanupError ?: "Could not finish document")
            }
        }
    }

    @Command
    fun saveCancel(invoke: Invoke) {
        val args = invoke.parseArgs(TransferArgs::class.java)
        val pending = synchronized(lock) {
            if (pendingPickerTransferId == args.transferId) {
                cancelledTransfers.add(args.transferId)
                true
            } else {
                false
            }
        }
        if (pending) {
            // Keep the begin result alive until the picker returns so a provider cleanup
            // failure can still be reported through that command's response.
            invoke.resolve()
            return
        }

        executeIo {
            val transfer = synchronized(lock) {
                cancelledTransfers.remove(args.transferId)
                transfers.remove(args.transferId)
            }
            if (transfer == null) {
                invoke.resolve()
                return@executeIo
            }
            try {
                transfer.output.close()
            } catch (error: Exception) {
                Log.e(LOG_TAG, "Could not close cancelled document", error)
                val cleanupError = deleteDocument(transfer.uri)
                invoke.reject(cleanupError ?: "Could not close cancelled document")
                return@executeIo
            }
            val cleanupError = deleteDocument(transfer.uri)
            if (cleanupError == null) invoke.resolve() else invoke.reject(cleanupError)
        }
    }

    override fun load(webView: WebView) {
        this.webView = webView
        recordLifecycle(LifecycleMarker.APP_STARTED)
        recordLifecycle(LifecycleMarker.WEBVIEW_READY)

        // Tauri's built-in AppPlugin installs its dispatcher callback during plugin setup.
        // Posting here makes this app-specific callback the later, higher-priority callback.
        webView.post {
            val owner = activity as? AppCompatActivity ?: return@post
            if (owner.isFinishing || owner.isDestroyed) return@post

            val callback = object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val currentUri = webView.url?.let(Uri::parse)
                    val localSettingsUri = settingsUri
                    if (currentUri != null && localSettingsUri != null &&
                        currentUri.scheme == localSettingsUri.scheme &&
                        currentUri.host == localSettingsUri.host &&
                        currentUri.port == localSettingsUri.port
                    ) {
                        activity.finish()
                    } else {
                        webView.loadUrl(localSettingsUri?.toString() ?: return)
                    }
                }
            }
            backCallback = callback
            owner.onBackPressedDispatcher.addCallback(owner, callback)
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        recordLifecycle(LifecycleMarker.ACTIVITY_DESTROYED)
        backCallback?.remove()
        backCallback = null
        webView = null
        var pendingInvoke: Invoke? = null
        val abandoned = synchronized(lock) {
            destroyed = true
            pendingPickerTransferId?.let(cancelledTransfers::add)
            pendingInvoke = pendingPickerInvoke
            pendingPickerInvoke = null
            pendingPickerTimeout?.let(mainHandler::removeCallbacks)
            pendingPickerTimeout = null
            pendingDiagnosticsInvoke?.resolve(diagnosticsReply("cancelled"))
            pendingDiagnosticsInvoke = null
            pendingDiagnosticsReport = null
            pendingDiagnosticsExpired = false
            pendingDiagnosticsTimeout?.let(mainHandler::removeCallbacks)
            pendingDiagnosticsTimeout = null
            transfers.values.toList().also { transfers.clear() }
        }
        pendingInvoke?.resolve(beginReply("cancelled"))
        for (transfer in abandoned) {
            executeIo {
                try {
                    transfer.output.close()
                } catch (error: Exception) {
                    Log.w(LOG_TAG, "Could not close a document during activity shutdown", error)
                }
                deleteDocument(transfer.uri)?.let { Log.w(LOG_TAG, it) }
            }
        }
        ioExecutor.shutdown()
        super.onDestroy(activity)
    }

    private fun beginReply(status: String, transferId: String? = null): JSObject = JSObject().apply {
        put("status", status)
        if (transferId != null) put("transferId", transferId)
    }

    private fun diagnosticsReply(status: String): JSObject = JSObject().apply { put("status", status) }

    private fun scheduleDiagnosticsExpiry() {
        val timeout = Runnable {
            val pending = synchronized(lock) {
                pendingDiagnosticsReport = null
                pendingDiagnosticsTimeout = null
                pendingDiagnosticsExpired = pendingDiagnosticsInvoke != null
                pendingDiagnosticsInvoke
            }
            pending?.resolve(diagnosticsReply("cancelled"))
        }
        synchronized(lock) { pendingDiagnosticsTimeout = timeout }
        mainHandler.postDelayed(timeout, PICKER_EXPIRY_MS)
    }

    private fun recordLifecycle(marker: LifecycleMarker) {
        if (Build.VERSION.SDK_INT != 29) return
        executeIo {
            runCatching {
                lifecycleRing.append(LifecycleRecord(System.currentTimeMillis(), marker))
            }.onFailure { Log.w(LOG_TAG, "Could not record a local lifecycle marker") }
        }
    }

    private fun diagnosticsReport(): String {
        val exits = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val manager = activity.getSystemService(ActivityManager::class.java)
            manager.getHistoricalProcessExitReasons(activity.packageName, 0, AndroidDiagnosticsReport.MAX_EXIT_RECORDS)
                .take(AndroidDiagnosticsReport.MAX_EXIT_RECORDS)
                .map { info ->
                    ExitRecord(
                        reason = AndroidDiagnosticsReport.reasonName(info.reason),
                        status = info.status,
                        importance = info.importance,
                        timestampMillis = info.timestamp,
                        pssKb = info.pss,
                        rssKb = info.rss,
                    )
                }
        } else null
        val lifecycle = if (exits == null) {
            lifecycleRing.read()
        } else emptyList()
        val version = activity.packageManager.getPackageInfo(activity.packageName, 0).versionName.orEmpty()
        return AndroidDiagnosticsReport.format(
            appVersion = version,
            sdk = Build.VERSION.SDK_INT,
            generatedAtMillis = System.currentTimeMillis(),
            exits = exits,
            lifecycle = lifecycle,
        )
    }

    private fun schedulePickerExpiry(transferId: String) {
        val timeout = Runnable {
            val pendingInvoke = synchronized(lock) {
                if (pendingPickerTransferId != transferId) return@Runnable
                cancelledTransfers.add(transferId)
                pendingPickerTimeout = null
                pendingPickerInvoke.also { pendingPickerInvoke = null }
            }
            pendingInvoke?.resolve(beginReply("cancelled"))
        }
        synchronized(lock) {
            if (pendingPickerTransferId == transferId) pendingPickerTimeout = timeout
        }
        mainHandler.postDelayed(timeout, PICKER_EXPIRY_MS)
    }

    private fun executeIo(task: () -> Unit) {
        try {
            ioExecutor.execute { task() }
        } catch (_: RejectedExecutionException) {
            // An activity result can race with onDestroy. Still try to remove a document
            // selected after its owning activity has started shutting down.
            Thread({ task() }, "connection-controls-save-cleanup")
                .apply { isDaemon = true }
                .start()
        }
    }

    private fun safeDisplayName(filename: String): String = filename
        .replace('/', '_')
        .replace('\\', '_')
        .filter { it >= ' ' && it != '\u007f' }
        .trim()
        .take(240)
        .ifEmpty { "download" }

    private fun abortTransfer(transferId: String): String? {
        val transfer = synchronized(lock) { transfers.remove(transferId) } ?: return null
        var closeError: String? = null
        try {
            transfer.output.close()
        } catch (error: Exception) {
            Log.e(LOG_TAG, "Could not close the incomplete document", error)
            closeError = "Could not close the incomplete document"
        }
        return deleteDocument(transfer.uri) ?: closeError
    }

    private fun deleteDocument(uri: Uri): String? = try {
        if (DocumentsContract.deleteDocument(activity.contentResolver, uri)) null
        else "The document provider refused to delete the incomplete document"
    } catch (error: Exception) {
        Log.e(LOG_TAG, "Could not delete the incomplete document", error)
        "Could not delete the incomplete document"
    }
}
