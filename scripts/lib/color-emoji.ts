// Names of the color identity pies as Discord application emoji, and how a post writes one. The images are
// drawn by scripts/lib/color-pie.ts and uploaded by scripts/color-emoji.ts; this file has no image code, so the
// Vercel app can import it.

/** Every color identity: colorless (""), then each subset of WUBRG in that order, fewest colors first (32). */
const position = (colors: string) => [...colors].map((l) => "WUBRG".indexOf(l)).join("");
export const COLOR_IDENTITIES: readonly string[] = Array.from({ length: 32 }, (_, mask) => [..."WUBRG"].filter((_, i) => mask & (1 << i)).join(""))
  .sort((a, b) => a.length - b.length || position(a).localeCompare(position(b)));

/** "ci_wubr" for "WUBR", "ci_c" for colorless. Discord allows letters, digits and underscores, 2 to 32 long. */
export const colorEmojiName = (colors: string) => `ci_${colors === "" ? "c" : colors.toLowerCase()}`;

export type AppEmoji = { id: string; name: string };

/**
 * What a post writes for each color identity the application has a pie for: { WU: "<:ci_wu:123…>" }. Only
 * emoji with exactly our names and a numeric id are used; when two share a name the first is kept. An identity
 * that is missing here is shown with the color circles instead.
 */
export function colorEmojiMarkup(emojis: readonly AppEmoji[]): Record<string, string> {
  const byName = new Map<string, string>();
  for (const e of emojis) {
    if (typeof e?.name === "string" && typeof e?.id === "string" && /^\d{15,22}$/.test(e.id) && !byName.has(e.name)) byName.set(e.name, e.id);
  }
  return Object.fromEntries(COLOR_IDENTITIES.flatMap((colors) => {
    const name = colorEmojiName(colors);
    const id = byName.get(name);
    return id ? [[colors, `<:${name}:${id}>`] as const] : [];
  }));
}

/** Every identity with a made-up id of today's length (19 digits): for measuring a post's size without Discord. */
export const placeholderColorEmoji = (): Record<string, string> =>
  colorEmojiMarkup(COLOR_IDENTITIES.map((colors, i) => ({ id: String(1_300_000_000_000_000_000n + BigInt(i)), name: colorEmojiName(colors) })));
