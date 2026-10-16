package local.openwebui.connectioncontrols

import android.app.Activity
import android.net.Uri
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
internal class ConfigureArgs {
    lateinit var settingsUrl: String
}

@TauriPlugin
class ConnectionControlsPlugin(private val activity: Activity) : Plugin(activity) {
    private var settingsUri: Uri? = null
    private var backCallback: OnBackPressedCallback? = null
    private var webView: WebView? = null

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
                        // Do not fall through to Tauri's history-based callback: when the
                        // settings page was reached from a remote service, that would reopen it.
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
        super.onDestroy(activity)
    }
}
