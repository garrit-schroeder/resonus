/** Colored card for a genre (Spotify style). Links to /genre/[name]. */
import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { fontSize, radius, spacing, themed } from '@/theme';

/**
 * Stable color derived from the genre name.
 *
 * Deliberately the same under both appearances: the card is a block of colour
 * the way a cover is, not a surface of the page, and 32% lightness is what
 * keeps white readable on every hue the hash can land on (4.8:1 at worst).
 */
function genreColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 50%, 32%)`;
}

export function GenreCard({ name, width }: { name: string; width?: number }) {
  return (
    <Link href={`/genre/${encodeURIComponent(name)}`} asChild>
      <Pressable
        style={StyleSheet.flatten([
          styles.card,
          { backgroundColor: genreColor(name) },
          width != null ? { width } : { flex: 1 },
        ])}
      >
        <Text style={styles.text} numberOfLines={2}>
          {name}
        </Text>
      </Pressable>
    </Link>
  );
}

const styles = themed((colors) => ({
  card: {
    height: 88,
    borderRadius: radius.md,
    padding: spacing.md,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  // `onArtwork`, not `text`: what is behind the label is the card's own colour,
  // which does not follow the appearance. Under the light theme `text` is nearly
  // black, and on these cards that reads between 2.0:1 and 3.9:1.
  text: { color: colors.onArtwork, fontSize: fontSize.md, fontWeight: '600' },
}));
