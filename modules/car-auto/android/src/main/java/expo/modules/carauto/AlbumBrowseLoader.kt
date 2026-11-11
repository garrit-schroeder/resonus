package expo.modules.carauto

import android.content.Context
import android.os.Handler
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.util.UUID

/** Main-thread broker for album requests. Only requested collections are
 * loaded; concurrent pages share a request and every waiter has a deadline. */
internal class AlbumBrowseLoader(
  private val context: Context,
  private val handler: Handler,
  private val emit: (String, String, String) -> Boolean,
  private val changed: (Map<String, Int>) -> Unit,
) {
  private data class Pending(
    val id: String,
    val parent: String,
    val profile: String,
    val result: SettableFuture<Boolean> = SettableFuture.create(),
    var sent: Boolean = false,
    var timeout: Runnable? = null,
  )
  private val pending = LinkedHashMap<String, Pending>()

  fun load(parent: String): ListenableFuture<Boolean> {
    onTreeChanged()
    if (BrowseTreeCache.hasAlbumChildren(parent)) return Futures.immediateFuture(true)
    val profile = BrowseTreeCache.profileId() ?: return Futures.immediateFuture(false)
    pending.values.firstOrNull { it.parent == parent && it.profile == profile }?.let {
      return Futures.nonCancellationPropagating(it.result)
    }
    if (pending.size >= 4) return Futures.immediateFuture(false)
    val request = Pending(UUID.randomUUID().toString(), parent, profile)
    pending[request.id] = request
    request.timeout = Runnable {
      CarAutoLog.d("album load timeout")
      finish(request, false)
    }.also { handler.postDelayed(it, 15_000) }
    dispatch(request)
    return Futures.nonCancellationPropagating(request.result)
  }

  private fun dispatch(request: Pending) {
    if (!request.sent) request.sent = emit(request.id, request.parent, request.profile)
  }

  fun onReady() {
    onTreeChanged()
    pending.values.toList().forEach(::dispatch)
  }

  fun complete(id: String, json: String?) {
    val request = pending[id] ?: return // Timeout or stale response: never merge it.
    val ok = json != null && BrowseTreeCache.mergeAlbum(context, json, request.profile, request.parent)
    if (ok) changed(mapOf(request.parent to BrowseTreeCache.getChildren(request.parent).size))
    CarAutoLog.d("album load completed success=$ok")
    finish(request, ok)
  }

  fun onTreeChanged() {
    for (request in pending.values.toList()) {
      if (request.profile != BrowseTreeCache.profileId()) finish(request, false)
      else if (BrowseTreeCache.hasAlbumChildren(request.parent)) finish(request, true)
    }
  }

  private fun finish(request: Pending, success: Boolean) {
    pending.remove(request.id)
    request.timeout?.let(handler::removeCallbacks)
    request.result.set(success)
  }

  fun close() { pending.values.toList().forEach { finish(it, false) } }
}
