// Slash command definitions (one source for registration and tests). Admin-only by default
// (Manage Server); guild-installed and usable in servers only.

const MANAGE_GUILD = "32";
const common = { default_member_permissions: MANAGE_GUILD, contexts: [0], integration_types: [0] };

const SUB_COMMAND = 1;
const STRING = 3;
const CHANNEL = 7;
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;

/** Optional on /region add and /region remove: which of the server's custom regions to change. */
const CUSTOM_REGION_OPTION = { type: STRING, name: "region", description: "Which custom region (needed only when this server has several)", required: false, autocomplete: true };

export const COMMANDS = [
  {
    ...common,
    name: "region",
    description: "Choose, show or build the region for this server's monthly cEDH report",
    options: [
      {
        type: SUB_COMMAND,
        name: "set",
        description: "Choose the region for this server's report",
        options: [{ type: STRING, name: "region", description: "Region (start typing to search)", required: true, autocomplete: true }],
      },
      { type: SUB_COMMAND, name: "show", description: "Show this server's region and posting settings" },
      {
        type: SUB_COMMAND,
        name: "create",
        description: "Create a custom region for this server, then add places to it",
        options: [{ type: STRING, name: "name", description: "Name shown in report titles, up to 40 characters", required: true, max_length: 100 }],
      },
      {
        type: SUB_COMMAND,
        name: "add",
        description: "Add a city, state, country, continent or region to a custom region",
        options: [
          { type: STRING, name: "place", description: "Place (start typing; cities are listed when they have events)", required: true, autocomplete: true },
          CUSTOM_REGION_OPTION,
        ],
      },
      {
        type: SUB_COMMAND,
        name: "remove",
        description: "Remove a place from a custom region",
        options: [
          { type: STRING, name: "place", description: "Place to remove (start typing to search)", required: true, autocomplete: true },
          CUSTOM_REGION_OPTION,
        ],
      },
      {
        type: SUB_COMMAND,
        name: "delete",
        description: "Delete one of this server's custom regions",
        options: [{ type: STRING, name: "region", description: "Custom region to delete", required: true, autocomplete: true }],
      },
      { type: SUB_COMMAND, name: "list", description: "List this server's custom regions" },
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
