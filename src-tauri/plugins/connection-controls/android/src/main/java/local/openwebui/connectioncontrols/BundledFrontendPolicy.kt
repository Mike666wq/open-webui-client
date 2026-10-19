package local.openwebui.connectioncontrols

import org.json.JSONObject
import java.io.InputStream
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Locale

/** Immutable build metadata and routing rules; intentionally independent of Android. */
internal data class BundledFrontendFile(
    val path: String,
    val sha256: String,
    val size: Long,
    val mime: String,
)

internal class BundledFrontendManifest private constructor(
    val upstreamVersion: String,
    val upstreamCommit: String,
    val sourceRepository: String,
    val sourceCommit: String,
    val entry: String,
    val files: Map<String, BundledFrontendFile>,
    private val pageRoutes: List<Regex>,
) {
    private val assetRoots = files.keys.mapNotNull { file ->
        file.indexOf('/').takeIf { it > 0 }?.let { "/${file.substring(0, it)}/" }
    }.toSet()

    fun isPage(path: String): Boolean = pageRoutes.any { it.matches(path) }

    fun ownsAssetNamespace(path: String): Boolean =
        path.startsWith("/_app/") || assetRoots.any(path::startsWith)

    companion object {
        const val ASSET_DIRECTORY = "bundled-frontend"
        const val MANIFEST_FILE = "frontend-manifest.json"
        private val commit = Regex("[0-9a-f]{40}")
        private val digest = Regex("[0-9a-f]{64}")
        private val mime = Regex("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+")

        fun parse(json: JSONObject): BundledFrontendManifest {
            require(json.getInt("schema") == 1) { "Unsupported frontend manifest" }
            val upstreamVersion = json.getString("upstreamVersion")
            require(upstreamVersion == "0.12.2") { "Unsupported upstream frontend" }
            val upstreamCommit = json.getString("upstreamCommit")
            val sourceCommit = json.getString("sourceCommit")
            require(commit.matches(upstreamCommit) && commit.matches(sourceCommit))
            val sourceRepository = json.getString("sourceRepository")
            require(sourceRepository.isNotBlank() && sourceRepository.length <= 512 &&
                sourceRepository.none(Char::isISOControl))
            val entry = json.getString("entry")
            require(entry == "index.html")
            val sourceFiles = json.getJSONArray("files")
            require(sourceFiles.length() in 1..50_000)
            val files = linkedMapOf<String, BundledFrontendFile>()
            for (index in 0 until sourceFiles.length()) {
                val item = sourceFiles.getJSONObject(index)
                val path = item.getString("path")
                require(validAssetPath(path) && path != MANIFEST_FILE)
                require(!BundledFrontendPolicy.isNetworkPath("/$path"))
                val sha256 = item.getString("sha256")
                val size = item.getLong("size")
                val contentType = item.getString("mime")
                require(digest.matches(sha256) && size in 0..256L * 1024 * 1024 &&
                    mime.matches(contentType))
                require(files.put(path, BundledFrontendFile(path, sha256, size, contentType)) == null) {
                    "Duplicate frontend asset"
                }
            }
            require(files[entry]?.mime == "text/html")
            val sourceRoutes = json.getJSONArray("pageRoutes")
            require(sourceRoutes.length() in 1..1024)
            val routes = (0 until sourceRoutes.length()).map { index ->
                val route = sourceRoutes.getString(index)
                require(route.length in 3..2048 && route.startsWith("^") && route.endsWith("$"))
                Regex(route)
            }
            require(routes.any { it.matches("/") }) { "Missing frontend root route" }
            return BundledFrontendManifest(
                upstreamVersion, upstreamCommit, sourceRepository, sourceCommit,
                entry, files.toMap(), routes,
            )
        }

        fun validAssetPath(path: String): Boolean =
            path.isNotEmpty() && path.length <= 2048 && !path.startsWith('/') &&
                path.none { it.isISOControl() || it in "\\?#%" } &&
                path.split('/').all { it.isNotEmpty() && it != "." && it != ".." }
    }
}

internal data class FrontendConnectionSnapshot(
    val origin: String,
    val generation: Long,
    val revision: Long,
) {
    companion object {
        fun create(address: String?, generation: Long, revision: Long): FrontendConnectionSnapshot? {
            if (generation < 0 || revision < 0) return null
            val origin = BundledFrontendPolicy.origin(address) ?: return null
            val uri = runCatching { URI(address) }.getOrNull() ?: return null
            if (uri.rawPath !in listOf("", "/") || uri.rawQuery != null || uri.rawFragment != null ||
                uri.host.equals("tauri.localhost", ignoreCase = true)) return null
            return FrontendConnectionSnapshot(origin, generation, revision)
        }
    }
}

internal sealed class BundledFrontendRoute {
    object Network : BundledFrontendRoute()
    data class Asset(val file: BundledFrontendFile) : BundledFrontendRoute()
    object MissingAsset : BundledFrontendRoute()
    object Unavailable : BundledFrontendRoute()
}

/** Monotonic connection state, shared by the UI thread and resource callback threads. */
internal class FrontendSessionGate {
    internal data class Selection(
        val generation: Long,
        val revision: Long,
        val snapshot: FrontendConnectionSnapshot?,
    )

    @Volatile private var current = Selection(-1, -1, null)

    fun read(): Selection = current

    @Synchronized
    fun prepare(address: String?, generation: Long): Boolean {
        val previous = current
        if (generation < previous.generation) return false
        val next = FrontendConnectionSnapshot.create(address, generation, maxOf(0, previous.revision))
            ?: return false
        if (generation == previous.generation) {
            return previous.snapshot?.origin == next.origin
        }
        current = Selection(generation, previous.revision, next)
        return true
    }

    @Synchronized
    fun update(address: String?, generation: Long, revision: Long, active: Boolean) {
        val previous = current
        if (generation < previous.generation || revision <= previous.revision) return
        current = Selection(
            generation, revision,
            if (active) FrontendConnectionSnapshot.create(address, generation, revision) else null,
        )
    }

    fun isCurrent(selection: Selection): Boolean {
        val expected = selection.snapshot ?: return false
        val actual = current.snapshot ?: return false
        return actual.origin == expected.origin && actual.generation == expected.generation
    }
}

internal object BundledFrontendPolicy {
    // These remain genuine WebView network requests, including POST bodies, cookies,
    // redirects, event streams, WebSocket upgrades and authenticated downloads.
    private val networkRoots = setOf(
        "api", "ws", "socket.io", "openai", "ollama", "oauth", "cache",
        "health", "metrics", "docs", "redoc", "download", "downloads",
    )
    private val executableExtensions = setOf("js", "mjs", "css", "wasm", "map")
    private val encodedTraversal = Regex("%(?:2f|5c|2e|00)", RegexOption.IGNORE_CASE)

    fun origin(address: String?): String? = runCatching {
        val uri = URI(address ?: "")
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        require(scheme == "http" || scheme == "https")
        require(uri.rawUserInfo == null && uri.host != null && uri.port in -1..65535)
        val host = uri.host.lowercase(Locale.ROOT).let {
            if (it.contains(':') && !it.startsWith('[')) "[$it]" else it
        }
        val defaultPort = if (scheme == "https") 443 else 80
        "$scheme://$host" + if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
    }.getOrNull()

    fun isNetworkPath(path: String): Boolean =
        path.removePrefix("/").substringBefore('/').lowercase(Locale.ROOT) in networkRoots ||
            path == "/static/swagger-ui" || path.startsWith("/static/swagger-ui/")

    fun route(
        snapshot: FrontendConnectionSnapshot?,
        method: String,
        address: String,
        mainFrame: Boolean,
        manifest: BundledFrontendManifest?,
    ): BundledFrontendRoute {
        if (snapshot == null || method != "GET" || origin(address) != snapshot.origin) {
            return BundledFrontendRoute.Network
        }
        val uri = runCatching { URI(address) }.getOrNull() ?: return BundledFrontendRoute.Network
        val rawPath = uri.rawPath.takeUnless { it.isNullOrEmpty() } ?: "/"
        val path = uri.path.takeUnless { it.isNullOrEmpty() } ?: "/"
        if (isNetworkPath(path)) return BundledFrontendRoute.Network
        if (rawPath.contains('\\') || encodedTraversal.containsMatchIn(rawPath)) {
            return BundledFrontendRoute.MissingAsset
        }
        if (path.split('/').any { it == "." || it == ".." }) {
            return BundledFrontendRoute.MissingAsset
        }
        if (path.any(Char::isISOControl)) return BundledFrontendRoute.MissingAsset
        val queryKeys = uri.rawQuery.orEmpty().split('&').map {
            runCatching { URLDecoder.decode(it.substringBefore('='), "UTF-8") }
                .getOrDefault("").lowercase(Locale.ROOT)
        }
        if ("download" in queryKeys || "attachment" in queryKeys) return BundledFrontendRoute.Network
        // v0.12.2's OpenWebUIMiddleware normalizes legacy share/watch URLs
        // before serving the SPA. Preserve that real server redirect first.
        if ("shared" in queryKeys || (path.endsWith("/watch") && "v" in queryKeys)) {
            return BundledFrontendRoute.Network
        }
        if (manifest == null) {
            return if (mainFrame || path.startsWith("/_app/")) BundledFrontendRoute.Unavailable
            else BundledFrontendRoute.Network
        }
        manifest.files[path.removePrefix("/")]?.let { return BundledFrontendRoute.Asset(it) }
        if (mainFrame && manifest.isPage(path)) {
            return BundledFrontendRoute.Asset(manifest.files.getValue(manifest.entry))
        }
        val executable = path.substringAfterLast('.', "").lowercase(Locale.ROOT) in executableExtensions
        // /static is a mutable backend mount too (including model/profile
        // images). Serve inventoried assets locally, but let unlisted media
        // reach the server instead of claiming the entire namespace.
        if (path.startsWith("/static/") && !executable) return BundledFrontendRoute.Network
        // Never combine an APK's runtime with an old/new server chunk after a
        // missing asset or a partial bundle. Unknown backend resources stay remote.
        if (manifest.ownsAssetNamespace(path) || executable) {
            return BundledFrontendRoute.MissingAsset
        }
        return BundledFrontendRoute.Network
    }
}

internal object FrontendFileVerifier {
    fun verify(stream: InputStream, file: BundledFrontendFile) {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(32 * 1024)
        var size = 0L
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            size += count
            require(size <= file.size) { "Frontend asset size mismatch" }
            digest.update(buffer, 0, count)
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        require(size == file.size && actual == file.sha256) { "Frontend asset integrity mismatch" }
    }
}
