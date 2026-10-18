package local.openwebui.connectioncontrols

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import kotlin.math.max

/** All management originates in native controls. Remote pages get no new commands. */
internal class PersonalizationController(
    private val activity: Activity,
    private val webView: WebView,
    private val builder: () -> AlertDialog.Builder,
    private val style: (AlertDialog) -> Unit,
    private val themeChanged: () -> Unit,
    private val navigationChanged: (Boolean) -> Unit,
) {
    private val handler=Handler(Looper.getMainLooper())
    private val worker=Executors.newSingleThreadExecutor()
    private val store=WallpaperStore(activity)
    private val script=activity.assets.open("personalization.js").bufferedReader().use { it.readText() }
    private var origin: String?=null
    private var generation=0L
    private var revision=0L
    private var saved=AppearanceConfig()
    private var draft: AppearanceConfig?=null
    private var disposed=false
    private var inFlight=false
    private var dirty=true
    private var compatible=false
    private var page=""
    private var branch=""
    private var entries=emptyList<Pair<String,String>>()
    private var editor: AlertDialog?=null
    private var directory: AlertDialog?=null
    private var directoryRows: LinearLayout?=null
    private var directorySearch: EditText?=null
    private var editorStatus: TextView?=null
    private var pendingImport=false
    private var editorSession=0L
    private var pickerSession=-1L
    private val temporary=mutableSetOf<String>()
    private var renderKey=""
    private var renderRevision=0L
    private val wallpaper=FrameLayout(activity)
    private val image=ImageView(activity).apply { scaleType=ImageView.ScaleType.MATRIX }
    private val scrim=View(activity)
    private val originalBackground=webView.background?.constantState?.newDrawable()
    val current get()=draft ?: saved
    val darkOverride: Boolean? get()=if (!current.enabled || origin==null) null else when(current.mode) { "dark" -> true; "light" -> false; else -> null }
    val accentOverride: Int? get()=if(current.enabled && origin!=null) Color.parseColor(current.accent) else null
    private val dark get()=darkOverride ?: (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
    private val zh get()=ClientPolicy.chinese(activity.resources.configuration.locales[0].language)
    private fun tr(en: String, cn: String)=if(zh) cn else en
    private fun dp(n: Int)=(n*activity.resources.displayMetrics.density).toInt()
    private fun toast(en: String, cn: String) { Toast.makeText(activity,tr(en,cn),Toast.LENGTH_LONG).show() }
    private val launcher=(activity as ComponentActivity).activityResultRegistry.register(
        "owc-private-wallpaper", ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uri=result.data?.data
        if(result.resultCode==Activity.RESULT_OK && uri!=null && draft!=null && pickerSession==editorSession) {
            val pin=editorSession
            pendingImport=true; editorStatus?.text=tr("Importing…", "正在导入…")
            work {
                val imported=runCatching { store.importImage(uri) }
                handler.post {
                    if(disposed || pin!=editorSession || draft==null) imported.getOrNull()?.let(store::delete)
                    else {
                        pendingImport=false
                        imported.onSuccess { name -> temporary.add(name); draft=current.copy(image=name,background="image"); preview() }
                            .onFailure { toast("Could not import image. Use JPEG, PNG or WebP up to 20 MB.","导入失败，请选择不超过 20MB 的 JPEG、PNG 或 WebP 图片。") }
                        updateStatus()
                    }
                }
            }
        }
    }
    private val mirror=View.OnLayoutChangeListener { _,_,_,_,_,_,_,_,_ -> syncBounds() }
    private val poll=object : Runnable {
        override fun run() {
            if(disposed) return
            refresh()
            handler.postDelayed(this, if(directory!=null) 600 else 1200)
        }
    }
    init {
        wallpaper.isClickable=false; wallpaper.importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        image.addOnLayoutChangeListener { _,_,_,_,_,_,_,_,_ -> positionImage() }
        wallpaper.addView(image,FrameLayout.LayoutParams(-1,-1)); wallpaper.addView(scrim,FrameLayout.LayoutParams(-1,-1))
        val parent=webView.parent as ViewGroup
        parent.addView(wallpaper,parent.indexOfChild(webView),FrameLayout.LayoutParams(1,1))
        wallpaper.visibility=View.GONE
        webView.addOnLayoutChangeListener(mirror)
        wallpaper.post { syncBounds() }
        handler.post(poll)
    }
    private fun work(action: () -> Unit) { try { worker.execute(action) } catch (_: RejectedExecutionException) {} }
    fun connection(url: String?, nextGeneration: Long) {
        val next=AppearanceConfig.origin(url)
        if(next==origin && generation==nextGeneration) return
        editor?.dismiss(); directory?.dismiss()
        revision++; dirty=true; origin=next; generation=nextGeneration; saved=next?.let(store::load) ?: AppearanceConfig()
        compatible=false; page=""; branch=""; entries=emptyList(); renderKey=""
        navigationChanged(next!=null && saved.navigation)
        themeChanged(); updateWallpaper(); refresh()
    }
    private fun request(jump: String?=null): JSONObject = JSONObject().apply {
        put("origin",origin ?: ""); put("navigation",current.navigation)
        put("config",current.forPage(dark)); if(jump!=null) { put("jump",jump); put("page",page); put("branch",branch) }
    }
    private fun evaluate(input: JSONObject, result: (JSONObject) -> Unit) {
        val expectedOrigin=origin; val expectedGeneration=generation; val expectedRevision=revision
        val expectedUrl=webView.url
        if(disposed || expectedOrigin==null || AppearanceConfig.origin(expectedUrl)!=expectedOrigin) return
        // No window global or JavascriptInterface: each invocation returns its own result.
        webView.evaluateJavascript("($script)(${input})") { raw ->
            if(!disposed && origin==expectedOrigin && generation==expectedGeneration && revision==expectedRevision && webView.url==expectedUrl) {
                runCatching { JSONObject(raw) }.getOrNull()?.takeIf { AppearanceConfig.origin(it.optString("page"))==expectedOrigin }?.let(result)
            }
        }
    }
    private fun refresh() {
        if(inFlight || origin==null || (!current.enabled && !current.navigation && !compatible && !dirty)) return
        inFlight=true
        handler.postDelayed({ inFlight=false },2000)
        evaluate(request()) { report ->
            inFlight=false; dirty=false
            val supported=report.optBoolean("supported")
            val nextPage=report.optString("page"); val nextBranch=report.optString("branch")
            val changed=page!=nextPage || branch!=nextBranch
            page=nextPage; branch=nextBranch
            val array=report.optJSONArray("entries")
            val updated=if(array!=null) (0 until array.length()).mapNotNull { index ->
                val row=array.optJSONObject(index) ?: return@mapNotNull null
                val id=row.optString("id"); val summary=row.optString("text").take(160)
                if(id.startsWith("message-") && id.length<=256) id to summary else null
            } else emptyList()
            val repaint=changed || entries!=updated || compatible!=supported
            entries=updated; compatible=supported
            updateWallpaper(); updateStatus()
            if(repaint) renderDirectory()
        }
    }
    private fun syncBounds() {
        val source=webView.layoutParams
        val params=if(source is ViewGroup.MarginLayoutParams) FrameLayout.LayoutParams(source) else FrameLayout.LayoutParams(source)
        wallpaper.layoutParams=params
        image.post { positionImage() }
    }
    private fun positionImage() {
        val drawable=image.drawable ?: return
        if(image.width==0 || image.height==0) return
        val width=drawable.intrinsicWidth.toFloat(); val height=drawable.intrinsicHeight.toFloat()
        if(width<=0 || height<=0) return
        val scale=max(image.width/width,image.height/height)*current.zoom/100f
        image.imageMatrix=Matrix().apply {
            setScale(scale,scale)
            postTranslate((image.width-width*scale)/2f,(image.height-height*scale)*current.position/100f)
        }
    }
    private fun updateWallpaper() {
        val config=current
        val active=config.enabled && compatible && origin!=null && AppearanceConfig.origin(webView.url)==origin
        wallpaper.visibility=if(active) View.VISIBLE else View.GONE
        if(!active) { webView.background=originalBackground?.constantState?.newDrawable(); return }
        webView.setBackgroundColor(Color.TRANSPARENT)
        val colors=when(config.preset) {
            "sage" -> if(dark) intArrayOf(Color.rgb(15,37,37),Color.rgb(32,46,51)) else intArrayOf(Color.rgb(220,237,229),Color.rgb(233,240,243))
            "sand" -> if(dark) intArrayOf(Color.rgb(43,33,28),Color.rgb(30,29,35)) else intArrayOf(Color.rgb(247,231,210),Color.rgb(237,233,228))
            else -> if(dark) intArrayOf(Color.rgb(16,29,52),Color.rgb(33,33,49)) else intArrayOf(Color.rgb(216,232,252),Color.rgb(237,232,249))
        }
        if(config.background=="solid") colors.fill(if(dark) Color.rgb(17,19,24) else Color.rgb(248,250,252))
        wallpaper.background=GradientDrawable(GradientDrawable.Orientation.TL_BR,colors)
        scrim.setBackgroundColor(Color.argb(config.dim*255/100,if(dark) 0 else 255,if(dark) 0 else 255,if(dark) 0 else 255))
        image.visibility=if(config.background=="image") View.VISIBLE else View.GONE
        val key="${config.image}:${config.blur}:${config.background}"
        if(key!=renderKey) {
            renderKey=key; val pin=++renderRevision
            if(config.background=="image") work {
                val bitmap=runCatching { store.render(config) }.getOrNull()
                handler.post {
                    if(disposed || pin!=renderRevision) bitmap?.recycle()
                    else { image.setImageBitmap(bitmap); positionImage(); if(bitmap==null) toast("Wallpaper unavailable; showing a gradient.","壁纸不可用，已显示渐变背景。") }
                }
            } else image.setImageDrawable(null)
        }
        positionImage()
    }
    private fun preview() {
        revision++; dirty=true; inFlight=false; themeChanged(); navigationChanged(origin!=null && current.navigation)
        updateWallpaper(); editor?.let(style); directory?.let(style); updateStatus(); refresh()
    }
    private fun updateStatus() {
        editorStatus?.text=if(pendingImport) tr("Importing…","正在导入…") else if(compatible) tr("Live preview · image stays on this device","实时预览 · 图片仅保存在本机") else tr("Page not supported yet; original page preserved","当前页面暂不支持，保留网页原样")
    }
    fun showAppearance() {
        if(origin==null) { toast("Connect to a server first.","请先连接服务。"); return }
        if(editor!=null) return
        draft=saved.copy(); revision++
        val content=LinearLayout(activity).apply { orientation=LinearLayout.VERTICAL; setPadding(dp(20),dp(8),dp(20),dp(12)) }
        fun label(value: String) { content.addView(TextView(activity).apply { text=value; textSize=14f; setPadding(0,dp(12),0,dp(4)) }) }
        fun toggle(en: String, cn: String, checked: Boolean, change: (Boolean)->Unit) {
            content.addView(androidx.appcompat.widget.SwitchCompat(activity).apply {
                text=tr(en,cn); isChecked=checked; minHeight=dp(48)
                setOnCheckedChangeListener { _,value -> change(value); preview() }
            })
        }
        fun choice(title: String, labels: List<String>, index: Int, select: (Int)->Unit) {
            label(title)
            content.addView(Spinner(activity).apply {
                adapter=ArrayAdapter(activity,android.R.layout.simple_spinner_dropdown_item,labels)
                setSelection(index); minimumHeight=dp(48)
                var first=true
                onItemSelectedListener=object: AdapterView.OnItemSelectedListener {
                    override fun onNothingSelected(parent: AdapterView<*>?) {}
                    override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                        if(first) { first=false; if(position==index) return }
                        if(!content.isAttachedToWindow) return
                        select(position); preview()
                    }
                }
            })
        }
        fun slider(title: String, value: Int, min: Int, max: Int, change: (Int)->Unit) {
            val caption=TextView(activity).apply { text="$title · $value"; setPadding(0,dp(12),0,0) }; content.addView(caption)
            content.addView(SeekBar(activity).apply {
                this.max=max-min; progress=value-min; minimumHeight=dp(48)
                contentDescription=title
                setOnSeekBarChangeListener(object: SeekBar.OnSeekBarChangeListener {
                    override fun onStartTrackingTouch(bar: SeekBar?) {}
                    override fun onStopTrackingTouch(bar: SeekBar?) { preview() }
                    override fun onProgressChanged(bar: SeekBar?, progress: Int, user: Boolean) { if(user) { change(progress+min); caption.text="$title · ${progress+min}" } }
                })
            })
        }
        toggle("Enable appearance","启用外观定制",current.enabled) { draft=current.copy(enabled=it) }
        toggle("Conversation directory","启用对话目录",current.navigation) { draft=current.copy(navigation=it) }
        choice(tr("Palette","配色预设"),listOf(tr("Native blue","原生蓝"),tr("Sage","青灰"),tr("Warm sand","暖砂"),tr("Opaque reading","不透明阅读")),listOf("blue","sage","sand","reading").indexOf(current.preset)) {
            val preset=listOf("blue","sage","sand","reading")[it]
            if(preset!=current.preset) { draft=AppearanceConfig.preset(preset,current); rebuildEditor() }
        }
        choice(tr("Theme","明暗模式"),listOf(tr("System","跟随系统"),tr("Light","浅色"),tr("Dark","深色")),listOf("system","light","dark").indexOf(current.mode)) { draft=current.copy(mode=listOf("system","light","dark")[it]) }
        choice(tr("Background","背景"),listOf(tr("Gradient","内置渐变"),tr("Local image","本地图片"),tr("Solid","纯色")),listOf("gradient","image","solid").indexOf(current.background)) { draft=current.copy(background=listOf("gradient","image","solid")[it]) }
        content.addView(Button(activity).apply {
            text=tr("Choose image (up to 20 MB)","选择图片（不超过 20MB）"); isAllCaps=false; minHeight=dp(48)
            setOnClickListener {
                if(pendingImport) return@setOnClickListener
                pickerSession=editorSession
                try { launcher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type="image/*"
                    putExtra(Intent.EXTRA_MIME_TYPES,arrayOf("image/jpeg","image/png","image/webp"))
                }) } catch (_: Exception) { toast("Image picker unavailable.","无法打开系统选图器。") }
            }
        })
        val accent=EditText(activity).apply { setText(current.accent); isSingleLine=true; contentDescription=tr("Accent hex color","强调色十六进制"); hint="#2563EB"; minHeight=dp(48) }
        label(tr("Accent color (#RRGGBB)","强调色（#RRGGBB）")); content.addView(accent)
        accent.addTextChangedListener(object: android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int,count: Int,after: Int) {}
            override fun onTextChanged(s: CharSequence?,start: Int,before: Int,count: Int) { if(Regex("#[0-9a-fA-F]{6}").matches(s.toString())) { draft=current.copy(accent=s.toString()); preview() } }
            override fun afterTextChanged(s: android.text.Editable?) {}
        })
        slider(tr("Vertical crop position","裁切垂直位置"),current.position,0,100) { draft=current.copy(position=it) }
        slider(tr("Crop zoom (%)","裁切缩放（%）"),current.zoom,100,200) { draft=current.copy(zoom=it) }
        slider(tr("Scrim (%)","遮罩（%）"),current.dim,0,80) { draft=current.copy(dim=it) }
        slider(tr("Static blur","静态模糊"),current.blur,0,20) { draft=current.copy(blur=it) }
        slider(tr("Panel opacity (%)","面板不透明度（%）"),current.opacity,50,100) { draft=current.copy(opacity=it) }
        slider(tr("Chat text size","聊天正文字号"),current.fontSize,14,24) { draft=current.copy(fontSize=it) }
        slider(tr("Line height (%)","行距（%）"),current.lineHeight,130,210) { draft=current.copy(lineHeight=it) }
        editorStatus=TextView(activity).also { it.setPadding(0,dp(12),0,0); content.addView(it) }
        content.addView(Button(activity).apply { text=tr("Restore defaults","恢复默认"); isAllCaps=false; minHeight=dp(48); setOnClickListener { draft=AppearanceConfig(); preview(); rebuildEditor() } })
        val dialog=builder().setTitle(tr("Appearance & reading","外观与阅读"))
            .setView(ScrollView(activity).apply { addView(content) })
            .setNegativeButton(tr("Cancel","取消"),null).setPositiveButton(tr("Apply","应用"),null).create()
        editor=dialog
        dialog.setOnShowListener {
            style(dialog); updateStatus()
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if(pendingImport) { toast("Wait for image import.","请等待图片导入完成。"); return@setOnClickListener }
                if(!Regex("#[0-9a-fA-F]{6}").matches(accent.text.toString())) { accent.error=tr("Use #RRGGBB","请输入 #RRGGBB"); return@setOnClickListener }
                val target=origin ?: return@setOnClickListener
                try {
                    val previous=saved.image
                    store.save(target,current); saved=current.copy()
                    if(previous.isNotEmpty() && previous!=saved.image) store.delete(previous)
                    temporary.remove(saved.image)
                    dialog.dismiss()
                } catch (_: Exception) { toast("Could not save. Your previous settings are intact.","无法保存，原有设置保持不变。") }
            }
        }
        dialog.setOnDismissListener {
            if(editor===dialog) {
                editor=null; editorStatus=null; draft=null; editorSession++; revision++; dirty=true; inFlight=false; pendingImport=false
                temporary.forEach(store::delete); temporary.clear(); themeChanged()
                navigationChanged(origin!=null && saved.navigation); updateWallpaper(); refresh()
            }
        }
        dialog.show()
    }
    private fun rebuildEditor() {
        val keep=draft ?: return
        // Detach the dismissal rollback while rebuilding controls after a preset.
        editor?.setOnDismissListener(null); editor?.dismiss(); editor=null
        val original=saved
        saved=keep
        showAppearance()
        saved=original
    }
    fun showDirectory() {
        if(!current.navigation || directory!=null) return
        val content=LinearLayout(activity).apply { orientation=LinearLayout.VERTICAL; setPadding(dp(20),dp(8),dp(20),dp(12)) }
        content.addView(TextView(activity).apply { text=tr("Only loaded messages · no history requests","仅包含已加载消息 · 不额外请求历史") })
        directorySearch=EditText(activity).apply { hint=tr("Find a question","查找提问"); isSingleLine=true; minHeight=dp(48) }
        content.addView(directorySearch)
        directoryRows=LinearLayout(activity).apply { orientation=LinearLayout.VERTICAL }; content.addView(directoryRows)
        directorySearch?.addTextChangedListener(object: android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?,start: Int,count: Int,after: Int) {}
            override fun onTextChanged(s: CharSequence?,start: Int,before: Int,count: Int) { renderDirectory() }
            override fun afterTextChanged(s: android.text.Editable?) {}
        })
        directory=builder().setTitle(tr("Conversation directory","对话目录"))
            .setView(ScrollView(activity).apply { addView(content) }).setNegativeButton(tr("Close","关闭"),null)
            .create().also { dialog ->
                dialog.setOnShowListener { style(dialog); renderDirectory(); refresh() }
                dialog.setOnDismissListener { directory=null; directoryRows=null; directorySearch=null }
                dialog.show()
            }
    }
    private fun renderDirectory() {
        val list=directoryRows ?: return
        list.removeAllViews()
        val query=directorySearch?.text?.toString().orEmpty()
        val rows=entries.withIndex().filter { it.value.second.contains(query,ignoreCase=true) }
        if(!compatible || rows.isEmpty()) list.addView(TextView(activity).apply { text=if(!compatible) tr("This page is not supported.","当前页面暂不支持目录。") else tr("No matching loaded questions.","没有匹配的已加载提问。") })
        val expectedPage=page; val expectedBranch=branch
        rows.forEach { entry ->
            list.addView(Button(activity).apply {
                text="${entry.index+1}. ${entry.value.second}"; isAllCaps=false; minHeight=dp(48); gravity=android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
                setOnClickListener {
                    evaluate(request(entry.value.first).apply { put("page",expectedPage); put("branch",expectedBranch) }) { report ->
                        if(report.optBoolean("jumped")) directory?.dismiss()
                        else { entries=emptyList(); renderDirectory(); refresh(); toast("Message changed; directory refreshed.","消息已变化，正在刷新目录。") }
                    }
                }
            })
        }
        directory?.let(style)
    }
    fun dismissTop(): Boolean {
        if(directory!=null) { directory?.dismiss(); return true }
        if(editor!=null) { editor?.dismiss(); return true }
        return false
    }
    fun restyleDialogs() { editor?.let(style); directory?.let(style) }
    fun resume() { themeChanged(); editor?.let(style); directory?.let(style); dirty=true; updateWallpaper(); refresh() }
    fun destroy() {
        disposed=true; revision++; renderRevision++
        editor?.dismiss(); directory?.dismiss(); launcher.unregister(); handler.removeCallbacksAndMessages(null)
        temporary.forEach(store::delete); temporary.clear(); worker.shutdownNow()
        webView.removeOnLayoutChangeListener(mirror); (wallpaper.parent as? ViewGroup)?.removeView(wallpaper)
        webView.background=originalBackground
    }
}
