package local.openwebui.connectioncontrols

import kotlin.math.max

internal data class ConnectionBackdropTransform(
    val scaleX: Float, val scaleY: Float, val translateX: Float, val translateY: Float,
    val overflowX: Float
)

internal fun connectionBackdropTransform(
    viewWidth: Float, viewHeight: Float, videoWidth: Int, videoHeight: Int, focus: Float
): ConnectionBackdropTransform? {
    if (viewWidth <= 0 || viewHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return null
    val fit = max(viewWidth / videoWidth, viewHeight / videoHeight)
    val width = videoWidth * fit
    val height = videoHeight * fit
    val overflow = max(0f, width - viewWidth)
    // TextureView already maps the decoded frame to the view bounds. Its
    // transform corrects that mapping, rather than scaling source pixels twice.
    return ConnectionBackdropTransform(
        width / viewWidth, height / viewHeight,
        -overflow * focus.coerceIn(0f, 1f), (viewHeight - height) / 2f, overflow
    )
}
