package local.openwebui.connectioncontrols

import org.junit.Assert.*
import org.junit.Test

class ClientNotificationCenterTest {

    @Test fun sanitizeStripsControlCharactersAndCollapsesWhitespace() {
        assertEquals("hello there", ClientNotificationCenter.sanitize("hello\n\tthere", 80))
        assertEquals("plain text", ClientNotificationCenter.sanitize("  plain   text  ", 80))
    }

    @Test fun sanitizeReturnsNullForBlankOrAllControlInput() {
        assertNull(ClientNotificationCenter.sanitize("", 80))
        assertNull(ClientNotificationCenter.sanitize("   ", 80))
        assertNull(ClientNotificationCenter.sanitize(null, 80))
        assertNull(ClientNotificationCenter.sanitize("\u0000\u0001", 80))
    }

    @Test fun sanitizeCapsOverlongTextWithEllipsis() {
        val long = "x".repeat(500)
        val out = ClientNotificationCenter.sanitize(long, 160)
        assertNotNull(out)
        assertEquals(160, out!!.length)
        assertTrue(out.endsWith("…"))
    }

    @Test fun sanitizeKeepsShortTextUntouched() {
        assertEquals("kezhou 上线了", ClientNotificationCenter.sanitize("kezhou 上线了", 80))
    }
}
