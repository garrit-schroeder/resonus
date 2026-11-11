package expo.modules.carauto

import androidx.annotation.OptIn
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class JsProxyPlayerTest {
  private fun track(id: String) = JsProxyPlayer.NowPlaying(
    id, "Track $id", "Artist", "Album", null, 180_000L,
  )

  private fun uids(player: JsProxyPlayer): List<Any> =
    (0 until player.mediaItemCount).map {
      player.currentTimeline.getWindow(it, Timeline.Window()).uid
    }

  @Test
  fun repeatedSongsKeepTheirMediaIdsButHaveDistinctTimelineUids() {
    val player = JsProxyPlayer()
    try {
      player.applyQueue(listOf(track("comfort"), track("ordinary"), track("ordinary")), 0)
      val ids = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
      assertEquals(listOf("comfort", "ordinary", "ordinary"), ids)
      assertEquals(3, uids(player).toSet().size)
    } finally {
      player.release()
    }
  }

  @Test
  fun songIdsContainingSuffixesCannotCollideWithRepeatedEntries() {
    val player = JsProxyPlayer()
    try {
      player.applyQueue(listOf(track("a"), track("a"), track("a#1")), 1)
      assertEquals(3, uids(player).toSet().size)
    } finally {
      player.release()
    }
  }

  @Test
  fun duplicateIdentitySurvivesMovingTheCarQueueWindow() {
    val tracks = (0..150).map { track(if (it == 0 || it == 25) "ordinary" else "song-$it") }
    val player = JsProxyPlayer()
    try {
      player.applyQueue(tracks, 20)
      val before = uids(player)
      val firstUid = before[0]
      val secondUid = before[25]
      player.applyQueueIndex(21) // The first occurrence leaves the car's window.
      val after = uids(player)
      assertEquals(secondUid, after[24])
      assertNotEquals(firstUid, secondUid)
      assertEquals(20, player.currentMediaItemIndex)
    } finally {
      player.release()
    }
  }

  @Test
  fun duplicateEnteringTheVisibleQueueAfterASkipDoesNotCrash() {
    val tracks = (0..109).map { track(if (it == 98 || it == 101) "ordinary" else "song-$it") }
    val player = JsProxyPlayer()
    try {
      player.applyQueue(tracks, 0)
      assertEquals(101, player.mediaItemCount)
      player.applyQueueIndex(1)
      assertEquals(102, player.mediaItemCount)
      assertEquals(102, uids(player).toSet().size)
    } finally {
      player.release()
    }
  }
}
