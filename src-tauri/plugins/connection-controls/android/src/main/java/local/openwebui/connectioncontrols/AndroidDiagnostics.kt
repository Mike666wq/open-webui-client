package local.openwebui.connectioncontrols

import java.io.File

internal enum class LifecycleMarker(val wireName: String) {
    APP_STARTED("app_started"),
    WEBVIEW_READY("webview_ready"),
    SAVE_PICKER_OPENED("save_picker_opened"),
    SAVE_FINISHED("save_finished"),
    ACTIVITY_DESTROYED("activity_destroyed"),
}

internal data class LifecycleRecord(val timestampMillis: Long, val marker: LifecycleMarker)

/** Small fixed-vocabulary log used only on Android versions without exit history. */
internal class LifecycleRing(private val file: File) {
    @Synchronized
    fun append(record: LifecycleRecord) {
        val records = read().takeLast(MAX_RECORDS - 1) + record
        var encoded = records.joinToString("\n") { "${it.timestampMillis},${it.marker.wireName}" }
        while (encoded.toByteArray(Charsets.UTF_8).size > MAX_BYTES && records.size > 1) {
            encoded = records.drop(1).joinToString("\n") { "${it.timestampMillis},${it.marker.wireName}" }
        }
        file.parentFile?.mkdirs()
        file.writeText(encoded, Charsets.UTF_8)
    }

    @Synchronized
    fun read(): List<LifecycleRecord> {
        if (!file.isFile || file.length() > MAX_BYTES) return emptyList()
        return runCatching {
            file.readLines(Charsets.UTF_8).takeLast(MAX_RECORDS).mapNotNull { line ->
                val parts = line.split(',', limit = 2)
                val timestamp = parts.getOrNull(0)?.toLongOrNull() ?: return@mapNotNull null
                val marker = LifecycleMarker.values().firstOrNull { it.wireName == parts.getOrNull(1) }
                    ?: return@mapNotNull null
                LifecycleRecord(timestamp, marker)
            }
        }.getOrDefault(emptyList())
    }

    companion object {
        const val MAX_RECORDS = 32
        const val MAX_BYTES = 8 * 1024
    }
}

internal data class ExitRecord(
    val reason: String,
    val status: Int,
    val importance: Int,
    val timestampMillis: Long,
    val pssKb: Long,
    val rssKb: Long,
)

internal object AndroidDiagnosticsReport {
    const val MAX_EXIT_RECORDS = 5
    const val MAX_REPORT_BYTES = 16 * 1024

    fun reasonName(reason: Int): String = when (reason) {
        0 -> "unknown"
        1 -> "exit_self"
        2 -> "signaled"
        3 -> "low_memory"
        4 -> "crash"
        5 -> "native_crash"
        6 -> "anr"
        7 -> "initialization_failure"
        8 -> "permission_change"
        9 -> "excessive_resource_usage"
        10 -> "user_requested"
        11 -> "user_stopped"
        12 -> "dependency_died"
        else -> "other"
    }

    fun format(
        appVersion: String,
        sdk: Int,
        generatedAtMillis: Long,
        exits: List<ExitRecord>?,
        lifecycle: List<LifecycleRecord>,
    ): String {
        val output = buildString {
            appendLine("Open WebUI Client Android diagnostics")
            appendLine("Automatically sent: no")
            appendLine("App version: ${safeVersion(appVersion)}")
            appendLine("Android API: $sdk")
            appendLine("Generated at (epoch ms): $generatedAtMillis")
            if (exits != null) {
                appendLine("Recent app exit history (maximum $MAX_EXIT_RECORDS):")
                exits.take(MAX_EXIT_RECORDS).forEach { exit ->
                    appendLine("reason=${safeReason(exit.reason)} status=${exit.status} importance=${exit.importance} time=${exit.timestampMillis} pssKb=${exit.pssKb.coerceAtLeast(0)} rssKb=${exit.rssKb.coerceAtLeast(0)}")
                }
            } else {
                appendLine("API 29 lifecycle markers (not a crash diagnosis):")
                lifecycle.takeLast(LifecycleRing.MAX_RECORDS).forEach { event ->
                    appendLine("time=${event.timestampMillis} event=${event.marker.wireName}")
                }
                appendLine("A missing final marker is inconclusive and does not prove a crash.")
            }
        }
        val bytes = output.toByteArray(Charsets.UTF_8)
        return if (bytes.size <= MAX_REPORT_BYTES) output else bytes.copyOf(MAX_REPORT_BYTES).toString(Charsets.UTF_8)
    }

    private fun safeReason(value: String): String = when (value) {
        "unknown", "exit_self", "signaled", "low_memory", "crash", "native_crash", "anr",
        "initialization_failure", "permission_change", "excessive_resource_usage",
        "user_requested", "user_stopped", "dependency_died", "other" -> value
        else -> "other"
    }

    private fun safeVersion(value: String): String =
        if (value.matches(Regex("[0-9]+(?:\\.[0-9]+){0,2}(?:[-+][A-Za-z0-9.-]+)?"))) value.take(40)
        else "unknown"
}
