package local.openwebui.connectioncontrols

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Message
import android.view.KeyEvent
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

/** APK resources are immutable; verify each first use before returning any bytes. */
internal class BundledFrontendAssets(private val assets: AssetManager) {
    val manifest = runCatching {
        assets.open("${BundledFrontendManifest.ASSET_DIRECTORY}/${BundledFrontendManifest.MANIFEST_FILE}")
            .use { stream ->
                val bytes = stream.readBytes()
                require(bytes.size <= 16 * 1024 * 1024)
                BundledFrontendManifest.parse(JSONObject(bytes.toString(Charsets.UTF_8)))
            }
    }.getOrNull()

    private val verified = ConcurrentHashMap.newKeySet<String>()

    fun open(file: BundledFrontendFile): InputStream {
        val path = "${BundledFrontendManifest.ASSET_DIRECTORY}/${file.path}"
        if (file.path !in verified) {
            assets.open(path).use { stream -> FrontendFileVerifier.verify(stream, file) }
            verified.add(file.path)
        }
        return assets.open(path)
    }
}

/**
 * Keep Wry's original client alive: its page callbacks own IPC origin tracking,
 * navigation policy, and the initialization-script fallback on older WebViews.
 * Only bounded GET responses from the selected service are replaced.
 */
internal class BundledFrontendWebViewClient(
    val delegate: WebViewClient,
    private val assets: BundledFrontendAssets,
) : WebViewClient() {
    private val sessions = FrontendSessionGate()

    fun prepare(origin: String, generation: Long): Boolean =
        assets.manifest != null && sessions.prepare(origin, generation)

    fun update(state: ClientStateArgs) {
        sessions.update(
            state.candidateUrl ?: state.lastSuccessUrl,
            state.generation, state.revision,
            state.phase == "connecting" || state.phase == "connected",
        )
    }

    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
        // Calling the original first also records interceptedState=false for
        // normal remote URLs. Its onPageStarted fallback must still run on API29.
        val original = delegate.shouldInterceptRequest(view, request)
        if (original != null || request == null) return original
        val selected = sessions.read()
        val route = BundledFrontendPolicy.route(
            selected.snapshot, request.method, request.url.toString(),
            request.isForMainFrame, assets.manifest,
        )
        val response = when (route) {
            BundledFrontendRoute.Network -> return null
            BundledFrontendRoute.MissingAsset -> error(404, "Not Found", "Bundled frontend asset not found.")
            BundledFrontendRoute.Unavailable -> error(503, "Service Unavailable", "The bundled frontend is unavailable. Reinstall the application.")
            is BundledFrontendRoute.Asset -> runCatching {
                WebResourceResponse(
                    route.file.mime, if (textual(route.file.mime)) "UTF-8" else null,
                    200, "OK",
                    mapOf(
                        "Cache-Control" to "no-store",
                        "X-Content-Type-Options" to "nosniff",
                        "X-OWC-Frontend-Commit" to assets.manifest!!.sourceCommit,
                    ),
                    assets.open(route.file),
                )
            }.getOrElse {
                // A missing/corrupt APK chunk cannot fall through to a different
                // server build. API requests never enter this branch.
                error(404, "Not Found", "Bundled frontend asset is missing or invalid.")
            }
        }
        if (!sessions.isCurrent(selected)) {
            runCatching { response.data?.close() }
            return error(410, "Gone", "The client connection changed.")
        }
        return response
    }

    private fun textual(mime: String): Boolean =
        mime.startsWith("text/") || mime in setOf(
            "application/javascript", "application/json", "image/svg+xml", "application/manifest+json",
        )

    private fun error(status: Int, reason: String, message: String) = WebResourceResponse(
        "text/plain", "UTF-8", status, reason,
        mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"),
        ByteArrayInputStream(message.toByteArray(Charsets.UTF_8)),
    )

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
        delegate.shouldOverrideUrlLoading(view, request)

    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean =
        delegate.shouldOverrideUrlLoading(view, url)

    @Suppress("DEPRECATION")
    override fun shouldInterceptRequest(view: WebView?, url: String?): WebResourceResponse? =
        delegate.shouldInterceptRequest(view, url)

    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) =
        delegate.onPageStarted(view, url, favicon)

    override fun onPageFinished(view: WebView?, url: String?) = delegate.onPageFinished(view, url)

    override fun onPageCommitVisible(view: WebView?, url: String?) = delegate.onPageCommitVisible(view, url)

    override fun onLoadResource(view: WebView?, url: String?) = delegate.onLoadResource(view, url)

    @Suppress("DEPRECATION")
    override fun onTooManyRedirects(view: WebView?, cancelMsg: Message?, continueMsg: Message?) =
        delegate.onTooManyRedirects(view, cancelMsg, continueMsg)

    @Suppress("DEPRECATION")
    override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) =
        delegate.onReceivedError(view, errorCode, description, failingUrl)

    override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) =
        delegate.onReceivedError(view, request, error)

    override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) =
        delegate.onReceivedHttpError(view, request, errorResponse)

    override fun onFormResubmission(view: WebView?, dontResend: Message?, resend: Message?) =
        delegate.onFormResubmission(view, dontResend, resend)

    override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) =
        delegate.doUpdateVisitedHistory(view, url, isReload)

    override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) =
        delegate.onReceivedSslError(view, handler, error)

    override fun onReceivedClientCertRequest(view: WebView?, request: ClientCertRequest?) =
        delegate.onReceivedClientCertRequest(view, request)

    override fun onReceivedHttpAuthRequest(view: WebView?, handler: HttpAuthHandler?, host: String?, realm: String?) =
        delegate.onReceivedHttpAuthRequest(view, handler, host, realm)

    override fun shouldOverrideKeyEvent(view: WebView?, event: KeyEvent?): Boolean =
        delegate.shouldOverrideKeyEvent(view, event)

    override fun onUnhandledKeyEvent(view: WebView?, event: KeyEvent?) =
        delegate.onUnhandledKeyEvent(view, event)

    override fun onScaleChanged(view: WebView?, oldScale: Float, newScale: Float) =
        delegate.onScaleChanged(view, oldScale, newScale)

    override fun onReceivedLoginRequest(view: WebView?, realm: String?, account: String?, args: String?) =
        delegate.onReceivedLoginRequest(view, realm, account, args)

    override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean =
        delegate.onRenderProcessGone(view, detail)

    override fun onSafeBrowsingHit(view: WebView?, request: WebResourceRequest?, threatType: Int, callback: SafeBrowsingResponse?) =
        delegate.onSafeBrowsingHit(view, request, threatType, callback)
}
