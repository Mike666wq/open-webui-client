package local.openwebui.connectioncontrols

import org.junit.Assert.*
import org.junit.Test

class ConnectionBackdropGeometryTest {
    @Test fun landscapeVideoFillsPortraitWithoutDistortionAndCanPanToBothEdges() {
        val center = connectionBackdropTransform(393f, 800f, 1920, 1080, .5f)!!
        assertEquals(800f, 800f * center.scaleY, .01f)
        val renderedWidth = 393f * center.scaleX
        assertEquals(1920f / 1080f, renderedWidth / 800f, .001f)
        assertEquals(-(renderedWidth - 393f) / 2, center.translateX, .01f)
        assertEquals(0f, connectionBackdropTransform(393f, 800f, 1920, 1080, 0f)!!.translateX, .01f)
        assertEquals(-center.overflowX, connectionBackdropTransform(393f, 800f, 1920, 1080, 1f)!!.translateX, .01f)
    }

    @Test fun landscapeAndInvalidDimensionsAreHandled() {
        val fit = connectionBackdropTransform(844f, 390f, 1920, 1080, 1f)!!
        assertEquals(0f, fit.overflowX, .01f)
        assertEquals(1f, fit.scaleX, .001f)
        assertTrue(fit.translateY < 0)
        assertNull(connectionBackdropTransform(0f, 800f, 1920, 1080, .5f))
    }
}
