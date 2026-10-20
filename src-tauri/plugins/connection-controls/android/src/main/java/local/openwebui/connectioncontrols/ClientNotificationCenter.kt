package local.openwebui.connectioncontrols

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Raises real Android system notifications for events the bundled web UI
 * reports through [ClientNotifyBridge]. The web layer decides *what* happened;
 * this class decides *whether and how* the device shows it.
 *
 * Everything arriving here is untrusted display text from the page. Fields are
 * length-capped, control characters stripped, and no value is ever used as a
 * file path, URL, or permission decision input.
 */
internal class ClientNotificationCenter(private val activity: Activity) {

    private val preferences =
        activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Master switch mirrored from the in-app notification setting. */
    var enabled: Boolean
        get() = preferences.getBoolean(KEY_ENABLED, true)
        set(value) = preferences.edit().putBoolean(KEY_ENABLED, value).apply()

    /**
     * Registers notification channels up front. Channel settings (including
     * the sound) are fixed at creation time, so doing this once at plugin load
     * is what makes the system sound actually apply.
     */
    fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = activity.getSystemService(NotificationManager::class.java) ?: return
        val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
            .build()
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(
                    CHANNEL_MESSAGES,
                    if (chinese()) "消息" else "Messages",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply { setSound(sound, attributes) },
                NotificationChannel(
                    CHANNEL_PRESENCE,
                    if (chinese()) "成员上线" else "Member activity",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply { setSound(sound, attributes) }
            )
        )
    }

    fun handle(rawPayload: String) {
        if (!enabled) return
        val payload = runCatching { JSONObject(rawPayload) }.getOrNull() ?: return
        when (payload.optString("type")) {
            TYPE_MESSAGE -> showMessage(payload)
            TYPE_MEMBER_ACTIVE -> showMemberActive(payload)
        }
    }

    private fun showMessage(payload: JSONObject) {
        val channelId = sanitize(payload.optString("channelId"), MAX_ID) ?: return
        val title = sanitize(payload.optString("title"), MAX_TITLE) ?: return
        val text = sanitize(payload.optString("text"), MAX_TEXT) ?: return
        val messageId = sanitize(payload.optString("messageId"), MAX_ID)
        val isDm = payload.optBoolean("isDm", false)

        // One stable notification per conversation: a new message replaces the
        // previous one instead of flooding the shade.
        val notificationId = (NOTIFICATION_MESSAGE_BASE + channelId.hashCode())
        val body = if (isDm) text else "$title: $text"
        post(
            notificationId,
            build(CHANNEL_MESSAGES, title, body, messageId ?: channelId)
        )
    }

    private fun showMemberActive(payload: JSONObject) {
        val userId = sanitize(payload.optString("userId"), MAX_ID) ?: return
        val name = sanitize(payload.optString("name"), MAX_TITLE) ?: return
        val body = if (chinese()) "$name 上线了" else "$name is now active"
        post(
            NOTIFICATION_PRESENCE_BASE + userId.hashCode(),
            build(CHANNEL_PRESENCE, name, body, userId)
        )
    }

    private fun post(id: Int, notification: Notification) {
        if (!hasNotificationPermission()) {
            requestNotificationPermission()
            return
        }
        runCatching {
            NotificationManagerCompat.from(activity).notify(id, notification)
        }
    }

    private fun build(
        channel: String,
        title: String,
        body: String,
        dedupeKey: String
    ): Notification {
        val launch = activity.packageManager.getLaunchIntentForPackage(activity.packageName)
            ?.apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
        val pending = launch?.let {
            PendingIntent.getActivity(
                activity,
                dedupeKey.hashCode(),
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        return NotificationCompat.Builder(activity, channel)
            .setSmallIcon(smallIcon())
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .apply { pending?.let(::setContentIntent) }
            .build()
    }

    private fun hasNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(activity, android.Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (requestedPermission) return
        requestedPermission = true
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
            REQUEST_POST_NOTIFICATIONS
        )
    }

    private fun smallIcon(): Int {
        // Prefer the app's own launcher icon; fall back to a system drawable so
        // a missing resource can never crash the bridge.
        val id = activity.resources.getIdentifier("ic_launcher", "mipmap", activity.packageName)
        return if (id != 0) id else android.R.drawable.ic_dialog_email
    }

    private fun chinese(): Boolean =
        ClientPolicy.chinese(activity.resources.configuration.locales[0].language)

    companion object {
        private const val PREFS_NAME = "open_webui_client_notifications"
        private const val KEY_ENABLED = "enabled"
        private const val CHANNEL_MESSAGES = "client_messages"
        private const val CHANNEL_PRESENCE = "client_presence"
        private const val TYPE_MESSAGE = "message"
        private const val TYPE_MEMBER_ACTIVE = "member-active"
        private const val REQUEST_POST_NOTIFICATIONS = 7101

        private const val MAX_ID = 64
        private const val MAX_TITLE = 80
        private const val MAX_TEXT = 160

        // Keep the two families in separate id spaces so they never replace
        // each other. Bit-shift keeps ids positive and far from other apps.
        private const val NOTIFICATION_MESSAGE_BASE = 1 shl 16
        private const val NOTIFICATION_PRESENCE_BASE = 1 shl 17

        @Volatile private var requestedPermission = false

        /** Strips control characters and caps length; returns null when empty. */
        internal fun sanitize(value: String?, max: Int): String? {
            if (value.isNullOrBlank()) return null
            val cleaned = value
                .replace(Regex("[\\p{C}]"), " ")
                .replace(Regex("\\s+"), " ")
                .trim()
            if (cleaned.isEmpty()) return null
            return if (cleaned.length > max) cleaned.take(max - 1) + "…" else cleaned
        }
    }
}

/**
 * The single entry point installed into the WebView as `__openWebUiNotify`.
 * The page only ever calls [post]; it cannot read anything back, so no data
 * flows from native into the page through this surface.
 */
internal class ClientNotifyBridge(
    private val center: ClientNotificationCenter
) {
    @android.webkit.JavascriptInterface
    fun post(payload: String) {
        center.handle(payload)
    }
}
