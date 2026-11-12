// The application's color identity pies, as a post writes them. Read from Discord (the application's own emoji
// list) and kept per instance for ten minutes. Decoration only: without an application id, with the switch
// off, or when Discord fails, the answer is "none" and the post shows the color circles.
import { colorEmojiMarkup } from "../../scripts/lib/color-emoji";
import { redact } from "../../scripts/lib/errors";
import { POST_CONFIG } from "../../scripts/lib/post";
import type { DiscordClient } from "./discord";

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; appId: string; markup: Record<string, string> } | null = null;

/** Color identity ("WU", "" for colorless) to emoji markup, for the pies the application has. Never throws. */
export async function loadColorEmoji(discord: Pick<DiscordClient, "listAppEmojis">, appId: string | undefined, now: number = Date.now()): Promise<Record<string, string>> {
  if (!appId || POST_CONFIG.colorPies < 1 || POST_CONFIG.colorSquares < 1) return {};
  if (cache && cache.appId === appId && now - cache.at < CACHE_MS) return cache.markup;
  try {
    const markup = colorEmojiMarkup(await discord.listAppEmojis(appId));
    cache = { at: now, appId, markup };
    return markup;
  } catch (err) {
    console.warn(`color emoji: ${redact(err instanceof Error ? err.message : String(err))}; using circles`);
    return {};
  }
}

/** For tests: forget the cached list. */
export const resetColorEmojiCache = () => {
  cache = null;
};
