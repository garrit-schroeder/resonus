package expo.modules.carauto

import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class CarAutoPlaybackSyncTest {
  private val functions = CarAutoModule().definition().syncFunctions
  private var service: ServiceController<ResonusCarBrowserService>? = null

  private fun call(name: String, arg: Any?) {
    functions.getValue(name).callUserImplementation(arrayOf(arg))
  }

  private fun startCar(): JsProxyPlayer {
    service = Robolectric.buildService(ResonusCarBrowserService::class.java).create()
    return checkNotNull(ResonusCarBrowserService.activePlayer)
  }

  private fun pushPlayback() {
    call("setQueue", """{"tracks":[{"id":"comfort","title":"Comfort Zone"},{"id":"ordinary","title":"Ordinary"}],"currentIndex":1}""")
    call("setNowPlaying", """{"id":"ordinary","title":"Ordinary (refined)","durationMs":180000}""")
    call("setPlaybackState", """{"isPlaying":true,"positionMs":10000,"shuffle":true,"repeatMode":"all","favorite":true,"favoriteLabel":"Favorite"}""")
  }

  private fun assertPlayback(player: JsProxyPlayer) {
    assertEquals(2, player.mediaItemCount)
    assertEquals(1, player.currentMediaItemIndex)
    assertEquals("ordinary", player.currentMediaItem?.mediaId)
    assertTrue(player.playWhenReady)
    assertTrue(player.currentPosition >= 10_000L)
    assertTrue(player.shuffleModeEnabled)
    assertEquals(Player.REPEAT_MODE_ALL, player.repeatMode)
    assertEquals(true, player.favorite)
    assertEquals("Favorite", player.favoriteLabel)
  }

  @After
  fun stopCar() {
    service?.destroy()
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test
  fun phonePlaybackIsAvailableWhenTheCarServiceStartsLater() {
    pushPlayback()
    assertPlayback(startCar())
  }

  @Test
  fun playbackIsStillMirroredWhenTheCarIsAlreadyConnected() {
    val player = startCar()
    pushPlayback()
    assertPlayback(player)
  }

  @Test
  fun reconnectRestoresLatestQueueIndexAndPausedState() {
    startCar()
    pushPlayback()
    service?.destroy()
    service = null
    call("setQueueIndex", 0)
    call("setPlaybackState", """{"isPlaying":false,"positionMs":12000,"shuffle":false,"repeatMode":"off","favorite":null}""")
    val player = startCar()
    assertEquals(2, player.mediaItemCount)
    assertEquals(0, player.currentMediaItemIndex)
    assertEquals("comfort", player.currentMediaItem?.mediaId)
    assertFalse(player.playWhenReady)
    assertEquals(12_000L, player.currentPosition)
    assertEquals(null, player.favorite)
  }

  @Test
  fun clearingPlaybackWhileDisconnectedDoesNotResurrectTheOldSong() {
    pushPlayback()
    call("setQueue", """{"tracks":[],"currentIndex":0}""")
    call("setNowPlaying", null)
    val player = startCar()
    assertEquals(0, player.mediaItemCount)
    assertFalse(player.playWhenReady)
    assertEquals(Player.STATE_IDLE, player.playbackState)
  }

  @Test
  fun explicitStopIsPreservedEvenIfTheQueueIsRetained() {
    pushPlayback()
    call("setNowPlaying", null)
    val player = startCar()
    assertEquals(2, player.mediaItemCount)
    assertFalse(player.playWhenReady)
    assertEquals(Player.STATE_IDLE, player.playbackState)
    assertEquals(0L, player.currentPosition)
  }

  @Test
  fun bridgeUpdatesPostedBeforeServiceCreationReachTheNewPlayer() {
    // Expo bridge calls can arrive away from the application's main thread.
    Thread { pushPlayback() }.apply { start(); join() }
    val player = startCar()
    shadowOf(Looper.getMainLooper()).idle()
    assertPlayback(player)
  }
}
