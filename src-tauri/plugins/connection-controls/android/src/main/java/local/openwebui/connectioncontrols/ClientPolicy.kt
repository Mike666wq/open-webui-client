package local.openwebui.connectioncontrols

import java.net.URI

internal object ClientPolicy {
    fun chinese(language: String) = language.equals("zh", ignoreCase = true)
    fun contentTop(safeTop: Int, toolbarHeight: Int, rootHeight: Int): Int =
        (safeTop.coerceAtLeast(0) + toolbarHeight.coerceAtLeast(0)).coerceAtMost((rootHeight - 1).coerceAtLeast(0))

    fun serviceLabel(origin: String?): String = try {
        val uri = URI(origin ?: "")
        val host = uri.host ?: throw IllegalArgumentException()
        require(uri.scheme?.lowercase(java.util.Locale.ROOT) in listOf("http", "https") && uri.userInfo == null)
        val displayHost = if (host.contains(':') && !host.startsWith('[')) "[$host]" else host
        val defaultPort = if (uri.scheme.equals("https", true)) 443 else 80
        displayHost + if (uri.port >= 0 && uri.port != defaultPort) ":${uri.port}" else ""
    } catch (_: Exception) { "Open WebUI" }

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
