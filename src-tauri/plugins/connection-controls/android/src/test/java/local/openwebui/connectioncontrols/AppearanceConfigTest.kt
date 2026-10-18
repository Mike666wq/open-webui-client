package local.openwebui.connectioncontrols

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AppearanceConfigTest {
    @Test fun originsAreIsolatedAndCanonical() {
        assertEquals("https://chat.example", AppearanceConfig.origin("HTTPS://CHAT.example:443/c/123"))
        assertEquals("http://chat.example:3000", AppearanceConfig.origin("http://chat.example:3000"))
        assertEquals("http://[::1]:3000", AppearanceConfig.origin("http://[::1]:3000"))
        assertNull(AppearanceConfig.origin("https://user:pass@chat.example"))
        assertNull(AppearanceConfig.origin("file:///tmp/test"))
        assertNull(AppearanceConfig.origin("https://chat.example:99999"))
    }
    @Test fun unknownSchemaCannotOverwriteCurrentSettings() {
        try { AppearanceConfig.parse(JSONObject("{schema:2}")); fail("Unknown schema accepted") } catch (_: IllegalArgumentException) {}
    }
    @Test fun invalidInputCannotBecomeFilePathsOrCss() {
        val value=AppearanceConfig.parse(JSONObject().put("image","../../secret").put("accent","red;display:none").put("opacity",0).put("zoom",999).put("fontSize",999))
        assertEquals("",value.image); assertEquals("#2563EB",value.accent)
        assertEquals(50,value.opacity); assertEquals(200,value.zoom); assertEquals(24,value.fontSize)
    }
    @Test fun draftsAreIndependentAndRoundTrip() {
        val saved=AppearanceConfig(enabled=true,navigation=true,image="wallpaper-abc-123.jpg",mode="dark")
        val draft=saved.copy(accent="#123456",blur=12)
        assertEquals("#2563EB",saved.accent)
        assertEquals(saved,AppearanceConfig.parse(saved.json()))
        assertEquals(draft,AppearanceConfig.parse(draft.json()))
    }
    @Test fun readingPresetIsOpaqueButNavigationIndependent() {
        val value=AppearanceConfig.preset("reading",AppearanceConfig(navigation=true))
        assertEquals(100,value.opacity); assertEquals("solid",value.background); assertTrue(value.navigation)
    }
    @Test fun staticHeadersRejectAnimatedAndDisguisedInputs() {
        assertFalse(ImagePolicy.staticImage("GIF89a-not-a-jpeg".toByteArray()))
        val animated="RIFFxxxxWEBPANIM".toByteArray()+byteArrayOf(0,0,0,0)
        assertFalse(ImagePolicy.staticImage(animated))
        val still="RIFFxxxxWEBPVP8 ".toByteArray()+byteArrayOf(0,0,0,0)
        assertTrue(ImagePolicy.staticImage(still))
        assertFalse(ImagePolicy.staticImage(still.copyOf(still.size-1)))
    }
    @Test fun decodeLimitsAndSamplingBoundDecodedMemory() {
        assertEquals(1,ImagePolicy.sample(2560,1440)); assertEquals(4,ImagePolicy.sample(8000,6000))
        for(pair in listOf(0 to 100, -1 to 100, 50001 to 1, 20000 to 20000)) {
            try { ImagePolicy.sample(pair.first,pair.second); fail("Invalid image accepted") } catch (_: IllegalArgumentException) {}
        }
    }
}
