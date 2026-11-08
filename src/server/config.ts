// Environment configuration for the Discord app. Secrets come from env only and are never logged.

/**
 * Guild gate. Fails closed: with no ALLOWED_GUILD_IDS and no ALLOW_ALL_GUILDS=true, no guild is allowed.
 * Returns "all" only when ALLOW_ALL_GUILDS is exactly "true".
 */
export function guildAllowlist(env: Record<string, string | undefined> = process.env): Set<string> | "all" {
  if (env.ALLOW_ALL_GUILDS === "true") return "all";
  return new Set((env.ALLOWED_GUILD_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function isGuildAllowed(allowlist: Set<string> | "all", guildId: string | undefined): boolean {
  return !!guildId && (allowlist === "all" || allowlist.has(guildId));
}

export function requireEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** "YYYY-MM" of the month before `now` (UTC). */
export function previousMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Day of the month from which the previous month's report may be posted (data final after 14 days). */
export const POST_FROM_DAY = 15;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (yyyyMm: string) => MONTHS[Number(yyyyMm.slice(5, 7)) - 1]!;
