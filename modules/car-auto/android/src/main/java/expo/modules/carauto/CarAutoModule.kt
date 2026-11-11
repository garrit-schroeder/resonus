// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

@OptIn(UnstableApi::class)
class CarAutoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CarAuto")

    Events("play", "transport", "connect", "browse")

    OnCreate {
      instance = this@CarAutoModule
    }

    OnDestroy {
      if (instance === this@CarAutoModule) {
        browseReady = false
        instance = null
      }
    }

    Function("setBrowseReady") { ready: Boolean ->
      browseReady = ready
      if (ready) ResonusCarBrowserService.browseReady()
    }

    Function("completeBrowse") { requestId: String, json: String? ->
      ResonusCarBrowserService.completeBrowse(requestId, json)
    }

    Function("setNodes") { json: String ->
      val context = appContext.reactContext ?: return@Function
      val changed = BrowseTreeCache.setFromJson(context, json)
      ResonusCarBrowserService.notifyTreeChanged(changed)
      CarAutoLog.d("setNodes ${BrowseTreeCache.debugSummary()}")
    }

    Function("setNowPlaying") { json: String? ->
      if (json.isNullOrEmpty() || json == "null") {
        CarPlaybackMirror.setNowPlaying(null)
        return@Function
      }
      val np = runCatching { parseNowPlaying(json) }.getOrNull() ?: return@Function
      CarPlaybackMirror.setNowPlaying(np)
    }

    Function("setQueue") { json: String ->
      val o = runCatching { JSONObject(json) }.getOrNull() ?: return@Function
      val arr = o.optJSONArray("tracks") ?: return@Function
      val items = ArrayList<JsProxyPlayer.NowPlaying>(arr.length())
      for (i in 0 until arr.length()) {
        val t = arr.optJSONObject(i) ?: continue
        items.add(
          JsProxyPlayer.NowPlaying(
            id = t.optString("id"),
            title = t.optString("title").takeIf { it.isNotEmpty() },
            artist = t.optString("artist").takeIf { it.isNotEmpty() },
            album = t.optString("album").takeIf { it.isNotEmpty() },
            artworkUrl = t.optString("artworkUrl").takeIf { it.isNotEmpty() },
            durationMs = t.optLong("durationMs", 0L),
          ),
        )
      }
      CarPlaybackMirror.setQueue(items, o.optInt("currentIndex", 0))
    }

    Function("setQueueIndex") { index: Int ->
      CarPlaybackMirror.setQueueIndex(index)
    }

    Function("setPlaybackState") { json: String ->
      val o = runCatching { JSONObject(json) }.getOrNull() ?: return@Function
      val isPlaying = o.optBoolean("isPlaying", false)
      val posMs = o.optLong("positionMs", 0L)
      val shuf = o.optBoolean("shuffle", false)
      val repeat = when (o.optString("repeatMode")) {
        "one" -> Player.REPEAT_MODE_ONE
        "all" -> Player.REPEAT_MODE_ALL
        else -> Player.REPEAT_MODE_OFF
      }
      CarPlaybackMirror.setPlaybackState(
        isPlaying, posMs, shuf, repeat,
        if (o.isNull("favorite")) null else o.optBoolean("favorite"),
        o.optString("favoriteLabel").takeIf { it.isNotEmpty() },
      )
    }
  }

  fun emitPlayEvent(mediaId: String, parentId: String? = null) {
    val payload = HashMap<String, Any>(2)
    payload["mediaId"] = mediaId
    if (parentId != null) payload["parentId"] = parentId
    sendEvent("play", payload)
  }

  fun emitBrowse(requestId: String, parentId: String, profile: String): Boolean {
    if (!browseReady) return false
    sendEvent("browse", mapOf("requestId" to requestId, "parentId" to parentId, "profile" to profile))
    return true
  }

  /** A browser asked for the root, which is a car opening the app. JS answers
   *  by filling the tree in, so what it holds is not whatever was left there
   *  the last time somebody had the phone in their hand. */
  fun emitConnected(projection: Boolean) {
    sendEvent("connect", mapOf("projection" to projection))
  }

  fun emitTransport(action: String, value: Double?) {
    val payload = HashMap<String, Any>(2)
    payload["action"] = action
    if (value != null) payload["value"] = value
    sendEvent("transport", payload)
  }

  fun emitTransportString(action: String, value: String) {
    sendEvent("transport", mapOf("action" to action, "value" to value))
  }

  companion object {
    @Volatile private var browseReady = false
    @Volatile var instance: CarAutoModule? = null
      private set
  }
}

@OptIn(UnstableApi::class)
private fun parseNowPlaying(json: String): JsProxyPlayer.NowPlaying {
  val o = JSONObject(json)
  return JsProxyPlayer.NowPlaying(
    id = o.optString("id"),
    title = o.optString("title").takeIf { it.isNotEmpty() },
    artist = o.optString("artist").takeIf { it.isNotEmpty() },
    album = o.optString("album").takeIf { it.isNotEmpty() },
    artworkUrl = o.optString("artworkUrl").takeIf { it.isNotEmpty() },
    durationMs = o.optLong("durationMs", 0L),
  )
}
