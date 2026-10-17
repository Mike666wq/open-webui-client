package local.openwebui.connectioncontrols

import java.net.URI

internal object ClientPolicy {
    fun chinese(language: String) = language.equals("zh", ignoreCase = true)
    fun buttonOffset(fraction: Float, height: Int, top: Int, bottom: Int, size: Int): Int =
        ((height - top - bottom - size).coerceAtLeast(0) * fraction.coerceIn(0f, 1f)).toInt()

    // A resize may already have removed the keyboard area. Subtract only overlap
    // with the actual root, never the full IME inset a second time.
    fun bottomOverlap(rootBottom: Int, windowBottom: Int, inset: Int): Int =
        (rootBottom - (windowBottom - inset)).coerceAtLeast(0)

    fun sameOrigin(left: String?, right: String?): Boolean = try {
        val a = URI(left ?: ""); val b = URI(right ?: "")
        fun port(uri: URI) = if (uri.port >= 0) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
        a.host != null && b.host != null && a.userInfo == null && b.userInfo == null &&
            a.scheme?.lowercase(java.util.Locale.ROOT) in listOf("http", "https") && a.scheme.equals(b.scheme, true) &&
            a.host.equals(b.host, true) && port(a) == port(b)
    } catch (_: Exception) { false }
}
