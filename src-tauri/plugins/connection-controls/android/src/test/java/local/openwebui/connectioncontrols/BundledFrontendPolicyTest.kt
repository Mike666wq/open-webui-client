package local.openwebui.connectioncontrols

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.security.MessageDigest

class BundledFrontendPolicyTest {
    private val origin = "https://chat.example:8443"
    private val snapshot = FrontendConnectionSnapshot.create(origin, 3, 10)!!
    private val text = "bundled frontend".toByteArray()
    private val sha256 = MessageDigest.getInstance("SHA-256").digest(text)
        .joinToString("") { "%02x".format(it.toInt() and 255) }

    private fun file(path: String, mime: String) = JSONObject()
        .put("path", path).put("sha256", sha256).put("size", text.size).put("mime", mime)

    private fun metadata() = JSONObject()
        .put("schema", 1)
        .put("upstreamVersion", "0.12.2")
        .put("upstreamCommit", "a".repeat(40))
        .put("sourceRepository", "Mike666wq/open-webui-frontend")
        .put("sourceCommit", "b".repeat(40))
        .put("entry", "index.html")
        .put("pageRoutes", JSONArray(listOf("^/$", "^/auth/?$", "^/c/[^/]+/?$")))
        .put("files", JSONArray().put(file("index.html", "text/html"))
            .put(file("_app/immutable/main.js", "application/javascript"))
            .put(file("static/favicon.png", "image/png")))

    private fun route(
        path: String, method: String = "GET", main: Boolean = false,
        source: String = origin, manifest: BundledFrontendManifest? = BundledFrontendManifest.parse(metadata()),
    ) = BundledFrontendPolicy.route(snapshot, method, source + path, main, manifest)

    private fun rejects(action: () -> Unit) {
        try { action(); fail("Expected invalid bundle metadata or bytes to be rejected") }
        catch (_: IllegalArgumentException) {}
    }

    @Test fun apkFilesAndOnlyKnownSpaPagesAreServedLocally() {
        assertEquals("index.html", (route("/", main = true) as BundledFrontendRoute.Asset).file.path)
        assertEquals("index.html", (route("/c/chat-123?view=conversation", main = true) as BundledFrontendRoute.Asset).file.path)
        assertEquals("index.html", (route("/auth", main = true) as BundledFrontendRoute.Asset).file.path)
        assertEquals("_app/immutable/main.js", (route("/_app/immutable/main.js?v=1") as BundledFrontendRoute.Asset).file.path)
        assertSame(BundledFrontendRoute.Network, route("/unrecognised-page", main = true))
        assertSame(BundledFrontendRoute.Network, route("/c/chat-123"))
    }

    @Test fun apiUploadsStreamsSocketsAndDownloadsStayOnTheOriginalNetwork() {
        for (path in listOf(
            "/api/config", "/api/v1/chats", "/api/chat/completions",
            "/api/v1/files/name%2Fpart", "/ws/socket.io/?EIO=4&transport=websocket",
            "/openai/chat/completions", "/ollama/api/chat", "/oauth/google/callback",
            "/cache/audio/speech.mp3", "/download/report.js",
        )) {
            assertSame(path, BundledFrontendRoute.Network, route(path, main = true))
            assertSame(path, BundledFrontendRoute.Network, route(path, method = "POST"))
        }
        assertSame(BundledFrontendRoute.Network, route("/static/favicon.png?download=1"))
        assertSame(BundledFrontendRoute.Network, route("/_app/immutable/main.js?%64ownload"))
        assertSame(BundledFrontendRoute.Network, route("/auth", method = "POST", main = true))
        assertSame(BundledFrontendRoute.Network, route("/_app/immutable/main.js", method = "HEAD"))
    }

    @Test fun originIncludesSchemeHostAndEffectivePort() {
        assertTrue(route("/", main = true, source = "HTTPS://CHAT.EXAMPLE:8443") is BundledFrontendRoute.Asset)
        for (source in listOf(
            "http://chat.example:8443", "https://chat.example", "https://other.example:8443",
            "https://user:secret@chat.example:8443", "http://tauri.localhost",
        )) assertSame(source, BundledFrontendRoute.Network, route("/", main = true, source = source))
        val defaultPort = FrontendConnectionSnapshot.create("https://chat.example:443", 1, 1)
        assertEquals("https://chat.example", defaultPort?.origin)
        assertEquals("http://[::1]:8765", FrontendConnectionSnapshot.create("http://[::1]:8765", 1, 1)?.origin)
    }

    @Test fun snapshotCannotActivateTheLocalSettingsOrAcceptCredentialsAndPaths() {
        for (address in listOf(
            "http://tauri.localhost/", "https://user@chat.example",
            "https://chat.example/path", "https://chat.example?target=other", "file:///index.html",
        )) assertNull(address, FrontendConnectionSnapshot.create(address, 1, 1))
        assertNull(FrontendConnectionSnapshot.create(origin, -1, 1))
        assertNull(FrontendConnectionSnapshot.create(origin, 1, -1))
        assertSame(BundledFrontendRoute.Network, BundledFrontendPolicy.route(null, "GET", origin + "/", true, BundledFrontendManifest.parse(metadata())))
    }

    @Test fun missingChunksCannotFallThroughToAnotherFrontendBuild() {
        assertSame(BundledFrontendRoute.MissingAsset, route("/_app/immutable/missing.js"))
        assertSame(BundledFrontendRoute.MissingAsset, route("/static/missing-runtime.js"))
        assertSame(BundledFrontendRoute.MissingAsset, route("/missing-runtime.js"))
        assertSame(BundledFrontendRoute.MissingAsset, route("/old.css"))
        assertSame(BundledFrontendRoute.Network, route("/user-content/photo.jpg"))
        assertSame(BundledFrontendRoute.Unavailable, route("/", main = true, manifest = null))
        assertSame(BundledFrontendRoute.Unavailable, route("/_app/immutable/main.js", manifest = null))
        assertSame(BundledFrontendRoute.Network, route("/api/config", manifest = null))
    }

    @Test fun backendShareAndLegacyWatchRedirectsAreNotSwallowedByLocalSpaFallback() {
        for (path in listOf(
            "/?shared=hello", "/?%73hared=hello%20world", "/c/chat-123?shared=hello",
            "/watch?v=video-id", "/watch?v=video-id&next=/c/123",
        )) assertSame(path, BundledFrontendRoute.Network, route(path, main = true))
        assertTrue(route("/?youtube=video-id", main = true) is BundledFrontendRoute.Asset)
        assertTrue(route("/?q=hello", main = true) is BundledFrontendRoute.Asset)
    }

    @Test fun unlistedBackendStaticMediaAndSwaggerResourcesRemainRemote() {
        assertSame(BundledFrontendRoute.Network, route("/static/custom-model-avatar.png"))
        assertSame(BundledFrontendRoute.Network, route("/static/custom/model.svg"))
        assertSame(BundledFrontendRoute.Network, route("/static/swagger-ui/swagger-ui-bundle.js"))
        assertSame(BundledFrontendRoute.Network, route("/static/swagger-ui/swagger-ui.css"))
        assertSame(BundledFrontendRoute.Network, route("/static/swagger-ui/favicon.png"))
        assertTrue(route("/static/favicon.png") is BundledFrontendRoute.Asset)
        assertSame(BundledFrontendRoute.Network, route("/frontend-manifest.json"))
    }

    @Test fun encodedSeparatorsAndTraversalCannotReadDifferentApkFiles() {
        for (path in listOf(
            "/_app/../index.html", "/_app/%2e%2e/index.html", "/_app%2fimmutable/main.js",
            "/static/%5cindex.html", "/static/%00.png",
        )) assertSame(path, BundledFrontendRoute.MissingAsset, route(path, main = true))
    }

    @Test fun connectionSwitchInvalidatesPendingAssetsAndRejectsLateState() {
        val gate = FrontendSessionGate()
        gate.update(origin, 3, 10, true)
        val pending = gate.read()
        assertEquals(origin, pending.snapshot?.origin)
        gate.update(origin, 3, 11, true)
        assertTrue(gate.isCurrent(pending))
        gate.update("https://second.example", 4, 12, true)
        assertFalse(gate.isCurrent(pending))
        gate.update(origin, 3, 13, true)
        assertEquals("https://second.example", gate.read().snapshot?.origin)
        gate.update(origin, 4, 10, true)
        assertEquals("https://second.example", gate.read().snapshot?.origin)
        gate.update(null, 5, 14, false)
        assertNull(gate.read().snapshot)
        gate.update(origin, 4, 15, true)
        assertNull(gate.read().snapshot)
    }

    @Test fun nativePreparationPrecedesFirstHtmlAndCannotReactivateAnOlderSession() {
        val gate = FrontendSessionGate()
        assertTrue(gate.prepare(origin, 1))
        assertEquals(origin, gate.read().snapshot?.origin)
        gate.update(origin, 1, 1, true)
        assertTrue(gate.prepare(origin, 1))
        assertFalse(gate.prepare("https://other.example", 1))
        gate.update(null, 2, 2, false)
        assertFalse(gate.prepare(origin, 1))
        assertFalse(gate.prepare(origin, 2))
        assertTrue(gate.prepare(origin, 3))
    }

    @Test fun manifestCannotReplaceBackendEndpointsOrReadOutsideItsAssetDirectory() {
        for (path in listOf("../secret", "/index.html", "_app/../../secret", "a\\b.js", "api/config", "cache/audio.mp3")) {
            rejects { BundledFrontendManifest.parse(metadata().also { it.getJSONArray("files").put(file(path, "text/plain")) }) }
        }
        rejects { BundledFrontendManifest.parse(metadata().also { it.getJSONArray("files").put(file("index.html", "text/html")) }) }
        rejects { BundledFrontendManifest.parse(metadata().put("schema", 2)) }
        rejects { BundledFrontendManifest.parse(metadata().put("upstreamVersion", "0.13.0")) }
        rejects { BundledFrontendManifest.parse(metadata().put("sourceCommit", "main")) }
        rejects { BundledFrontendManifest.parse(metadata().put("pageRoutes", JSONArray(listOf("/.*")))) }
        rejects { BundledFrontendManifest.parse(metadata().put("pageRoutes", JSONArray(listOf("^/c/.*$")))) }
    }

    @Test fun assetIntegrityIsCheckedBeforeAResponseCanExposeAnyBytes() {
        val asset = BundledFrontendManifest.parse(metadata()).files.getValue("index.html")
        FrontendFileVerifier.verify(ByteArrayInputStream(text), asset)
        rejects { FrontendFileVerifier.verify(ByteArrayInputStream("tampered".toByteArray()), asset) }
        rejects { FrontendFileVerifier.verify(ByteArrayInputStream(text + byteArrayOf(0)), asset) }
        rejects { FrontendFileVerifier.verify(ByteArrayInputStream(text.copyOf(text.size - 1)), asset) }
        rejects { FrontendFileVerifier.verify(ByteArrayInputStream(text), asset.copy(sha256 = "0".repeat(64))) }
    }
}
