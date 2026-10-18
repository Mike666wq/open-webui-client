package local.openwebui.connectioncontrols

import org.junit.Assert.*
import org.junit.Test

class ClientPolicyTest {
    @Test fun toolbarReservesSpaceAfterTheCutoutAndLeavesAUsableWebView() {
        assertEquals(48, ClientPolicy.contentTop(0, 48, 1000))
        assertEquals(96, ClientPolicy.contentTop(48, 48, 1000))
        assertEquals(99, ClientPolicy.contentTop(80, 48, 100))
        assertEquals(0, ClientPolicy.contentTop(0, 48, 0))
    }
    @Test fun toolbarServiceLabelOmitsDefaultPortsCredentialsAndPaths() {
        assertEquals("chat.example", ClientPolicy.serviceLabel("https://chat.example:443/path"))
        assertEquals("chat.example:8443", ClientPolicy.serviceLabel("https://chat.example:8443"))
        assertEquals("[::1]:8765", ClientPolicy.serviceLabel("http://[::1]:8765"))
        assertEquals("Open WebUI", ClientPolicy.serviceLabel("https://user:pass@chat.example"))
        assertEquals("Open WebUI", ClientPolicy.serviceLabel(null))
    }
    @Test fun alreadyResizedRootDoesNotSubtractKeyboardTwice() {
        assertEquals(0, ClientPolicy.bottomOverlap(600, 1000, 400))
        assertEquals(400, ClientPolicy.bottomOverlap(1000, 1000, 400))
        assertEquals(48, ClientPolicy.bottomOverlap(1000, 1000, 48))
    }
    @Test fun historyMustStayOnCurrentServerOrigin() {
        assertTrue(ClientPolicy.sameOrigin("https://chat.example/a", "https://chat.example"))
        assertTrue(ClientPolicy.sameOrigin("https://chat.example:443/a", "https://CHAT.example"))
        assertTrue(ClientPolicy.sameOrigin("HTTPS://chat.example/a", "https://chat.example"))
        assertFalse(ClientPolicy.sameOrigin("http://tauri.localhost", "https://chat.example"))
        assertFalse(ClientPolicy.sameOrigin("https://old.example", "https://chat.example"))
        assertFalse(ClientPolicy.sameOrigin("https://user:pass@chat.example", "https://chat.example"))
        assertFalse(ClientPolicy.sameOrigin("javascript:alert(1)", "https://chat.example"))
        assertFalse(ClientPolicy.sameOrigin(null, "https://chat.example"))
    }
    @Test fun chineseIsSelectedOnlyForChineseSystemLanguage() {
        assertTrue(ClientPolicy.chinese("zh")); assertTrue(ClientPolicy.chinese("ZH"))
        assertFalse(ClientPolicy.chinese("en")); assertFalse(ClientPolicy.chinese("fr"))
    }
}
