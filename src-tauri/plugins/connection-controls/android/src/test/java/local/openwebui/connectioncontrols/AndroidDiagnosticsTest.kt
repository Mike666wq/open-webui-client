package local.openwebui.connectioncontrols

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidDiagnosticsTest {
    @Test
    fun reportUsesOnlyAllowlistedExitFieldsAndAtMostFiveRecords() {
        val report = AndroidDiagnosticsReport.format(
            appVersion = "0.2.2\nhttps://private.example/token",
            sdk = 36,
            generatedAtMillis = 1234,
            exits = (0..8).map {
                ExitRecord(
                    reason = if (it == 0) "untrusted text with url https://private.example" else "crash",
                    status = it,
                    importance = 100,
                    timestampMillis = 5000L + it,
                    pssKb = -1,
                    rssKb = 10,
                )
            },
            lifecycle = emptyList(),
        )

        assertTrue(report.contains("reason=other"))
        assertTrue(report.contains("pssKb=0"))
        assertEquals(5, Regex("reason=").findAll(report).count())
        assertFalse(report.contains("private.example"))
        assertFalse(report.contains("token"))
        assertFalse(report.contains("untrusted text"))
        assertTrue(report.toByteArray(Charsets.UTF_8).size <= AndroidDiagnosticsReport.MAX_REPORT_BYTES)
    }

    @Test
    fun api29RingKeepsOnlyTheLatestThirtyTwoFixedMarkers() {
        val file = File.createTempFile("owc-diagnostics", ".log")
        try {
            val ring = LifecycleRing(file)
            repeat(40) { index ->
                ring.append(
                    LifecycleRecord(
                        timestampMillis = index.toLong(),
                        marker = if (index % 2 == 0) LifecycleMarker.APP_STARTED else LifecycleMarker.ACTIVITY_DESTROYED,
                    ),
                )
            }

            val records = ring.read()
            assertEquals(LifecycleRing.MAX_RECORDS, records.size)
            assertEquals(8L, records.first().timestampMillis)
            assertEquals(39L, records.last().timestampMillis)
            assertTrue(file.length() <= LifecycleRing.MAX_BYTES)
            assertTrue(records.all { it.marker in LifecycleMarker.values() })
        } finally {
            file.delete()
        }
    }

    @Test
    fun unknownExitReasonsNeverExposeNativeText() {
        assertEquals("other", AndroidDiagnosticsReport.reasonName(987654))
    }
}
