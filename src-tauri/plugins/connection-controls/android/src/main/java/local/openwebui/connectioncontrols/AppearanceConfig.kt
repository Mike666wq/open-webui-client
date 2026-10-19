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
    val opacity: Int = 90,
    val fontSize: Int = 16,
    val lineHeight: Int = 165,
) {
    fun json() = JSONObject().apply {
        put("schema", 1); put("enabled", enabled); put("navigation", navigation)
        put("preset", preset); put("mode", mode); put("accent", accent)
        put("background", background); put("image", image); put("position", position)
        put("zoom", zoom); put("dim", dim); put("blur", blur); put("opacity", opacity)
        put("fontSize", fontSize); put("lineHeight", lineHeight)
    }
    fun forPage(dark: Boolean) = json().apply { put("dark", dark) }
    companion object {
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
            require(value.optInt("schema", 1) == 1)
            fun choice(key: String, choices: List<String>, default: String) = value.optString(key).takeIf { it in choices } ?: default
            fun number(key: String, min: Int, max: Int, default: Int) = value.optInt(key, default).coerceIn(min, max)
            return AppearanceConfig(
                enabled = value.optBoolean("enabled"), navigation = value.optBoolean("navigation"),
                preset = choice("preset", listOf("blue", "sage", "sand", "reading"), "blue"),
                mode = choice("mode", listOf("system", "light", "dark"), "system"),
                accent = value.optString("accent").takeIf { Regex("#[0-9a-fA-F]{6}").matches(it) } ?: "#2563EB",
                background = choice("background", listOf("gradient", "image", "solid"), "gradient"),
                image = value.optString("image").takeIf { Regex("wallpaper-[a-f0-9-]+\\.jpg").matches(it) } ?: "",
                position = number("position",0,100,50), zoom = number("zoom",100,200,100),
                dim = number("dim",0,80,0), blur = number("blur",0,20,0), opacity = number("opacity",50,100,90),
                fontSize = number("fontSize",14,24,16), lineHeight = number("lineHeight",130,210,165),
            )
        }
        fun preset(id: String, current: AppearanceConfig): AppearanceConfig = when (id) {
            "sage" -> current.copy(preset=id, accent="#437C78", opacity=85, background=if(current.background=="solid") "gradient" else current.background)
            "sand" -> current.copy(preset=id, accent="#A16B45", opacity=90, background=if(current.background=="solid") "gradient" else current.background)
            "reading" -> current.copy(preset=id, background="solid", opacity=100, dim=0, blur=0)
            else -> current.copy(preset="blue", accent="#2563EB", opacity=90, background=if(current.background=="solid") "gradient" else current.background)
        }
    }
}
