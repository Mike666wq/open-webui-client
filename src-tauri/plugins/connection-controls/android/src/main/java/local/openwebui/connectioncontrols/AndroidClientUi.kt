package local.openwebui.connectioncontrols

import android.app.Activity
import android.graphics.Color
import android.graphics.Point
import android.graphics.Rect
import android.os.Build
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.Window
import android.view.WindowManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max

@InvokeArg
internal class NativeNoticeArgs { var code: String = "" }

@InvokeArg
internal class NativeActionsArgs { lateinit var actions: Channel }

@InvokeArg
internal class ClientStateArgs {
    var requestId: String = ""
    var generation: Long = 0
    var revision: Long = 0
    var phase: String = "settings"
    var candidateUrl: String? = null
    var lastSuccessUrl: String? = null
    var errorCode: String? = null
}

/** Owns only native chrome; never changes the remote DOM or its WebViewClient. */
internal class AndroidClientUi(private val activity: Activity, private val webView: WebView) {
    private val prefs = activity.getSharedPreferences("android-client-ui", Activity.MODE_PRIVATE)
    private val root = FrameLayout(activity)
    private val button = Button(activity)
    private var channel: Channel? = null
    private var state = ClientStateArgs()
    private var fraction = prefs.getFloat("menu-y", .5f).coerceIn(0f, 1f)
    private var menu: AlertDialog? = null
    private var settings: AlertDialog? = null
    private var confirmation: AlertDialog? = null
    private var address: EditText? = null
    private var status: TextView? = null
    private var connect: Button? = null
    private var previous: Button? = null
    private var attempted = false
    private var disposed = false
    private var clearHistoryGeneration = -1L
    private var lastInsets: WindowInsetsCompat? = null
    private val buttonSize get() = dp(48)
    private val chinese get() = ClientPolicy.chinese(activity.resources.configuration.locales[0].language)
    private fun tr(en: String, zh: String) = if (chinese) zh else en
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
    private val focusListener = ViewTreeObserver.OnWindowFocusChangeListener { focused ->
        if (focused && !disposed) { immersive(activity.window); ViewCompat.requestApplyInsets(root) }
    }
    private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener {
        lastInsets?.let { layoutInsets(it) }
    }

    init {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        // Never detach a loading WebView: doing so can interrupt its initial
        // module/resource loading. Native chrome is a transparent sibling, and
        // this controller adjusts the existing WebView's physical bounds.
        val parent = webView.parent as ViewGroup
        parent.addView(root, ViewGroup.LayoutParams(-1, -1))
        root.setBackgroundColor(Color.TRANSPARENT)
        button.text = "⋮"
        button.textSize = 25f
        button.setTextColor(Color.WHITE)
        button.contentDescription = tr("Client menu", "客户端菜单")
        button.background = GradientDrawable().apply {
            setColor(Color.argb(215, 54, 59, 66)); cornerRadius = dp(24).toFloat()
        }
        button.setPadding(0, 0, 0, 0)
        button.minWidth = 0; button.minimumWidth = 0
        button.minHeight = 0; button.minimumHeight = 0
        button.visibility = View.GONE
        root.addView(button, FrameLayout.LayoutParams(buttonSize, buttonSize, Gravity.TOP or Gravity.RIGHT))
        installDrag()
        button.setOnClickListener { showMenu() }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            lastInsets = insets; layoutInsets(insets)
            insets // Preserve sibling dispatch on API 29; don't consume root insets.
        }
        root.viewTreeObserver.addOnWindowFocusChangeListener(focusListener)
        root.viewTreeObserver.addOnGlobalLayoutListener(layoutListener)
        root.post { immersive(activity.window); ViewCompat.requestApplyInsets(root) }
    }

    private fun immersive(window: Window) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.statusBars())
        controller.show(WindowInsetsCompat.Type.navigationBars())
    }

    private fun layoutInsets(insets: WindowInsetsCompat) {
        if (root.height == 0) return
        val cutout = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.displayCutout())
        val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val rootLocation = IntArray(2); root.getLocationOnScreen(rootLocation)
        // WindowMetrics ignores IME resizing. decor.height may already be resized,
        // so using it as the original window height would deduct the IME twice.
        val windowBottom = if (Build.VERSION.SDK_INT >= 30) activity.windowManager.currentWindowMetrics.bounds.bottom
            else Point().also { @Suppress("DEPRECATION") activity.windowManager.defaultDisplay.getRealSize(it) }.y
        val rootBottom = rootLocation[1] + root.height
        val keyboardOverlap = if (Build.VERSION.SDK_INT >= 30) {
            ClientPolicy.bottomOverlap(rootBottom, windowBottom, ime.bottom)
        } else {
            val visible = Rect(); root.getWindowVisibleDisplayFrame(visible)
            (rootBottom - visible.bottom).coerceAtLeast(0)
        }
        val overlap = max(keyboardOverlap, ClientPolicy.bottomOverlap(rootBottom, windowBottom, nav.bottom))
        val left = max(cutout.left, nav.left)
        val right = max(cutout.right, nav.right)
        val top = (cutout.top - rootLocation[1]).coerceAtLeast(0)
        val bottom = max(cutout.bottom, overlap).coerceAtMost(root.height - top)
        if (root.paddingLeft != left || root.paddingTop != top || root.paddingRight != right || root.paddingBottom != bottom) {
            root.setPadding(left, top, right, bottom)
        }
        val params = webView.layoutParams
        val width = (root.width - left - right).coerceAtLeast(1)
        val height = (root.height - top - bottom).coerceAtLeast(1)
        if (params is ViewGroup.MarginLayoutParams &&
            (params.width != width || params.height != height || params.topMargin != top ||
             params.leftMargin != left || params.rightMargin != right || params.bottomMargin != bottom)) {
            params.width = width; params.height = height
            params.leftMargin = left; params.topMargin = top; params.rightMargin = right; params.bottomMargin = bottom
            webView.layoutParams = params
        }
        placeButton()
    }

    private fun placeButton() {
        val params = button.layoutParams as FrameLayout.LayoutParams
        val offset = ClientPolicy.buttonOffset(fraction, root.height, root.paddingTop, root.paddingBottom, buttonSize)
        // Stay inside the mandatory side gesture area, without excluding any gestures.
        val gestures = lastInsets?.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
        val margin = max(dp(8), gestures?.right ?: 0)
        if (params.topMargin != offset || params.rightMargin != margin) {
            params.topMargin = offset; params.rightMargin = margin; button.layoutParams = params
        }
    }

    private fun installDrag() {
        var startY = 0f; var startFraction = fraction; var dragged = false
        val slop = ViewConfiguration.get(activity).scaledTouchSlop
        button.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startY = event.rawY; startFraction = fraction; dragged = false; true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (abs(event.rawY - startY) > slop) dragged = true
                    if (dragged) {
                        val range = (root.height - root.paddingTop - root.paddingBottom - buttonSize).coerceAtLeast(1)
                        fraction = (startFraction + (event.rawY - startY) / range).coerceIn(0f, 1f)
                        placeButton()
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (dragged) prefs.edit().putFloat("menu-y", fraction).apply() else button.performClick()
                    true
                }
                MotionEvent.ACTION_CANCEL -> { fraction = startFraction; placeButton(); true }
                else -> false
            }
        }
    }

    fun install(actions: Channel) {
        channel = actions
        send("snapshot")
    }

    private fun send(type: String, target: String? = null) {
        channel?.send(JSObject().apply {
            put("type", type); put("requestId", UUID.randomUUID().toString())
            if (type == "connect") put("address", target ?: "")
            if (type == "reload" || type == "cancel") put("generation", state.generation)
        })
    }

    fun render(next: ClientStateArgs) {
        if (disposed || next.revision <= state.revision || next.generation < state.generation) return
        val old = state
        state = next
        button.visibility = if (next.phase == "connected" || next.phase == "connecting") View.VISIBLE else View.GONE
        button.isEnabled = channel != null
        if (next.phase == "connected" && clearHistoryGeneration != next.generation) {
            clearHistoryGeneration = next.generation
            webView.clearHistory() // Do not retain local startup or the previous server.
        }
        if (next.phase == "connected" && next.errorCode == null && attempted) {
            attempted = false; settings?.dismiss(); confirmation?.dismiss()
        }
        if (next.phase == "failed" && (old.phase == "connecting" || attempted)) showSettings()
        status?.text = when {
            next.errorCode == "invalidAddress" -> tr("Enter an HTTP(S) server origin, without credentials or a path.", "请输入 HTTP(S) 服务地址，不含账号密码或子路径。")
            next.errorCode != null -> tr("Connection failed. Retry or reopen the previous server.", "连接失败，请重试或重新打开上次成功的服务。")
            next.phase == "connecting" -> tr("Connecting…", "正在连接…")
            else -> ""
        }
        connect?.isEnabled = channel != null && next.phase != "connecting"
        previous?.visibility = if (next.lastSuccessUrl != null && next.phase == "failed") View.VISIBLE else View.GONE
    }

    private fun showMenu() {
        if (menu?.isShowing == true || disposed) return
        menu = AlertDialog.Builder(activity)
            .setTitle(tr("Client menu", "客户端菜单"))
            .setItems(arrayOf(tr("Server address", "修改服务地址"), tr("Reload", "重新加载"), tr("Export Android diagnostics", "导出安卓诊断"))) { _, which ->
                when (which) {
                    0 -> showSettings()
                    1 -> confirmLeaving { send("reload") }
                    2 -> send("exportDiagnostics")
                }
            }.create().also { dialog ->
                dialog.setOnDismissListener { menu = null }
                showImmersive(dialog)
            }
    }

    private fun showImmersive(dialog: AlertDialog) {
        dialog.setOnShowListener { dialog.window?.let { immersive(it) } }
        dialog.show()
    }

    private fun confirmLeaving(action: () -> Unit) {
        confirmation = AlertDialog.Builder(activity)
            .setTitle(tr("Leave this page?", "离开当前页面？"))
            .setMessage(tr("Unsent input or an active response may be lost. Continue?", "未发送的内容或正在生成的回答可能丢失，是否继续？"))
            .setNegativeButton(tr("Cancel", "取消"), null)
            .setPositiveButton(tr("Continue", "继续")) { _, _ -> action() }
            .create().also { dialog -> dialog.setOnDismissListener { confirmation = null }; showImmersive(dialog) }
    }

    private fun showSettings() {
        if (disposed || settings?.isShowing == true) return
        val layout = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0) }
        address = EditText(activity).apply {
            isSingleLine = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            contentDescription = tr("Server address", "服务地址")
            setText(state.candidateUrl ?: state.lastSuccessUrl ?: "")
            selectAll()
        }
        status = TextView(activity).apply { setPadding(0, dp(8), 0, dp(8)) }
        previous = Button(activity).apply {
            text = tr("Reopen previous server", "重新打开上次服务")
            visibility = if (state.lastSuccessUrl != null && state.phase == "failed") View.VISIBLE else View.GONE
            setOnClickListener { state.lastSuccessUrl?.let { start(it) } }
        }
        layout.addView(address); layout.addView(status); layout.addView(previous)
        val dialog = AlertDialog.Builder(activity)
            .setTitle(tr("Connection settings", "连接设置"))
            .setView(layout)
            .setNegativeButton(tr("Cancel", "取消")) { _, _ -> cancelIfConnecting() }
            .setPositiveButton(tr("Connect", "连接"), null)
            .create()
        settings = dialog
        dialog.setOnDismissListener { settings = null; address = null; status = null; connect = null; previous = null }
        dialog.setOnShowListener {
            dialog.window?.let { window ->
                window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
                immersive(window)
            }
            connect = dialog.getButton(AlertDialog.BUTTON_POSITIVE).apply {
                isEnabled = channel != null && state.phase != "connecting"
                setOnClickListener {
                    val value = address?.text?.toString()?.trim() ?: ""
                    if (state.phase == "connected" && ClientPolicy.sameOrigin(value, state.candidateUrl) &&
                        runCatching { val uri = java.net.URI(value); uri.path.isNullOrEmpty() || uri.path == "/" }.getOrDefault(false) &&
                        !value.contains('?') && !value.contains('#')) {
                        dialog.dismiss()
                    } else if (state.phase == "connected") confirmLeaving { start(value) }
                    else start(value)
                }
            }
            if (state.phase == "failed") status?.text = tr("Connection failed. Retry or reopen the previous server.", "连接失败，请重试或重新打开上次成功的服务。")
        }
        dialog.setOnCancelListener { cancelIfConnecting() }
        dialog.show()
    }

    private fun start(value: String) {
        attempted = true
        status?.text = tr("Connecting…", "正在连接…")
        connect?.isEnabled = false
        send("connect", value)
    }

    private fun cancelIfConnecting() { if (state.phase == "connecting") send("cancel") }

    fun back() {
        val insets = ViewCompat.getRootWindowInsets(root)
        if (insets?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
            WindowCompat.getInsetsController(activity.window, root).hide(WindowInsetsCompat.Type.ime()); return
        }
        if (confirmation?.isShowing == true) { confirmation?.dismiss(); return }
        if (settings?.isShowing == true) { cancelIfConnecting(); settings?.dismiss(); return }
        if (menu?.isShowing == true) { menu?.dismiss(); return }
        if (state.phase == "connecting") { send("cancel"); return }
        val history = webView.copyBackForwardList()
        val previousUrl = if (history.currentIndex > 0) history.getItemAtIndex(history.currentIndex - 1)?.url else null
        if (state.phase == "connected" && ClientPolicy.sameOrigin(previousUrl, state.candidateUrl)) webView.goBack()
        else activity.moveTaskToBack(true)
    }

    fun notice(code: String) {
        val message = when (code) {
            "diagnosticsExported" -> tr("Report saved locally. It was not sent.", "报告已保存到本地，未发送。")
            "diagnosticsCancelled" -> tr("Export cancelled. No report was sent.", "已取消导出，未发送报告。")
            "diagnosticsFailed" -> tr("Could not export diagnostics. Nothing was sent.", "无法导出诊断，未发送报告。")
            else -> return
        }
        android.widget.Toast.makeText(activity, message, android.widget.Toast.LENGTH_LONG).show()
    }

    fun resume() { if (!disposed) { immersive(activity.window); ViewCompat.requestApplyInsets(root) } }
    fun destroy() {
        disposed = true
        confirmation?.dismiss(); settings?.dismiss(); menu?.dismiss()
        channel = null
        root.viewTreeObserver.removeOnWindowFocusChangeListener(focusListener)
        root.viewTreeObserver.removeOnGlobalLayoutListener(layoutListener)
        ViewCompat.setOnApplyWindowInsetsListener(root, null)
        button.setOnTouchListener(null); button.setOnClickListener(null)
        (root.parent as? ViewGroup)?.removeView(root)
    }
}
