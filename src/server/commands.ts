// Slash command definitions (one source for registration and tests). Admin-only by default
// (Manage Server); guild-installed and usable in servers only.
import { REGION_CONFIG } from "./custom-regions";

const MANAGE_GUILD = "32";
const common = { default_member_permissions: MANAGE_GUILD, contexts: [0], integration_types: [0] };

const SUB_COMMAND = 1;
const STRING = 3;
const INTEGER = 4;
const CHANNEL = 7;
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;

/** Optional on /region add and /region remove: which of the server's custom regions to change. */
const CUSTOM_REGION_OPTION = { type: STRING, name: "region", description: "Which custom region (needed only when this server has several)", required: false, autocomplete: true };

// Bulk add and remove. An autocomplete option holds one picked value (picking replaces what was typed, and a
// value is at most 100 characters), so one option can't collect several places. Instead there are five place
// options, each with its own autocomplete, and one free-text list for more or for pasting. Every option is
// optional for Discord; the command replies with a hint when none is given.
const placeOptions = (first: string, more: string) =>
  REGION_CONFIG.placeOptionNames.map((name, i) => ({ type: STRING, name, description: i === 0 ? first : more, required: false, autocomplete: true }));

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
        description: "Add cities, states, countries, continents or a radius around a city to a custom region",
        options: [
          ...placeOptions("Place (start typing; cities are listed when they have events)", "Another place (start typing)"),
          { type: STRING, name: "list", description: "Several places at once: Tacoma, Issaquah, Vancouver BC (semicolons if a place has a comma)", required: false, max_length: 1500 },
          { type: STRING, name: "around", description: "Everything within a distance of this city (start typing; set the distance with km)", required: false, autocomplete: true },
          {
            type: INTEGER,
            name: "km",
            description: `Distance for around, ${REGION_CONFIG.radiusMinKm} to ${REGION_CONFIG.radiusMaxKm} km (${REGION_CONFIG.radiusDefaultKm} if left out)`,
            required: false,
            min_value: REGION_CONFIG.radiusMinKm,
            max_value: REGION_CONFIG.radiusMaxKm,
          },
          CUSTOM_REGION_OPTION,
        ],
      },
      {
        type: SUB_COMMAND,
        name: "remove",
        description: "Remove one or more places from a custom region",
        options: [
          ...placeOptions("Place to remove (start typing to search)", "Another place to remove"),
          { type: STRING, name: "list", description: "Several places at once, separated by commas or semicolons", required: false, max_length: 1500 },
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
];
