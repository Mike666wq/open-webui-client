package local.openwebui.connectioncontrols

import org.junit.Assert.*
import org.junit.Test

class ClientPolicyTest {
    @Test fun buttonPositionIsClampedAndKeyboardDoesNotMutatePreference() {
        val remembered = .8f
        assertEquals(761, ClientPolicy.buttonOffset(remembered, 1000, 0, 0, 48))
        assertEquals(361, ClientPolicy.buttonOffset(remembered, 1000, 0, 500, 48))
        assertEquals(761, ClientPolicy.buttonOffset(remembered, 1000, 0, 0, 48))
        assertEquals(0, ClientPolicy.buttonOffset(-1f, 1000, 0, 0, 48))
        assertEquals(0, ClientPolicy.buttonOffset(.5f, 40, 0, 0, 48))
    }
    @Test fun alreadyResizedRootDoesNotSubtractKeyboardTwice() {
        assertEquals(0, ClientPolicy.bottomOverlap(600, 1000, 400))
        assertEquals(400, ClientPolicy.bottomOverlap(1000, 1000, 400))
        assertEquals(48, ClientPolicy.bottomOverlap(1000, 1000, 48))
    }
    @Test fun historyMustStayOnCurrentServerOrigin() {
        assertTrue(ClientPolicy.sameOrigin("https://chat.example/a", "https://chat.example"))
        assertTrue(ClientPolicy.sameOrigin("https://chat.example:443/a", "https://CHAT.example"))
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
