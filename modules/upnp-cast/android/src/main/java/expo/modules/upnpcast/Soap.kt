package expo.modules.upnpcast

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

object Services {
  const val AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"
  const val RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1"
  const val QUEUE = "urn:schemas-sonos-com:service:Queue:1"
  const val ZONE_GROUP_TOPOLOGY = "urn:schemas-upnp-org:service:ZoneGroupTopology:1"
}

object Soap {
  const val TAG = "UpnpCast"

  data class Result(val body: String?, val fault: String?) {
    val ok: Boolean get() = body != null

    /** UPnP error 401 is Invalid Action: the service does not implement it. */
    val unsupportedAction: Boolean
      get() = argument(fault, "errorCode") == "401"
  }

  suspend fun call(
    controlUrl: String,
    service: String,
    action: String,
    arguments: String = ""
  ): Result = withContext(Dispatchers.IO) {
    val envelope = buildString {
      append("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
      append("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" ")
      append("s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">")
      append("<s:Body><u:").append(action).append(" xmlns:u=\"").append(service).append("\">")
      append(arguments)
      append("</u:").append(action).append("></s:Body></s:Envelope>")
    }.toByteArray(Charsets.UTF_8)

    var connection: HttpURLConnection? = null
    try {
      connection = (URL(controlUrl).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"")
        setRequestProperty("SOAPAction", "\"$service#$action\"")
        setRequestProperty("Connection", "close")
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
        doOutput = true
        setFixedLengthStreamingMode(envelope.size)
      }
      connection.outputStream.use { it.write(envelope) }
      if (connection.responseCode == HttpURLConnection.HTTP_OK) {
        Result(connection.inputStream.bufferedReader().use { it.readText() }, null)
      } else {
        val fault = runCatching {
          connection.errorStream?.bufferedReader()?.use { it.readText() }
        }.getOrNull()
        Log.w(TAG, "$action refused (${connection.responseCode}): ${fault?.take(FAULT_LOG_CHARS)}")
        Result(null, fault)
      }
    } catch (e: Exception) {
      Log.w(TAG, "$action failed: ${e.javaClass.simpleName}: ${e.message}")
      Result(null, null)
    } finally {
      connection?.disconnect()
    }
  }

  suspend fun fetch(url: String): String? = withContext(Dispatchers.IO) {
    var connection: HttpURLConnection? = null
    try {
      connection = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
      }
      if (connection.responseCode != HttpURLConnection.HTTP_OK) null
      else connection.inputStream.bufferedReader().use { it.readText() }
    } catch (_: Exception) {
      null
    } finally {
      connection?.disconnect()
    }
  }

  fun argument(body: String?, name: String): String? {
    if (body == null) return null
    val open = Regex("<$name[^>]*>").find(body) ?: return null
    val start = open.range.last + 1
    val end = body.indexOf("</$name>", start)
    if (end < 0) return null
    return unescape(body.substring(start, end)).trim()
  }

  fun escape(text: String): String = buildString(text.length) {
    for (c in text) {
      when (c) {
        '&' -> append("&amp;")
        '<' -> append("&lt;")
        '>' -> append("&gt;")
        '"' -> append("&quot;")
        '\'' -> append("&apos;")
        else -> append(c)
      }
    }
  }

  fun unescape(text: String): String = text
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&apos;", "'")
    .replace("&amp;", "&")

  private const val TIMEOUT_MS = 5000
  private const val FAULT_LOG_CHARS = 400
}
