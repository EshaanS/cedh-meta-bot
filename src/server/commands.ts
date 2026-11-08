// Slash command definitions (one source for registration and tests). Admin-only by default
// (Manage Server); guild-installed and usable in servers only.

const MANAGE_GUILD = "32";
const common = { default_member_permissions: MANAGE_GUILD, contexts: [0], integration_types: [0] };

const SUB_COMMAND = 1;
const STRING = 3;
const CHANNEL = 7;
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;

export const COMMANDS = [
  {
    ...common,
    name: "region",
    description: "Choose or show the region for this server's monthly cEDH report",
    options: [
      {
        type: SUB_COMMAND,
        name: "set",
        description: "Choose the region for this server's report",
        options: [{ type: STRING, name: "region", description: "Region (start typing to search)", required: true, autocomplete: true }],
      },
      { type: SUB_COMMAND, name: "show", description: "Show this server's region and posting settings" },
    ],
  },
  {
    ...common,
    name: "channel",
    description: "Choose where the monthly cEDH report is posted",
    options: [
      {
        type: SUB_COMMAND,
        name: "set",
        description: "Choose the channel for the monthly report",
        options: [
          { type: CHANNEL, name: "channel", description: "Text or announcement channel", required: true, channel_types: [GUILD_TEXT, GUILD_ANNOUNCEMENT] },
        ],
      },
    ],
  },
  {
    ...common,
    name: "preview",
    description: "Preview last month's report (only you will see it)",
  },
] as const;
