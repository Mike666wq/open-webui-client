package local.openwebui.connectioncontrols

import android.app.Activity
import android.graphics.Color
import android.graphics.Point
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.ColorFilter
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.content.res.Configuration
import android.content.res.ColorStateList
import android.text.TextUtils
import android.view.ContextThemeWrapper
import android.widget.ImageButton
import android.graphics.Rect
import android.os.Build
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.Window
import android.view.WindowManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
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
    private val root = FrameLayout(activity)
    private val toolbar = LinearLayout(activity)
    private val title = TextView(activity)
    private val subtitle = TextView(activity)
    private val button = ImageButton(activity)
    private val directoryButton = ImageButton(activity)
    private var personalization: PersonalizationController? = null
    private var channel: Channel? = null
    private var state = ClientStateArgs()
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
    private val toolbarHeight get() = max(dp(48), title.lineHeight + subtitle.lineHeight + dp(8))
    private var night: Boolean? = null
    private var fontScale = 0f
    private val dark get() = personalization?.darkOverride ?: (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
    private val surface get() = Color.parseColor(if (dark) "#111318" else "#F8FAFC")
    private val foreground get() = Color.parseColor(if (dark) "#E5E7EB" else "#111827")
    private val secondary get() = Color.parseColor(if (dark) "#A6AFBD" else "#596579")
    private val accent get() = personalization?.accentOverride ?: Color.parseColor(if (dark) "#93B4FF" else "#2563EB")
    private val fieldSurface get() = Color.parseColor(if (dark) "#20242C" else "#EDF1F7")
    private val chinese get() = ClientPolicy.chinese(activity.resources.configuration.locales[0].language)
    private fun tr(en: String, zh: String) = if (chinese) zh else en
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
    private val focusListener = ViewTreeObserver.OnWindowFocusChangeListener { focused ->
        if (focused && !disposed) { updateTheme(); immersive(activity.window); ViewCompat.requestApplyInsets(root) }
    }
    private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener {
        updateTheme(); lastInsets?.let { layoutInsets(it) }
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
        root.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        toolbar.orientation = LinearLayout.HORIZONTAL
        toolbar.elevation = dp(1).toFloat()
        toolbar.gravity = Gravity.CENTER_VERTICAL
        toolbar.setPadding(dp(16), 0, dp(4), 0)
        toolbar.contentDescription = tr("Client toolbar", "客户端顶部栏")
        val labels = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL }
        title.textSize = 14f
        title.setTypeface(null, android.graphics.Typeface.BOLD)
        title.isSingleLine = true; title.ellipsize = TextUtils.TruncateAt.END
        subtitle.textSize = 11f
        subtitle.isSingleLine = true; subtitle.ellipsize = TextUtils.TruncateAt.END
        labels.addView(title); labels.addView(subtitle)
        toolbar.addView(labels, LinearLayout.LayoutParams(0, -1, 1f))
        button.contentDescription = tr("Client settings", "客户端设置")
        button.setPadding(dp(12), dp(12), dp(12), dp(12))
        button.background = android.graphics.drawable.RippleDrawable(
            ColorStateList.valueOf(Color.argb(40, 100, 130, 190)), null,
            GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) })
        directoryButton.contentDescription = tr("Conversation directory", "对话目录")
        directoryButton.setPadding(dp(12),dp(12),dp(12),dp(12))
        directoryButton.visibility = View.GONE
        directoryButton.setOnClickListener { personalization?.showDirectory() }
        toolbar.addView(directoryButton, LinearLayout.LayoutParams(dp(48),dp(48)))
        toolbar.addView(button, LinearLayout.LayoutParams(dp(48), dp(48)))
        root.addView(toolbar, FrameLayout.LayoutParams(-1, toolbarHeight, Gravity.TOP))
        button.setOnClickListener { showMenu() }
        updateTheme(force = true)
        updateToolbar()
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            lastInsets = insets; layoutInsets(insets)
            insets // Preserve sibling dispatch on API 29; don't consume root insets.
        }
        root.viewTreeObserver.addOnWindowFocusChangeListener(focusListener)
        root.viewTreeObserver.addOnGlobalLayoutListener(layoutListener)
        root.addOnLayoutChangeListener { _, l, t, r, b, oldL, oldT, oldR, oldB ->
            if (r-l != oldR-oldL || b-t != oldB-oldT) listOfNotNull(menu, settings, confirmation).forEach { styleDialog(it) }
        }
        personalization = PersonalizationController(activity, webView, ::builder, { dialog ->
            dialog.window?.let { immersive(it) }; styleDialog(dialog)
        }, { updateTheme(force = true) }, { enabled -> directoryButton.visibility = if (enabled) View.VISIBLE else View.GONE })
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
        val safeTop = (cutout.top - rootLocation[1]).coerceAtLeast(0)
        val top = ClientPolicy.contentTop(safeTop, toolbarHeight, root.height)
        val bottom = max(cutout.bottom, overlap).coerceAtMost(root.height - top)
        if (root.paddingLeft != left || root.paddingTop != safeTop || root.paddingRight != right || root.paddingBottom != bottom) {
            root.setPadding(left, safeTop, right, bottom)
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

    }

    private inner class Glyph(private val kind: String, private val ink: Int) : Drawable() {
        override fun draw(canvas: Canvas) {
            val save = canvas.save()
            canvas.translate(bounds.left.toFloat(), bounds.top.toFloat())
            canvas.scale(bounds.width()/24f, bounds.height()/24f)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ink; style = Paint.Style.STROKE; strokeWidth = 1.8f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
            when (kind) {
                "settings" -> {
                    val path = Path()
                    for (i in 0 until 48) {
                        val angle = i * Math.PI / 24 - Math.PI / 2
                        val radius = if (i % 6 in 1..4) 9.5 else 7.5
                        val x = (12 + kotlin.math.cos(angle)*radius).toFloat()
                        val y = (12 + kotlin.math.sin(angle)*radius).toFloat()
                        if (i == 0) path.moveTo(x,y) else path.lineTo(x,y)
                    }
                    path.close(); canvas.drawPath(path, paint); canvas.drawCircle(12f,12f,3.2f,paint)
                }
                "directory" -> {
                    for (y in arrayOf(6f,12f,18f)) { canvas.drawCircle(4f,y,.7f,paint); canvas.drawLine(9f,y,21f,y,paint) }
                }
                "server" -> {
                    canvas.drawRoundRect(4f,4f,20f,10f,2f,2f,paint); canvas.drawRoundRect(4f,14f,20f,20f,2f,2f,paint)
                    canvas.drawPoint(7f,7f,paint); canvas.drawPoint(7f,17f,paint)
                }
                "reload" -> {
                    canvas.drawArc(4f,4f,20f,20f,35f,285f,false,paint)
                    canvas.drawLine(20f,4f,20f,10f,paint); canvas.drawLine(14f,10f,20f,10f,paint)
                }
                else -> {
                    canvas.drawLine(12f,3f,12f,15f,paint); canvas.drawLine(7f,10f,12f,15f,paint); canvas.drawLine(17f,10f,12f,15f,paint)
                    canvas.drawLine(4f,16f,4f,21f,paint); canvas.drawLine(4f,21f,20f,21f,paint); canvas.drawLine(20f,21f,20f,16f,paint)
                }
            }
            canvas.restoreToCount(save)
        }
        override fun setAlpha(alpha: Int) {}
        override fun setColorFilter(colorFilter: ColorFilter?) {}
        @Suppress("DEPRECATION") override fun getOpacity() = PixelFormat.TRANSLUCENT
    }

    private fun updateToolbar() {
        title.text = ClientPolicy.serviceLabel(state.candidateUrl ?: state.lastSuccessUrl)
        subtitle.text = when (state.phase) {
            "connected" -> tr("Connected", "已连接")
            "connecting" -> tr("Connecting…", "正在连接…")
            "failed" -> tr("Connection failed", "连接失败")
            else -> tr("Connection settings", "连接设置")
        }
        button.isEnabled = channel != null
        button.alpha = if (button.isEnabled) 1f else .45f
    }

    private fun updateTheme(force: Boolean = false) {
        if (disposed) return
        val scale = activity.resources.configuration.fontScale
        if (!force && night == dark && fontScale == scale) return
        night = dark; fontScale = scale
        title.textSize = 14f; subtitle.textSize = 11f
        toolbar.layoutParams?.let { if (it.height != toolbarHeight) { it.height = toolbarHeight; toolbar.layoutParams = it } }
        toolbar.setBackgroundColor(surface)
        title.setTextColor(foreground); subtitle.setTextColor(secondary)
        button.setImageDrawable(Glyph("settings", foreground))
        directoryButton.setImageDrawable(Glyph("directory", foreground))
        activity.window.statusBarColor = surface
        activity.window.navigationBarColor = surface
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.isAppearanceLightNavigationBars = !dark
        controller.isAppearanceLightStatusBars = !dark
        listOfNotNull(menu, settings, confirmation).forEach { styleDialog(it) }
        personalization?.restyleDialogs()
    }

    private fun builder() = AlertDialog.Builder(ContextThemeWrapper(activity,
        if (dark) androidx.appcompat.R.style.Theme_AppCompat_Dialog_Alert else androidx.appcompat.R.style.Theme_AppCompat_Light_Dialog_Alert))

    private fun styleDialog(dialog: AlertDialog) {
        if (disposed || !dialog.isShowing) return
        val window = dialog.window ?: return
        window.setBackgroundDrawable(GradientDrawable().apply { setColor(surface); cornerRadius = dp(24).toFloat() })
        window.decorView.clipToOutline = true
        window.setGravity(Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
        val displayWidth = activity.resources.displayMetrics.widthPixels
        window.setLayout(minOf(displayWidth - dp(24), dp(600)), ViewGroup.LayoutParams.WRAP_CONTENT)
        val safeBottom = lastInsets?.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.displayCutout())?.bottom ?: 0
        window.attributes = window.attributes.apply { y = safeBottom + dp(12); dimAmount = .35f }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        window.decorView.minimumHeight = dp(100)
        dialog.findViewById<TextView>(androidx.appcompat.R.id.alertTitle)?.setTextColor(foreground)
        dialog.findViewById<TextView>(android.R.id.message)?.setTextColor(secondary)
        fun recolor(view: View) {
            if (view is TextView) view.setTextColor(if (view is Button) accent else foreground)
            if (view is Button && view.tag is String) {
                view.backgroundTintList = ColorStateList.valueOf(surface)
                view.setCompoundDrawablesRelative(Glyph(view.tag as String, secondary).apply { setBounds(0,0,dp(22),dp(22)) }, null, null, null)
            }
            if (view is ViewGroup) {
                if (view !== window.decorView) view.setBackgroundColor(surface)
                for (index in 0 until view.childCount) recolor(view.getChildAt(index))
            }
        }
        recolor(window.decorView)
        address?.apply {
            setTextColor(this@AndroidClientUi.foreground); setHintTextColor(secondary)
            backgroundTintList = null
            background = GradientDrawable().apply { setColor(fieldSurface); cornerRadius = dp(14).toFloat(); setStroke(dp(1), accent) }
        }
        status?.setTextColor(secondary)
        for (which in arrayOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE)) {
            dialog.getButton(which)?.apply {
                isAllCaps = false; minHeight = dp(48); setTextColor(accent)
                if (which == AlertDialog.BUTTON_POSITIVE) {
                    setTextColor(if (dark) Color.parseColor("#0D2047") else Color.WHITE)
                    background = GradientDrawable().apply { setColor(accent); cornerRadius = dp(12).toFloat() }
                    setPadding(dp(18), 0, dp(18), 0)
                }
            }
        }
        window.decorView.post {
            val panel = dialog.findViewById<View>(androidx.appcompat.R.id.parentPanel)
            val limit = ((root.height - root.paddingTop - root.paddingBottom) * .8f).toInt().coerceAtLeast(dp(100))
            if (panel != null && panel.height > limit) panel.layoutParams = panel.layoutParams.apply { height = limit }
        }
    }

    fun install(actions: Channel) {
        channel = actions
        updateToolbar()
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
        personalization?.connection(if (next.phase == "connected") next.candidateUrl ?: next.lastSuccessUrl else null, next.generation)
        updateToolbar()
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
        val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(16), dp(20), dp(16)) }
        val heading = TextView(activity).apply { text = tr("Client settings", "客户端设置"); textSize = 20f; setTypeface(null, android.graphics.Typeface.BOLD); setPadding(0, 0, 0, dp(12)) }
        content.addView(heading)
        val labels = arrayOf(tr("Server address", "修改服务地址"), tr("Reload", "重新加载"), tr("Export Android diagnostics", "导出安卓诊断"), tr("Appearance & reading", "外观与阅读"))
        val icons = arrayOf("server", "reload", "export", "settings")
        labels.forEachIndexed { index, label ->
            val row = Button(activity).apply {
                tag = icons[index]; text = label; isAllCaps = false; textSize = 16f; gravity = Gravity.CENTER_VERTICAL or Gravity.START
                setPadding(dp(12), 0, dp(12), 0); minHeight = dp(56)
                background = android.graphics.drawable.RippleDrawable(ColorStateList.valueOf(Color.argb(30,100,130,190)), GradientDrawable().apply { setColor(surface); cornerRadius = dp(12).toFloat() }, null)
                setCompoundDrawablesRelative(Glyph(icons[index], secondary).apply { setBounds(0,0,dp(22),dp(22)) }, null, null, null)
                compoundDrawablePadding = dp(14)
                setOnClickListener {
                    menu?.dismiss()
                    when (index) { 0 -> showSettings(); 1 -> confirmLeaving { send("reload") }; 2 -> send("exportDiagnostics"); 3 -> personalization?.showAppearance() }
                }
            }
            content.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        menu = builder().setView(ScrollView(activity).apply { addView(content) }).create().also { dialog ->
            dialog.setOnDismissListener { menu = null }
            showImmersive(dialog)
        }
    }

    private fun showImmersive(dialog: AlertDialog) {
        dialog.setOnShowListener { dialog.window?.let { immersive(it) }; styleDialog(dialog) }
        dialog.show()
    }

    private fun confirmLeaving(action: () -> Unit) {
        confirmation = builder()
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
            textSize = 16f; minHeight = dp(52); setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        status = TextView(activity).apply { setPadding(0, dp(8), 0, dp(8)) }
        previous = Button(activity).apply {
            text = tr("Reopen previous server", "重新打开上次服务")
            visibility = if (state.lastSuccessUrl != null && state.phase == "failed") View.VISIBLE else View.GONE
            setOnClickListener { state.lastSuccessUrl?.let { start(it) } }
        }
        layout.addView(address); layout.addView(status); layout.addView(previous)
        val dialog = builder()
            .setTitle(tr("Connection settings", "连接设置"))
            .setView(ScrollView(activity).apply { addView(layout) })
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
            styleDialog(dialog)
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
        if (personalization?.dismissTop() == true) return
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

    fun resume() { if (!disposed) { personalization?.resume(); updateTheme(); immersive(activity.window); ViewCompat.requestApplyInsets(root) } }
    fun destroy() {
        disposed = true
        personalization?.destroy(); personalization = null
        confirmation?.dismiss(); settings?.dismiss(); menu?.dismiss()
        channel = null
        root.viewTreeObserver.removeOnWindowFocusChangeListener(focusListener)
        root.viewTreeObserver.removeOnGlobalLayoutListener(layoutListener)
        ViewCompat.setOnApplyWindowInsetsListener(root, null)
        button.setOnClickListener(null)
        (root.parent as? ViewGroup)?.removeView(root)
    }
}
