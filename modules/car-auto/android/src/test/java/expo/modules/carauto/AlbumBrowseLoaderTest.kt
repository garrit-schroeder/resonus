package expo.modules.carauto

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class AlbumBrowseLoaderTest {
  private val context: Context = RuntimeEnvironment.getApplication()
  private val handler = Handler(Looper.getMainLooper())
  private val requests = mutableListOf<Triple<String, String, String>>()
  private var ready = true
  private lateinit var loader: AlbumBrowseLoader

  private fun tree(profile: String = "a") = """{"profile":"$profile","nodes":{"root":[{"id":"album:expanded","title":"Expanded","playable":false}],"tab:home":[]}}"""
  private fun response(profile: String = "a", count: Int = 38): String {
    val songs = (0 until count).joinToString(",") { """{"id":"track|album:expanded|song-$it","title":"Track $it","playable":true}""" }
    return """{"profile":"$profile","partial":true,"nodes":{"album:expanded":[$songs]}}"""
  }

  @Before fun setup() {
    // Force an account boundary because the production cache is process-wide.
    BrowseTreeCache.setFromJson(context, tree("reset"))
    BrowseTreeCache.setFromJson(context, tree())
    loader = AlbumBrowseLoader(context, handler, { id, parent, profile ->
      if (ready) requests.add(Triple(id, parent, profile))
      ready
    }, {})
  }

  @After fun cleanup() { loader.close() }

  @Test fun missingAlbumWaitsForItsTracksAndSharesConcurrentRequests() {
    val first = loader.load("album:expanded")
    val second = loader.load("album:expanded")
    assertFalse(first.isDone)
    assertEquals(1, requests.size)
    loader.complete(requests.single().first, response())
    assertTrue(first.get())
    assertTrue(second.get())
    assertEquals(38, BrowseTreeCache.getChildren("album:expanded").size)
    assertTrue(loader.load("album:expanded").get())
    assertEquals(1, requests.size)
  }

  @Test fun aLaterFullRebuildAndDiskSnapshotRetainTheDemandLoadedAlbum() {
    val future = loader.load("album:expanded")
    loader.complete(requests.single().first, response())
    assertTrue(future.get())
    BrowseTreeCache.setFromJson(context, tree())
    assertEquals(38, BrowseTreeCache.getChildren("album:expanded").size)
    val saved = org.json.JSONObject(java.io.File(context.filesDir, "carauto_tree.json").readText())
    assertEquals(38, saved.getJSONObject("nodes").getJSONArray("album:expanded").length())
  }

  @Test fun failedRequestsCanBeRetriedAndLateResponsesAreIgnored() {
    val first = loader.load("album:expanded")
    loader.complete(requests[0].first, null)
    assertFalse(first.get())
    val retry = loader.load("album:expanded")
    loader.complete(requests[0].first, response())
    assertFalse(retry.isDone)
    loader.complete(requests[1].first, response())
    assertTrue(retry.get())
  }

  @Test fun nativeTimeoutCompletesWithoutDependingOnJavascriptTimers() {
    val result = loader.load("album:expanded")
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(16))
    assertFalse(result.get())
    loader.complete(requests.single().first, response())
    assertTrue(BrowseTreeCache.getChildren("album:expanded").isEmpty())
    assertFalse(loader.load("album:expanded").isDone)
    assertEquals(2, requests.size)
  }

  @Test fun anAccountChangeRejectsOldDataAndCompletesTheOldWaiter() {
    val result = loader.load("album:expanded")
    BrowseTreeCache.setFromJson(context, tree("b"))
    loader.onTreeChanged()
    assertFalse(result.get())
    loader.complete(requests.single().first, response())
    assertTrue(BrowseTreeCache.getChildren("album:expanded").isEmpty())
  }

  @Test fun wrongProfileOrParentCannotBeMerged() {
    val result = loader.load("album:expanded")
    loader.complete(requests.single().first, response("b"))
    assertFalse(result.get())
    val retry = loader.load("album:expanded")
    loader.complete(requests.last().first, response().replace("album:expanded", "album:other"))
    assertFalse(retry.get())
    assertTrue(BrowseTreeCache.getChildren("album:other").isEmpty())
  }

  @Test fun aConfirmedEmptyAlbumDoesNotTriggerRepeatedRequests() {
    val result = loader.load("album:expanded")
    loader.complete(requests.single().first, response(count = 0))
    assertTrue(result.get())
    assertTrue(loader.load("album:expanded").get())
    assertEquals(1, requests.size)
    BrowseTreeCache.setFromJson(context, """{"profile":"a","partial":true,"nodes":{}}""")
    assertFalse(loader.load("album:expanded").isDone)
    assertEquals(2, requests.size)
  }

  @Test fun startupRequestsWaitUntilTheJavascriptListenerIsReady() {
    ready = false
    val result = loader.load("album:expanded")
    assertTrue(requests.isEmpty())
    ready = true
    loader.onReady()
    loader.complete(requests.single().first, response())
    assertTrue(result.get())
  }

  @Test fun serviceShutdownCompletesPendingRequests() {
    val result = loader.load("album:expanded")
    loader.close()
    assertFalse(result.get())
  }

  @Test fun cancellingOnePageDoesNotCancelAnotherPageOfTheSameAlbum() {
    val first = loader.load("album:expanded")
    val second = loader.load("album:expanded")
    first.cancel(false)
    loader.complete(requests.single().first, response())
    assertTrue(second.get())
  }

  @Test fun theNumberOfConcurrentAlbumRequestsIsBounded() {
    repeat(4) { assertFalse(loader.load("album:$it").isDone) }
    assertFalse(loader.load("album:overflow").get())
    assertEquals(4, requests.size)
  }

  @Test fun demandCacheIsBoundedWithoutIncreasingThePrefetchLimit() {
    repeat(41) { i ->
      val parent = "album:$i"
      val result = loader.load(parent)
      loader.complete(requests.last().first, response().replace("album:expanded", parent))
      assertTrue(result.get())
    }
    assertTrue(BrowseTreeCache.getChildren("album:0").isEmpty())
    assertEquals(38, BrowseTreeCache.getChildren("album:40").size)
    val saved = org.json.JSONObject(java.io.File(context.filesDir, "carauto_tree.json").readText())
    assertEquals(40, saved.getJSONArray("demandedAlbums").length())
  }
}
