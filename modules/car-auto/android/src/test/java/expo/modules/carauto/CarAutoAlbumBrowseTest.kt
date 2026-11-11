package expo.modules.carauto

import android.os.Bundle
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.Duration

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class CarAutoAlbumBrowseTest {
  private lateinit var controller: ServiceController<ResonusCarBrowserService>
  private lateinit var callback: MediaLibrarySession.Callback
  private lateinit var session: MediaLibrarySession
  private val browser = MediaSession.ControllerInfo.createTestOnlyControllerInfo(
    "test.browser", 1, 1, 1, 1, false, Bundle.EMPTY, true,
  )

  @Before fun setup() {
    controller = Robolectric.buildService(ResonusCarBrowserService::class.java).create()
    val service = controller.get()
    // Exercise the production callback without introducing a test-only app API.
    val constructor = ResonusCarBrowserService::class.java.declaredClasses
      .single { it.simpleName == "LibraryCallback" }
      .getDeclaredConstructor(ResonusCarBrowserService::class.java)
    constructor.isAccessible = true
    callback = constructor.newInstance(service) as MediaLibrarySession.Callback
    session = checkNotNull(service.onGetSession(browser))
    BrowseTreeCache.setFromJson(service, """{"profile":"reset","nodes":{}}""")
    BrowseTreeCache.setFromJson(service, """{"profile":"a","nodes":{"root":[{"id":"album:expanded","title":"Expanded","playable":false}]}}""")
  }

  @After fun cleanup() {
    controller.destroy()
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test fun getChildrenWaitsThenReturnsTheRequestedPageInsteadOfAnEmptySuccess() {
    val result = callback.onGetChildren(session, browser, "album:expanded", 1, 20, null)
    assertFalse(result.isDone)
    val songs = (0 until 38).joinToString(",") {
      """{"id":"track|album:expanded|song-$it","title":"Track $it","playable":true}"""
    }
    val changed = BrowseTreeCache.setFromJson(controller.get(), """{"profile":"a","partial":true,"nodes":{"album:expanded":[$songs]}}""")
    ResonusCarBrowserService.notifyTreeChanged(changed)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(LibraryResult.RESULT_SUCCESS, result.get().resultCode)
    assertEquals(18, result.get().value?.size)
    assertEquals("track|album:expanded|song-20", result.get().value?.first()?.mediaId)
    assertTrue(callback.onGetChildren(session, browser, "album:expanded", 0, 20, null).isDone)
  }

  @Test fun aTimeoutIsAnErrorAndCanBeRetried() {
    val result = callback.onGetChildren(session, browser, "album:expanded", 0, 20, null)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(16))
    assertEquals(SessionError.ERROR_IO, result.get().resultCode)
    assertFalse(callback.onGetChildren(session, browser, "album:expanded", 0, 20, null).isDone)
  }
}
