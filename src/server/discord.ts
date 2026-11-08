// Minimal Discord REST client over fetch. Every message is sent with allowed_mentions: { parse: [] }.
// Honors 429 retry_after. Errors carry Discord's JSON error code; interaction tokens are redacted from messages.
import type { Embed } from "../../scripts/lib/post";

export const DISCORD_ERRORS = {
  unknownChannel: 10003,
  unknownGuild: 10004,
  missingAccess: 50001,
  missingPermissions: 50013,
} as const;

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DiscordError";
  }
}

export type MessagePayload = { content?: string; embeds?: Embed[]; flags?: number };

export interface DiscordClient {
  createMessage(channelId: string, payload: MessagePayload): Promise<void>;
  editOriginal(appId: string, interactionToken: string, payload: MessagePayload): Promise<void>;
  listGuildIds(): Promise<string[]>;
  putCommands(appId: string, guildId: string | null, commands: unknown[]): Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (path: string) => path.replace(/(\/webhooks\/\d+\/)[^/]+/, "$1[token]");

export function discordClient(opts: { token: string; base?: string; fetchImpl?: typeof fetch }): DiscordClient {
  const base = opts.base ?? process.env.DISCORD_API_BASE ?? "https://discord.com/api/v10";
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(method: string, path: string, body?: unknown, auth = true): Promise<unknown> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(auth ? { Authorization: `Bot ${opts.token}` } : {}),
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (https://github.com/EshaanS/cedh-meta-bot, 1.0)",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429) {
        const info = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.ceil((info.retry_after ?? 1) * 1000));
        continue;
      }
      const text = await res.text();
      const json = text ? (JSON.parse(text) as { code?: number; message?: string }) : null;
      if (!res.ok) {
        throw new DiscordError(res.status, json?.code, `${method} ${redact(path)} -> HTTP ${res.status}${json?.message ? ` (${json.message})` : ""}`);
      }
      return json;
    }
    throw new DiscordError(429, undefined, `${method} ${redact(path)} -> still rate limited after 5 attempts`);
  }

  const withMentionsOff = (payload: MessagePayload) => ({ ...payload, allowed_mentions: { parse: [] } });

  return {
    async createMessage(channelId, payload) {
      await call("POST", `/channels/${channelId}/messages`, withMentionsOff(payload));
    },
    async editOriginal(appId, interactionToken, payload) {
      await call("PATCH", `/webhooks/${appId}/${interactionToken}/messages/@original`, withMentionsOff(payload), false);
    },
    async listGuildIds() {
      const ids: string[] = [];
      let after = "0";
      for (;;) {
        const page = (await call("GET", `/users/@me/guilds?limit=200&after=${after}`)) as { id: string }[];
        ids.push(...page.map((g) => g.id));
        if (page.length < 200) return ids;
        after = page[page.length - 1]!.id;
      }
    },
    putCommands(appId, guildId, commands) {
      const path = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
      return call("PUT", path, commands);
    },
  };
}
