package local.openwebui.connectioncontrols

import org.json.JSONObject
import java.net.URI
import java.util.Locale

/** Pure validation shared by persistence, preview and native->page requests. */
internal data class AppearanceConfig(
    val enabled: Boolean = false,
    val navigation: Boolean = false,
    val preset: String = "blue",
    val mode: String = "system",
    val accent: String = "#2563EB",
    val background: String = "gradient",
    val image: String = "",
    val position: Int = 50,
    val zoom: Int = 100,
    val dim: Int = 0,
    val blur: Int = 0,
    val opacity: Int = DEFAULT_OPACITY,
    val glassBlur: Int = 18,
    val radius: Int = 20,
    val codeTone: String = "auto",
    val fontSize: Int = 16,
    val lineHeight: Int = 165,
) {
    fun json() = JSONObject().apply {
        put("schema", SCHEMA); put("enabled", enabled); put("navigation", navigation)
        put("preset", preset); put("mode", mode); put("accent", accent)
        put("background", background); put("image", image); put("position", position)
        put("zoom", zoom); put("dim", dim); put("blur", blur); put("opacity", opacity)
        put("glassBlur", glassBlur); put("radius", radius); put("codeTone", codeTone)
        put("fontSize", fontSize); put("lineHeight", lineHeight)
    }
    fun forPage(dark: Boolean) = json().apply { put("dark", dark) }
    companion object {
        const val SCHEMA = 2
        const val DEFAULT_OPACITY = 50
        private val CODE_TONES = listOf("auto", "glass", "opaque")
        fun origin(value: String?): String? = runCatching {
            val uri = URI(value ?: "")
            val scheme = uri.scheme?.lowercase(Locale.ROOT)
            require(scheme in listOf("http", "https") && uri.userInfo == null && uri.host != null)
            val host = uri.host.lowercase(Locale.ROOT).let { if (it.contains(':') && !it.startsWith('[')) "[$it]" else it }
            val port = uri.port
            require(port in -1..65535)
            "$scheme://$host" + if (port == -1 || port == (if (scheme == "https") 443 else 80)) "" else ":$port"
        }.getOrNull()
        fun parse(value: JSONObject): AppearanceConfig {
            val schema = value.optInt("schema", 1)
            require(schema in 1..SCHEMA)
            fun choice(key: String, choices: List<String>, default: String) = value.optString(key).takeIf { it in choices } ?: default
            fun number(key: String, min: Int, max: Int, default: Int) = value.optInt(key, default).coerceIn(min, max)
            val legacyOpacity = schema == 1
            return AppearanceConfig(
                enabled = value.optBoolean("enabled"), navigation = value.optBoolean("navigation"),
                preset = choice("preset", listOf("blue", "sage", "sand", "reading"), "blue"),
                mode = choice("mode", listOf("system", "light", "dark"), "system"),
                accent = value.optString("accent").takeIf { Regex("#[0-9a-fA-F]{6}").matches(it) } ?: "#2563EB",
                background = choice("background", listOf("gradient", "image", "solid"), "gradient"),
                image = value.optString("image").takeIf { Regex("wallpaper-[a-f0-9-]+\\.jpg").matches(it) } ?: "",
                position = number("position",0,100,50), zoom = number("zoom",100,200,100),
                dim = number("dim",0,80,0), blur = number("blur",0,20,0),
                opacity = number("opacity", if (legacyOpacity) 50 else 40, 100, DEFAULT_OPACITY),
                glassBlur = number("glassBlur",0,30,18), radius = number("radius",0,28,20),
                codeTone = choice("codeTone", CODE_TONES, "auto"),
                fontSize = number("fontSize",14,24,16), lineHeight = number("lineHeight",130,210,165),
            )
        }
        fun preset(id: String, current: AppearanceConfig): AppearanceConfig = when (id) {
            "sage" -> current.copy(preset=id, accent="#437C78", opacity=60, background=if(current.background=="solid") "gradient" else current.background)
            "sand" -> current.copy(preset=id, accent="#A16B45", opacity=60, background=if(current.background=="solid") "gradient" else current.background)
            "reading" -> current.copy(preset=id, background="solid", opacity=100, glassBlur=0, dim=0, blur=0, codeTone="opaque")
            else -> current.copy(preset="blue", accent="#2563EB", opacity=DEFAULT_OPACITY, background=if(current.background=="solid") "gradient" else current.background)
        }
    }
}
