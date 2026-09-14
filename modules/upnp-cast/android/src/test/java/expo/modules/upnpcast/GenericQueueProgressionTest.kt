package expo.modules.upnpcast

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GenericQueueProgressionTest {
  @Test fun repeatModesChooseExpectedIndex() {
    assertEquals(1, GenericQueueProgression.nextIndex(3, 0, "NORMAL"))
    assertNull(GenericQueueProgression.nextIndex(3, 2, "NORMAL"))
    assertEquals(0, GenericQueueProgression.nextIndex(3, 2, "REPEAT_ALL"))
    assertEquals(2, GenericQueueProgression.nextIndex(3, 2, "REPEAT_ONE"))
  }

  @Test fun retainedPreStopValuesRecogniseShortTrackEnds() {
    assertTrue(GenericQueueProgression.isNaturalEnd(true, false, 5_000, 6_000))
    assertTrue(GenericQueueProgression.isNaturalEnd(true, false, 17_000, 19_000))
  }

  @Test fun explicitOrUnobservedStopsNeverAdvance() {
    assertFalse(GenericQueueProgression.isNaturalEnd(true, true, 19_000, 19_000))
    assertFalse(GenericQueueProgression.isNaturalEnd(false, false, 19_000, 19_000))
    assertFalse(GenericQueueProgression.isNaturalEnd(true, false, 2_000, 60_000))
  }

  @Test fun unknownDurationMatchesExistingFallbackIntent() {
    assertTrue(GenericQueueProgression.isNaturalEnd(true, false, 1_000, 0))
  }

  @Test fun seamlessRendererHandoffIsRecognisedWithoutStoppedOrTrackUri() {
    assertTrue(GenericQueueProgression.isStagedHandoff("PLAYING", 0, 16_000, 26_000, 28_000, 16_000))
    assertTrue(GenericQueueProgression.isStagedHandoff("PLAYING", 3_000, 70_000, 14_000, 16_000, 70_000))
  }

  @Test fun ordinaryProgressOrAnUnrelatedDurationIsNotAHandoff() {
    assertFalse(GenericQueueProgression.isStagedHandoff("PLAYING", 15_000, 28_000, 14_000, 28_000, 16_000))
    assertFalse(GenericQueueProgression.isStagedHandoff("PLAYING", 0, 41_000, 26_000, 28_000, 16_000))
    assertFalse(GenericQueueProgression.isStagedHandoff("PAUSED", 0, 16_000, 26_000, 28_000, 16_000))
  }
}
