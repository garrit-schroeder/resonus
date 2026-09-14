/**
 * Whether a cover is animated (GIF, animated WebP, APNG). Nothing in the API
 * says so, and the file is not ours to sniff, so the answer comes from the
 * decoder itself: `expo-image` reports `isAnimated` once it has loaded the
 * picture, and `Cover` hands it over here.
 *
 * That makes the answer arrive one load late, so it is kept per URL: a cover
 * seen before is known before it is drawn again, and only a new one goes
 * through the plain layout for the moment it takes to decode.
 */
import { useEffect, useRef, useState } from 'react';

export function useAnimatedCover(uri?: string) {
  const [isAnimated, setIsAnimated] = useState(false);
  const cache = useRef(new Map<string, boolean>());

  // A new song is a new question: what was true of the cover before it says
  // nothing about this one, so the answer resets until either the cache or the
  // decoder gives it.
  useEffect(() => {
    setIsAnimated(uri ? (cache.current.get(uri) ?? false) : false);
  }, [uri]);

  /**
   * The answer carries the cover it is about. A load that finishes after the
   * song has changed would otherwise be filed under whichever cover is up by
   * then, which on a fast skip is somebody else's.
   */
  const onCoverLoad = (loaded: string, animated: boolean) => {
    cache.current.set(loaded, animated);
    if (loaded === uri) setIsAnimated(animated);
  };

  return { isAnimated, onCoverLoad };
}
