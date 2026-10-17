package local.openwebui.connectioncontrols

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

private const val MAX_CHUNK_BYTES = 128 * 1024
private const val MAX_TRANSFER_BYTES = 2L * 1024 * 1024 * 1024
private const val MAX_BASE64_CHARS = ((MAX_CHUNK_BYTES + 2) / 3) * 4
private const val PICKER_EXPIRY_MS = 10 * 60 * 1000L
private const val LOG_TAG = "ConnectionControls"

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
    private val ioExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "connection-controls-save-io").apply { isDaemon = true }
    }
    private val transfers = mutableMapOf<String, SaveTransfer>()
    private val cancelledTransfers = mutableSetOf<String>()
    private var pendingPickerTransferId: String? = null
    private var pendingPickerInvoke: Invoke? = null
    private var pendingPickerTimeout: Runnable? = null
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
            if (destroyed || pendingPickerTransferId != null || transfers.containsKey(args.transferId)) {
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
                return@execute
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
                return@execute
            }
            try {
                if (transfer.expectedBytes != null && transfer.bytesWritten != transfer.expectedBytes) {
                    throw IllegalStateException("Written byte count does not match expectedBytes")
                }
                transfer.output.flush()
                transfer.output.close()
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
                return@execute
            }
            try {
                transfer.output.close()
            } catch (error: Exception) {
                Log.e(LOG_TAG, "Could not close cancelled document", error)
                val cleanupError = deleteDocument(transfer.uri)
                invoke.reject(cleanupError ?: "Could not close cancelled document")
                return@execute
            }
            val cleanupError = deleteDocument(transfer.uri)
            if (cleanupError == null) invoke.resolve() else invoke.reject(cleanupError)
        }
    }

    override fun load(webView: WebView) {
        this.webView = webView

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
