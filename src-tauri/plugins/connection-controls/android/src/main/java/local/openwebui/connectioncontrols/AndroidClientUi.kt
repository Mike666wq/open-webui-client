package local.openwebui.connectioncontrols

import android.app.Activity
import android.graphics.BitmapFactory
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
import android.widget.ImageView
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
    var recentUrls: List<String> = emptyList()
    var errorCode: String? = null
}

/** Owns only native chrome; never changes the remote DOM or its WebViewClient. */
internal class AndroidClientUi(private val activity: Activity, private val webView: WebView) {
    private val root = FrameLayout(activity)
    private val toolbar = LinearLayout(activity)
    private val title = TextView(activity)
    private val subtitle = TextView(activity)
    private val button = ImageButton(activity)
    private var channel: Channel? = null
    private var state = ClientStateArgs()
    private var connectionOverlay: FrameLayout? = null
    private var connectionScroll: ScrollView? = null
    private var connectionCard: LinearLayout? = null
    private var connectionImage: ImageView? = null
    private var connectionScrim: View? = null
    private var connectionTitle: TextView? = null
    private var connectionSubtitle: TextView? = null
    private var connectionClose: TextView? = null
    private var recentContainer: LinearLayout? = null
    private var recentLabel: TextView? = null
    private var reloadButton: Button? = null
    private var exportButton: Button? = null
    private var confirmation: AlertDialog? = null
    private var address: EditText? = null
    private var status: TextView? = null
    private var connect: Button? = null
    private var attempted = false
    private var hidePanelWhenConnected = false
    private var disposed = false
    private var clearHistoryGeneration = -1L
    private var lastInsets: WindowInsetsCompat? = null
    private val toolbarHeight get() = max(dp(52), title.lineHeight + subtitle.lineHeight + dp(10))
    private var night: Boolean? = null
    private var fontScale = 0f
    private val dark get() = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private val surface get() = Color.parseColor(if (dark) "#111318" else "#F8FAFC")
    private val foregroundColor get() = Color.parseColor(if (dark) "#E5E7EB" else "#111827")
    private val secondary get() = Color.parseColor(if (dark) "#A6AFBD" else "#596579")
    private val accent get() = Color.parseColor(if (dark) "#93B4FF" else "#2563EB")
    private val fieldSurface get() = Color.parseColor(if (dark) "#20242C" else "#EDF1F7")
    private val radius = 20
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
            GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(surface) })
        toolbar.addView(button, LinearLayout.LayoutParams(dp(48), dp(48)))
        root.addView(toolbar, FrameLayout.LayoutParams(-1, toolbarHeight, Gravity.TOP))
        button.setOnClickListener { showConnectionPanel(autoHideOnConnect = state.phase != "connected") }
        ensureConnectionPanel()
        if (state.phase != "connected") showConnectionPanel(autoHideOnConnect = true)
        updateTheme(force = true)
        updateToolbar()
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            lastInsets = insets; layoutInsets(insets)
            insets // Preserve sibling dispatch on API 29; don't consume root insets.
        }
        root.viewTreeObserver.addOnWindowFocusChangeListener(focusListener)
        root.viewTreeObserver.addOnGlobalLayoutListener(layoutListener)
        root.addOnLayoutChangeListener { _, l, t, r, b, oldL, oldT, oldR, oldB ->
            if (r-l != oldR-oldL || b-t != oldB-oldT) listOfNotNull(confirmation).forEach { styleDialog(it) }
        }
        // Establish the unmodified bundled official UI first. Legacy appearance
        // files remain on disk but no DOM adapter, wallpaper or directory runs.
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
        connectionScroll?.layoutParams?.let { params ->
            val available = (root.height - safeTop - bottom).coerceAtLeast(dp(240))
            val desired = minOf(dp(720), (available * .9f).toInt())
            if (params.height != desired) {
                params.height = desired
                connectionScroll?.layoutParams = params
            }
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
        toolbar.background = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            if (dark) intArrayOf(0xF4181B22.toInt(), 0xF2111318.toInt())
            else intArrayOf(0xFAFFFFFF.toInt(), 0xF5F1F5F9.toInt())
        ).apply {
            setStroke(dp(1), Color.argb(if (dark) 44 else 76, 255, 255, 255))
        }
        title.setTextColor(foregroundColor); subtitle.setTextColor(secondary)
        button.setImageDrawable(Glyph("settings", foregroundColor))
        button.background = android.graphics.drawable.RippleDrawable(
            ColorStateList.valueOf(Color.argb(if (dark) 48 else 34, 96, 128, 176)),
            GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(if (dark) 52 else 28, 255, 255, 255))
                setStroke(dp(1), Color.argb(if (dark) 48 else 34, 148, 163, 184))
            },
            GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(28, 96, 128, 176))
            }
        )
        activity.window.statusBarColor = surface
        activity.window.navigationBarColor = surface
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.isAppearanceLightNavigationBars = !dark
        controller.isAppearanceLightStatusBars = !dark
        listOfNotNull(confirmation).forEach { styleDialog(it) }
        styleConnectionPanel()
        if (connectionOverlay?.visibility == View.VISIBLE) updateConnectionPanel()
    }

    private fun builder() = AlertDialog.Builder(ContextThemeWrapper(activity,
        if (dark) androidx.appcompat.R.style.Theme_AppCompat_Dialog_Alert else androidx.appcompat.R.style.Theme_AppCompat_Light_Dialog_Alert))

    private fun styleDialog(dialog: AlertDialog) {
        if (disposed || !dialog.isShowing) return
        val window = dialog.window ?: return
        window.setBackgroundDrawable(GradientDrawable().apply { setColor(surface); cornerRadius = dp(radius).toFloat() })
        window.decorView.clipToOutline = true
        window.setGravity(Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
        val displayWidth = activity.resources.displayMetrics.widthPixels
        window.setLayout(minOf(displayWidth - dp(24), dp(600)), ViewGroup.LayoutParams.WRAP_CONTENT)
        val safeBottom = lastInsets?.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.displayCutout())?.bottom ?: 0
        window.attributes = window.attributes.apply { y = safeBottom + dp(12); dimAmount = .35f }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        window.decorView.minimumHeight = dp(100)
        dialog.findViewById<TextView>(androidx.appcompat.R.id.alertTitle)?.setTextColor(foregroundColor)
        dialog.findViewById<TextView>(android.R.id.message)?.setTextColor(secondary)
        fun recolor(view: View) {
            if (view is TextView) view.setTextColor(if (view is Button) accent else foregroundColor)
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
            setTextColor(foregroundColor); setHintTextColor(secondary)
            backgroundTintList = null
            background = GradientDrawable().apply { setColor(fieldSurface); cornerRadius = dp(radius).toFloat(); setStroke(dp(1), accent) }
        }
        status?.setTextColor(secondary)
        for (which in arrayOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE)) {
            dialog.getButton(which)?.apply {
                isAllCaps = false; minHeight = dp(48); setTextColor(accent)
                if (which == AlertDialog.BUTTON_POSITIVE) {
                    setTextColor(if (Color.luminance(accent) > .35f) Color.parseColor("#111827") else Color.WHITE)
                    background = GradientDrawable().apply { setColor(accent); cornerRadius = dp(radius).toFloat() }
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
        updateToolbar()
        if (next.phase == "connected" && clearHistoryGeneration != next.generation) {
            clearHistoryGeneration = next.generation
            webView.clearHistory() // Do not retain local startup or the previous server.
        }
        if (next.phase == "connected" && next.errorCode == null && hidePanelWhenConnected) {
            attempted = false
            confirmation?.dismiss()
            hideConnectionPanel()
        }
        if (next.phase == "failed" && (old.phase == "connecting" || attempted)) showConnectionPanel()
        if (next.phase != "connected") showConnectionPanel(autoHideOnConnect = true)
        updateConnectionPanel()
    }

    private fun ensureConnectionPanel() {
        if (connectionOverlay != null || disposed) return
        val overlay = FrameLayout(activity).apply {
            visibility = View.GONE
            isClickable = true
            contentDescription = tr("Server connection", "服务器连接")
        }
        connectionImage = ImageView(activity).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            alpha = .92f
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(0xFFB7CBE6.toInt(), 0xFFE5DCC4.toInt())
            )
            val bitmap = sequenceOf(
                "connection-welcome.webp",
                "bundled-frontend/assets/welcome.webp"
            ).firstNotNullOfOrNull { asset ->
                runCatching {
                    activity.assets.open(asset).use { BitmapFactory.decodeStream(it) }
                }.getOrNull()
            }
            if (bitmap != null) setImageBitmap(bitmap)
        }
        overlay.addView(connectionImage, FrameLayout.LayoutParams(-1, -1))
        connectionScrim = View(activity)
        overlay.addView(connectionScrim, FrameLayout.LayoutParams(-1, -1))

        val card = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            elevation = dp(12).toFloat()
            setPadding(dp(22), dp(20), dp(22), dp(20))
        }
        connectionCard = card
        val brand = TextView(activity).apply {
            text = "OPEN WEBUI  ·  ANDROID"
            textSize = 10.5f
            letterSpacing = .12f
            setTypeface(null, android.graphics.Typeface.BOLD)
        }
        card.addView(brand, LinearLayout.LayoutParams(-1, -2))
        val header = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
        }
        val heading = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        connectionTitle = TextView(activity).apply {
            textSize = 27f
            setTypeface(null, android.graphics.Typeface.BOLD)
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
        }
        connectionSubtitle = TextView(activity).apply {
            textSize = 13f
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(4), 0, 0)
        }
        heading.addView(connectionTitle)
        heading.addView(connectionSubtitle)
        header.addView(heading, LinearLayout.LayoutParams(0, -2, 1f))
        connectionClose = TextView(activity).apply {
            text = "×"
            textSize = 26f
            gravity = Gravity.CENTER
            minWidth = dp(48); minHeight = dp(48)
            contentDescription = tr("Close connection settings", "关闭连接设置")
            setOnClickListener { closeConnectionPanel() }
        }
        header.addView(connectionClose, LinearLayout.LayoutParams(dp(48), dp(48)))
        card.addView(header, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })

        val addressLabel = TextView(activity).apply {
            text = tr("Server address", "服务地址")
            textSize = 12f
            setTypeface(null, android.graphics.Typeface.BOLD)
        }
        card.addView(addressLabel, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(18) })
        address = EditText(activity).apply {
            isSingleLine = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://chat.example.com"
            contentDescription = tr("Server address", "服务地址")
            textSize = 16f
            minHeight = dp(52)
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        card.addView(address, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
        status = TextView(activity).apply {
            textSize = 12.5f
            setPadding(0, dp(8), 0, dp(2))
            visibility = View.GONE
        }
        card.addView(status, LinearLayout.LayoutParams(-1, -2))
        connect = Button(activity).apply {
            text = tr("Connect securely", "安全连接")
            isAllCaps = false
            textSize = 15f
            minHeight = dp(50)
            setOnClickListener { connectFromInput() }
        }
        card.addView(connect, LinearLayout.LayoutParams(-1, dp(50)).apply { topMargin = dp(10) })

        recentLabel = TextView(activity).apply {
            text = tr("Recent servers", "最近服务")
            textSize = 12f
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, dp(18), 0, dp(6))
        }
        card.addView(recentLabel, LinearLayout.LayoutParams(-1, -2))
        recentContainer = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        card.addView(recentContainer, LinearLayout.LayoutParams(-1, -2))

        val actions = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        reloadButton = utilityButton(tr("Reload", "重新加载"), "reload") {
            confirmLeaving { send("reload") }
        }
        exportButton = utilityButton(tr("Export diagnostics", "导出诊断"), "export") {
            send("exportDiagnostics")
        }
        actions.addView(reloadButton, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
        actions.addView(exportButton, LinearLayout.LayoutParams(0, -2, 1f))
        card.addView(actions, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(18) })

        val scroll = ScrollView(activity).apply {
            isFillViewport = true
            addView(card, ViewGroup.LayoutParams(-1, -2))
        }
        connectionScroll = scroll
        overlay.addView(scroll, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply {
            leftMargin = dp(12); rightMargin = dp(12); bottomMargin = dp(8)
        })
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        connectionOverlay = overlay
        styleConnectionPanel()
    }

    private fun utilityButton(label: String, kind: String, action: () -> Unit) = Button(activity).apply {
        text = label; isAllCaps = false; textSize = 13f; minHeight = dp(46)
        setCompoundDrawablesRelative(
            Glyph(kind, secondary).apply { setBounds(0, 0, dp(18), dp(18)) },
            null, null, null
        )
        compoundDrawablePadding = dp(8)
        setOnClickListener { action() }
    }

    private fun showConnectionPanel(autoHideOnConnect: Boolean = false) {
        if (disposed) return
        ensureConnectionPanel()
        val overlay = connectionOverlay ?: return
        hidePanelWhenConnected = hidePanelWhenConnected || autoHideOnConnect
        if (overlay.visibility != View.VISIBLE) {
            address?.setText(state.candidateUrl ?: state.lastSuccessUrl ?: "")
            overlay.visibility = View.VISIBLE
        }
        overlay.bringToFront()
        updateConnectionPanel()
    }

    private fun hideConnectionPanel() {
        if (state.phase == "connected") {
            connectionOverlay?.visibility = View.GONE
            hidePanelWhenConnected = false
        }
    }

    private fun closeConnectionPanel() {
        if (state.phase == "connected") {
            hideConnectionPanel()
        } else {
            cancelIfConnecting()
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

    private fun connectFromInput() {
        val value = address?.text?.toString()?.trim() ?: ""
        if (isSameServiceAddress(value)) {
            hideConnectionPanel()
        } else if (state.phase == "connected") {
            confirmLeaving { start(value) }
        } else {
            start(value)
        }
    }

    private fun isSameServiceAddress(value: String): Boolean =
        state.phase == "connected" && ClientPolicy.sameServiceEntry(value, state.candidateUrl)

    private fun updateConnectionPanel() {
        if (disposed || connectionOverlay == null) return
        val connected = state.phase == "connected"
        connectionTitle?.text = if (connected) tr("Connection settings", "连接设置") else tr("Connect to Open WebUI", "连接 Open WebUI")
        connectionSubtitle?.text = if (connected) {
            ClientPolicy.serviceLabel(state.candidateUrl)
        } else {
            tr("Your server address and login stay on this device.", "服务地址与登录状态只保存在本机。")
        }
        connectionClose?.visibility = if (connected) View.VISIBLE else View.INVISIBLE
        val currentAddress = state.candidateUrl ?: state.lastSuccessUrl
        if (address != null && !address!!.hasFocus()) {
            val nextAddress = currentAddress ?: ""
            if (address!!.text?.toString() != nextAddress) address!!.setText(nextAddress)
        }
        status?.text = when {
            state.errorCode == "invalidAddress" -> tr("Enter an HTTP(S) origin without a path, credentials, query or fragment.", "请输入不含路径、账号密码、查询参数或锚点的 HTTP(S) 服务地址。")
            state.errorCode != null -> tr("Connection failed. Retry or reopen a recent server.", "连接失败，请重试或重新打开最近服务。")
            state.phase == "connecting" -> tr("Connecting…", "正在连接…")
            else -> ""
        }
        status?.visibility = if (status?.text.isNullOrBlank()) View.GONE else View.VISIBLE
        connect?.text = when {
            state.phase == "connecting" -> tr("Connecting…", "正在连接…")
            connected -> tr("Switch server", "切换服务")
            else -> tr("Connect securely", "安全连接")
        }
        connect?.isEnabled = channel != null && state.phase != "connecting"
        reloadButton?.visibility = if (connected) View.VISIBLE else View.GONE
        exportButton?.visibility = if (connected) View.VISIBLE else View.GONE
        reloadButton?.isEnabled = state.phase == "connected" && channel != null
        exportButton?.isEnabled = state.phase == "connected" && channel != null
        rebuildRecentServices()
        styleConnectionPanel()
    }

    private fun rebuildRecentServices() {
        val list = recentContainer ?: return
        list.removeAllViews()
        val values = state.recentUrls
        recentLabel?.visibility = if (values.isEmpty()) View.GONE else View.VISIBLE
        values.forEach { value ->
            val active = ClientPolicy.sameOrigin(value, state.candidateUrl)
            val row = Button(activity).apply {
                text = ClientPolicy.serviceLabel(value) + if (active) {
                    "\n" + tr("Current server", "当前服务")
                } else {
                    "\n" + tr("Tap to switch", "点击切换")
                }
                isAllCaps = false
                textSize = 14f
                gravity = Gravity.CENTER_VERTICAL or Gravity.START
                minHeight = dp(58)
                setPadding(dp(14), dp(8), dp(14), dp(8))
                isEnabled = state.phase != "connecting" && !active
                setTextColor(foregroundColor)
                setLineSpacing(0f, 1.15f)
                background = android.graphics.drawable.RippleDrawable(
                    ColorStateList.valueOf(Color.argb(32, 96, 128, 176)),
                    GradientDrawable().apply {
                        setColor(fieldSurface)
                        cornerRadius = dp(16).toFloat()
                        setStroke(dp(1), Color.argb(if (dark) 40 else 70, 255, 255, 255))
                    },
                    null
                )
                setOnClickListener {
                    if (state.phase == "connected") confirmLeaving { start(value) } else start(value)
                }
            }
            list.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(6) })
        }
    }

    private fun styleConnectionPanel() {
        val card = connectionCard ?: return
        connectionImage?.alpha = if (dark) .5f else .88f
        connectionScrim?.background = GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            if (dark) intArrayOf(0xD9080D15.toInt(), 0xF4121822.toInt(), 0xFF111318.toInt())
            else intArrayOf(0x08101820, 0xA8E7EEF4.toInt(), 0xFFF8FAFC.toInt())
        )
        card.background = GradientDrawable().apply {
            setColor(Color.argb(if (dark) 238 else 244, Color.red(surface), Color.green(surface), Color.blue(surface)))
            cornerRadii = floatArrayOf(
                dp(26).toFloat(), dp(26).toFloat(), dp(26).toFloat(), dp(26).toFloat(),
                dp(8).toFloat(), dp(8).toFloat(), dp(8).toFloat(), dp(8).toFloat()
            )
            setStroke(dp(1), Color.argb(if (dark) 40 else 100, 255, 255, 255))
        }
        connectionTitle?.setTextColor(foregroundColor)
        connectionSubtitle?.setTextColor(secondary)
        connectionClose?.setTextColor(secondary)
        address?.apply {
            setTextColor(foregroundColor); setHintTextColor(Color.argb(150, Color.red(secondary), Color.green(secondary), Color.blue(secondary)))
            background = GradientDrawable().apply {
                setColor(fieldSurface); cornerRadius = dp(16).toFloat()
                setStroke(dp(1), Color.argb(if (dark) 64 else 42, Color.red(accent), Color.green(accent), Color.blue(accent)))
            }
        }
        status?.setTextColor(secondary)
        connect?.apply {
            setTextColor(if (Color.luminance(accent) > .45f) Color.parseColor("#111827") else Color.WHITE)
            backgroundTintList = ColorStateList.valueOf(accent)
            background = GradientDrawable().apply { setColor(accent); cornerRadius = dp(16).toFloat() }
        }
        reloadButton?.setTextColor(secondary)
        exportButton?.setTextColor(secondary)
        reloadButton?.background = GradientDrawable().apply { setColor(fieldSurface); cornerRadius = dp(14).toFloat() }
        exportButton?.background = GradientDrawable().apply { setColor(fieldSurface); cornerRadius = dp(14).toFloat() }
        recentLabel?.setTextColor(secondary)
    }

    private fun start(value: String) {
        attempted = true
        hidePanelWhenConnected = true
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
        if (connectionOverlay?.visibility == View.VISIBLE) {
            if (state.phase == "connected") {
                hideConnectionPanel()
            } else {
                cancelIfConnecting()
                activity.moveTaskToBack(true)
            }
            return
        }
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

    fun resume() { if (!disposed) { updateTheme(); immersive(activity.window); ViewCompat.requestApplyInsets(root) } }
    fun destroy() {
        disposed = true
        confirmation?.dismiss()
        channel = null
        root.viewTreeObserver.removeOnWindowFocusChangeListener(focusListener)
        root.viewTreeObserver.removeOnGlobalLayoutListener(layoutListener)
        ViewCompat.setOnApplyWindowInsetsListener(root, null)
        button.setOnClickListener(null)
        (connectionOverlay?.parent as? ViewGroup)?.removeView(connectionOverlay)
        connectionOverlay = null
        connectionScroll = null
        connectionCard = null
        connectionImage = null
        connectionScrim = null
        connectionTitle = null
        connectionSubtitle = null
        connectionClose = null
        recentContainer = null
        recentLabel = null
        reloadButton = null
        exportButton = null
        address = null
        status = null
        connect = null
        (root.parent as? ViewGroup)?.removeView(root)
    }
}
