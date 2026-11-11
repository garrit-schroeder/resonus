/** The played episodes of a show, read once per surface under one key. */
import { useQuery } from '@tanstack/react-query';

import { playedEpisodeIds } from '@/api/podcasts';

const NONE: Set<string> = new Set();

export function usePodcastPlayedIds(channelId: string | undefined): Set<string> {
  const q = useQuery({
    queryKey: ['podcastPlayed', channelId],
    queryFn: () => playedEpisodeIds(channelId!),
    enabled: !!channelId,
  });
  return q.data ?? NONE;
}
