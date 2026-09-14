package expo.modules.upnpcast

/** Pure decisions shared by polling and unit tests. */
internal object GenericQueueProgression {
  fun nextIndex(size: Int, currentIndex: Int, playMode: String): Int? {
    if (size <= 0 || currentIndex !in 0 until size) return null
    return when (playMode.uppercase()) {
      "REPEAT_ONE" -> currentIndex
      "REPEAT_ALL", "SHUFFLE" -> (currentIndex + 1) % size
      else -> (currentIndex + 1).takeIf { it < size }
    }
  }

  fun isNaturalEnd(
    observedPlaying: Boolean,
    stoppedByController: Boolean,
    lastPositionMs: Long,
    lastDurationMs: Long,
  ): Boolean {
    if (!observedPlaying || stoppedByController) return false
    val windowMs = maxOf(5_000L, lastDurationMs / 10)
    return lastDurationMs <= 0 || lastPositionMs >= lastDurationMs - windowMs
  }

  /**
   * Some renderers consume NextURI without a STOPPED state and omit TrackURI.
   * In that case the observable handoff is an end-of-track position followed
   * by a low position whose duration agrees with the staged item.
   */
  fun isStagedHandoff(
    playbackState: String,
    positionMs: Long,
    durationMs: Long,
    previousPositionMs: Long,
    previousDurationMs: Long,
    stagedDurationMs: Long,
  ): Boolean {
    if (!playbackState.equals("PLAYING", ignoreCase = true)) return false
    if (positionMs !in 0..10_000L || previousPositionMs - positionMs < 3_000L) return false
    if (previousDurationMs <= 0 || stagedDurationMs <= 0 || durationMs <= 0) return false
    val previousWindowMs = maxOf(5_000L, previousDurationMs / 10)
    val previousWasNearEnd = previousPositionMs >= previousDurationMs - previousWindowMs
    val durationMatchesStaged = kotlin.math.abs(durationMs - stagedDurationMs) <= 2_000L
    return previousWasNearEnd && durationMatchesStaged
  }
}
