package local.openwebui.connectioncontrols

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

internal class WallpaperStore(private val context: Context) {
    val directory = File(context.noBackupFilesDir, "appearance").apply { mkdirs() }
    private fun configFile(origin: String) = File(directory, MessageDigest.getInstance("SHA-256")
        .digest(origin.toByteArray()).joinToString("") { "%02x".format(it) } + ".json")
    fun load(origin: String): AppearanceConfig = runCatching {
        AppearanceConfig.parse(JSONObject(AtomicFile(configFile(origin)).readFully().toString(Charsets.UTF_8)))
    }.getOrDefault(AppearanceConfig())
    fun save(origin: String, config: AppearanceConfig) {
        val file = AtomicFile(configFile(origin))
        val stream = file.startWrite()
        try { stream.write(config.json().toString().toByteArray()); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
    fun file(name: String): File? = name.takeIf { Regex("wallpaper-[a-f0-9-]+\\.jpg").matches(it) }
        ?.let { File(directory, it) }?.takeIf { it.isFile }
    fun delete(name: String) { file(name)?.delete() }

    /** Never retain provider URIs, original EXIF, or unbounded decoded images. */
    fun importImage(uri: Uri): String {
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream(); val buffer = ByteArray(65536)
            while (true) {
                val count = input.read(buffer); if (count < 0) break
                require(output.size().toLong() + count <= 20L * 1024 * 1024) { "Image exceeds 20 MB" }
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } ?: throw IllegalArgumentException("Image unavailable")
        require(ImagePolicy.staticImage(bytes)) { "Choose a static image" }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outMimeType in listOf("image/jpeg", "image/png", "image/webp")) { "Unsupported image" }
        val sample = ImagePolicy.sample(bounds.outWidth, bounds.outHeight)
        var bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IllegalArgumentException("Image decode failed")
        var destination: File? = null
        try {
            val orientation = runCatching { ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1)
            val matrix = Matrix().apply {
                when (orientation) {
                    2 -> setScale(-1f,1f); 3 -> setRotate(180f); 4 -> setScale(1f,-1f)
                    5 -> { setRotate(90f); postScale(-1f,1f) }; 6 -> setRotate(90f)
                    7 -> { setRotate(270f); postScale(-1f,1f) }; 8 -> setRotate(270f)
                }
            }
            if (!matrix.isIdentity) {
                val rotated = Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,matrix,true)
                if (rotated !== bitmap) { bitmap.recycle(); bitmap = rotated }
            }
            val scale = minOf(1f, 2560f / max(bitmap.width,bitmap.height))
            if (scale < 1) {
                val resized = Bitmap.createScaledBitmap(bitmap, max(1,(bitmap.width*scale).roundToInt()),max(1,(bitmap.height*scale).roundToInt()),true)
                if (resized !== bitmap) { bitmap.recycle(); bitmap = resized }
            }
            val name = "wallpaper-${UUID.randomUUID()}.jpg"
            destination = File(directory,name)
            destination.outputStream().use { require(bitmap.compress(Bitmap.CompressFormat.JPEG,92,it)) }
            return name
        } catch (error: Exception) { destination?.delete(); throw error }
        finally { bitmap.recycle() }
    }
    fun render(config: AppearanceConfig): Bitmap? {
        val source = file(config.image) ?: return null
        val bitmap = BitmapFactory.decodeFile(source.path) ?: return null
        if (config.blur == 0) return bitmap
        val scale = minOf(1f,640f/max(bitmap.width,bitmap.height))
        val small = Bitmap.createScaledBitmap(bitmap,max(1,(bitmap.width*scale).toInt()),max(1,(bitmap.height*scale).toInt()),true)
        if (small !== bitmap) bitmap.recycle()
        val width=small.width; val height=small.height
        val pixels=IntArray(width*height); small.getPixels(pixels,0,width,0,0,width,height)
        val temp=IntArray(pixels.size); val result=IntArray(pixels.size)
        val radius=config.blur.coerceIn(1,20)
        fun pass(input: IntArray, output: IntArray, horizontal: Boolean) {
            val lines=if(horizontal) height else width; val length=if(horizontal) width else height
            val kernel=radius*2+1
            for(line in 0 until lines) {
                fun index(position: Int) = if(horizontal) line*width+position.coerceIn(0,width-1) else position.coerceIn(0,height-1)*width+line
                var red=0; var green=0; var blue=0
                fun add(pixel: Int, sign: Int) { red+=((pixel shr 16) and 255)*sign; green+=((pixel shr 8) and 255)*sign; blue+=(pixel and 255)*sign }
                for(offset in -radius..radius) add(input[index(offset)],1)
                for(position in 0 until length) {
                    output[index(position)]=(-0x1000000) or ((red/kernel) shl 16) or ((green/kernel) shl 8) or (blue/kernel)
                    add(input[index(position-radius)],-1); add(input[index(position+radius+1)],1)
                }
            }
        }
        pass(pixels,temp,true); pass(temp,result,false)
        val output=Bitmap.createBitmap(result,width,height,Bitmap.Config.ARGB_8888)
        small.recycle(); return output
    }
}

internal object ImagePolicy {
    fun staticImage(bytes: ByteArray): Boolean {
        if(bytes.size < 12) return false
        fun tag(offset: Int, length: Int=4) = String(bytes,offset,length,Charsets.ISO_8859_1)
        if((bytes[0].toInt() and 255)==255 && (bytes[1].toInt() and 255)==216 && (bytes[2].toInt() and 255)==255) return true
        val png=bytes.take(8).toByteArray().contentEquals(byteArrayOf(-119,80,78,71,13,10,26,10))
        val webp=tag(0)=="RIFF" && tag(8)=="WEBP"
        if(!png && !webp) return false
        var offset=if(png) 8 else 12
        while(offset+8 <= bytes.size) {
            val chunk=tag(offset+if(png) 4 else 0)
            if(chunk in listOf("acTL","ANIM","ANMF")) return false
            var length=0L
            for(i in 0..3) length=length or ((bytes[offset+(if(png) i else 4+i)].toLong() and 255) shl (if(png) (3-i)*8 else i*8))
            val next=offset.toLong()+8+length+(if(png) 4 else length%2)
            if(next>bytes.size || next<=offset) return false
            offset=next.toInt()
        }
        return offset==bytes.size
    }

    fun sample(width: Int, height: Int): Int {
        require(width > 0 && height > 0 && width.toLong()*height <= 100_000_000 && max(width,height) <= 50_000)
        var sample=1
        while(max(width,height)/sample > 2560) sample*=2
        return sample
    }
}
