// Bulk add and remove, the parts that need no database: tolerant name matching, the typed-list grammar,
// radius items, and the summary replies.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addSummary, emptyAddOutcome, matchName, norm, parseRadius, removeSummary, resolveList, splitList,
  type Candidate, type Lookup,
} from "../src/server/place-matching";

const US = ["united states", "us", "usa"];
const CA = ["canada", "ca"];
const city = (name: string, state: string, code: string, country: string[], countryName: string): Candidate => ({
  value: `c:${code}:${name.toLowerCase()}`,
  label: `${name}, ${state}, ${countryName} (3 events)`,
  names: [norm(name)],
  quals: [norm(state), code.toLowerCase(), code.split("-")[1]!.toLowerCase(), ...country],
});
const region = (value: string, label: string, names: string[], quals: string[] = []): Candidate => ({ value, label, names, quals });
const PLACES: Candidate[] = [
  city("Tacoma", "Washington", "US-WA", US, "United States"),
  city("Issaquah", "Washington", "US-WA", US, "United States"),
  city("Vancouver", "Washington", "US-WA", US, "United States"),
  city("Vancouver", "British Columbia", "CA-BC", CA, "Canada"),
  city("Portland", "Oregon", "US-OR", US, "United States"),
  city("Portland", "Maine", "US-ME", US, "United States"),
  city("New York", "New York", "US-NY", US, "United States"),
  city("St. Louis", "Missouri", "US-MO", US, "United States"),
  city("Québec", "Québec", "CA-QC", CA, "Canada"),
  region("r:us-wa", "Washington (United States)", ["washington", "wa"], US),
  region("r:us-or", "Oregon (United States)", ["oregon", "or"], US),
  region("r:us-id", "Idaho (United States)", ["idaho", "id"], US),
  region("r:id", "Indonesia", ["indonesia", "id"]),
  region("r:ca", "Canada", ["canada", "ca"]),
  region("r:europe", "Europe", ["europe"]),
];
const value = (text: string) => {
  const m = matchName(PLACES, text);
  return m.kind === "one" ? m.candidate.value : m.kind === "many" ? m.options.map((c) => c.value) : null;
};

test("norm: case, accents, full stops and spacing", () => {
  assert.equal(norm("  St.  Louis "), "st louis");
  assert.equal(norm("QUÉBEC"), "quebec");
  assert.equal(norm("Baden-Württemberg"), "baden-wurttemberg");
  assert.equal(norm("   "), "");
});

test("matchName: exact names only, with an optional state or country after a space or a comma", () => {
  assert.equal(value("tacoma"), "c:US-WA:tacoma");
  assert.equal(value("  TACOMA  "), "c:US-WA:tacoma");
  assert.equal(value("Tacoma, WA"), "c:US-WA:tacoma");
  assert.equal(value("Tacoma WA"), "c:US-WA:tacoma");
  assert.equal(value("Tacoma, Washington"), "c:US-WA:tacoma");
  assert.equal(value("tacoma washington usa"), "c:US-WA:tacoma");
  assert.equal(value("Tacoma, WA, US"), "c:US-WA:tacoma");
  assert.equal(value("Tacoma, US-WA"), "c:US-WA:tacoma");
  assert.equal(value("Tacoma, Washington, United States (3 events)"), "c:US-WA:tacoma", "the label from the list");
  assert.equal(value("Tacoma, Washington, United States"), "c:US-WA:tacoma", "the label without its count");
  assert.equal(value("quebec"), "c:CA-QC:québec");
  assert.equal(value("st louis"), "c:US-MO:st. louis");
  assert.equal(value("New York"), "c:US-NY:new york", "a city whose name is also its state");
  assert.equal(value("New York NY"), "c:US-NY:new york");
  assert.equal(value("europe"), "r:europe");
  assert.equal(value("WA"), "r:us-wa", "a state by its code");
  // Never a prefix, a typo or a wrong qualifier.
  for (const miss of ["tac", "Tacomaa", "Tacoma, OR", "Tacoma Canada", "Seattle", "", "   ", ","]) assert.equal(value(miss), null, miss);
});

test("matchName: a name with several candidates is never guessed", () => {
  assert.deepEqual(value("Vancouver"), ["c:CA-BC:vancouver", "c:US-WA:vancouver"], "in label order");
  assert.equal(value("Vancouver BC"), "c:CA-BC:vancouver");
  assert.equal(value("Vancouver, British Columbia"), "c:CA-BC:vancouver");
  assert.equal(value("Vancouver WA"), "c:US-WA:vancouver");
  assert.equal(value("Vancouver, Canada"), "c:CA-BC:vancouver");
  assert.deepEqual(value("Portland, US"), ["c:US-ME:portland", "c:US-OR:portland"], "the country doesn't settle it");
  assert.deepEqual(value("ID"), ["r:us-id", "r:id"], "Idaho or Indonesia");
  assert.deepEqual(value("ca"), "r:ca");
});

test("splitList: semicolons or line breaks when present, otherwise commas", () => {
  assert.deepEqual(splitList("Tacoma, Issaquah ,  Lacey,"), { items: ["Tacoma", "Issaquah", "Lacey"], byComma: true });
  assert.deepEqual(splitList("Tacoma, Washington; Portland, Oregon ;"), { items: ["Tacoma, Washington", "Portland, Oregon"], byComma: false });
  assert.deepEqual(splitList("Tacoma\nIssaquah"), { items: ["Tacoma", "Issaquah"], byComma: false });
  assert.deepEqual(splitList("Tacoma"), { items: ["Tacoma"], byComma: true });
  assert.deepEqual(splitList(" ; , "), { items: [","], byComma: false });
  assert.deepEqual(splitList(""), { items: [], byComma: true });
});

test("parseRadius: a distance and a center", () => {
  assert.deepEqual(parseRadius("50 km of Seattle"), { km: 50, center: "Seattle" });
  assert.deepEqual(parseRadius("within 80km of Tacoma, WA"), { km: 80, center: "Tacoma, WA" });
  assert.deepEqual(parseRadius("25 KM around Boise"), { km: 25, center: "Boise" });
  assert.deepEqual(parseRadius("5000 km from Seattle"), { km: 5000, center: "Seattle" });
  for (const no of ["Seattle", "50 km", "km of Seattle", "50 miles of Seattle", "-5 km of Seattle", "2.5 km of Seattle", ""]) assert.equal(parseRadius(no), null, no);
});

const lookup = (item: string): Lookup<string> => {
  const m = matchName(PLACES, item);
  if (m.kind === "one") return { kind: "one", value: m.candidate.value, label: m.candidate.label };
  if (m.kind === "many") return { kind: "many", options: m.options.map((c) => c.label) };
  return { kind: "none" };
};
const CODES = new Set(PLACES.flatMap((p) => p.quals).filter((q) => /^[a-z]{2,3}$/.test(q)));
const isCode = (token: string) => CODES.has(norm(token));
const isLabel = (text: string) => PLACES.filter((p) => norm(p.label) === norm(text) || norm(p.label.replace(/ \(\d+ events\)$/, "")) === norm(text)).length === 1;
const resolve = (text: string) =>
  resolveList(text, lookup, isCode, isLabel).map((r) => (r.kind === "one" ? r.value : `${r.kind}:${r.input}`));

test("resolveList: a comma list, where a state code after a city is its qualifier", () => {
  assert.deepEqual(resolve("Tacoma, Issaquah, Europe"), ["c:US-WA:tacoma", "c:US-WA:issaquah", "r:europe"]);
  assert.deepEqual(resolve("Tacoma, WA, Portland, OR, Vancouver BC"), ["c:US-WA:tacoma", "c:US-OR:portland", "c:CA-BC:vancouver"]);
  assert.deepEqual(resolve("Tacoma, WA, US, Issaquah"), ["c:US-WA:tacoma", "c:US-WA:issaquah"]);
  assert.deepEqual(resolve("Washington, Oregon, Idaho"), ["r:us-wa", "r:us-or", "r:us-id"], "three states, not a city with qualifiers");
  assert.deepEqual(resolve("Vancouver, Tacoma, Atlantis"), ["many:Vancouver", "c:US-WA:tacoma", "none:Atlantis"]);
  assert.deepEqual(resolve("Vancouver, BC"), ["c:CA-BC:vancouver"]);
  assert.deepEqual(resolve("tacoma,,  , TACOMA"), ["c:US-WA:tacoma", "c:US-WA:tacoma"], "duplicates are the caller's to report");
  assert.deepEqual(resolve(""), []);
});

test("resolveList: a full state name after a city could be one place or two, so it is reported, not guessed", () => {
  assert.deepEqual(resolve("Portland, Oregon"), ["split:Portland, Oregon"]);
  assert.deepEqual(resolve("Tacoma, Washington, Issaquah"), ["split:Tacoma, Washington", "c:US-WA:issaquah"]);
  const [split] = resolveList("Portland, Oregon", lookup, isCode, isLabel);
  assert.deepEqual(split, { kind: "split", input: "Portland, Oregon", options: ["Portland, Oregon, United States (3 events)"] });
  // The same text with semicolons, or as the label pasted on its own, is one place.
  assert.deepEqual(resolve("Portland, Oregon; Tacoma, Washington"), ["c:US-OR:portland", "c:US-WA:tacoma"]);
  assert.deepEqual(resolve("Portland, Oregon;"), ["c:US-OR:portland"]);
  assert.deepEqual(resolve("Portland, Oregon, United States"), ["c:US-OR:portland"], "exactly one label from the list");
  assert.deepEqual(resolve("Tacoma, Washington, United States (3 events)"), ["c:US-WA:tacoma"]);
});

test("resolveList: semicolons and line breaks keep commas inside a place", () => {
  assert.deepEqual(resolve("Tacoma, WA; Vancouver, British Columbia; Vancouver; Atlantis, Ocean"), [
    "c:US-WA:tacoma", "c:CA-BC:vancouver", "many:Vancouver", "none:Atlantis, Ocean",
  ]);
  assert.deepEqual(resolve("Tacoma\nPortland, Maine\n"), ["c:US-WA:tacoma", "c:US-ME:portland"]);
});

test("addSummary: every category, stated exactly", () => {
  const o = emptyAddOutcome();
  assert.equal(addSummary("Seattle Metro", o, 3, 25), "Seattle Metro: nothing added (3 of 25 places).");
  o.added.push("Tacoma, Washington, United States", "within 50 km of Seattle, Washington, United States");
  o.present.push("Issaquah, Washington, United States");
  o.ambiguous.push({ input: "Vancouver", options: ["Vancouver, British Columbia, Canada", "Vancouver, Washington, United States"] });
  o.split.push({ input: "Portland, Oregon", options: ["Portland, Oregon, United States"] });
  o.notFound.push({ input: "Atlantis" }, { input: "Seattle", hint: "no events there in the last 12 months; for the area around it use the around option" });
  o.invalid.push({ input: "500 km of Seattle", reason: "a radius must be 10 to 200 km" });
  o.full.push("Lacey, Washington, United States");
  assert.equal(addSummary("Seattle Metro", o, 25, 25), [
    "Seattle Metro: added 2 places (25 of 25).",
    "Added: Tacoma, Washington, United States; within 50 km of Seattle, Washington, United States",
    "Already in the region: Issaquah, Washington, United States",
    "More than one match, not added:",
    '• "Vancouver" could be Vancouver, British Columbia, Canada or Vancouver, Washington, United States.',
    'Add the state or country, for example "Vancouver BC", or pick from the list that appears as you type.',
    "Could be one place or several, not added:",
    '• "Portland, Oregon" could be Portland, Oregon, United States, or separate places.',
    'Put semicolons between places, for example "Portland, Oregon; Tacoma, Washington".',
    'Not found: "Atlantis"; "Seattle" (no events there in the last 12 months; for the area around it use the around option)',
    "Cities are listed only when they have events in the data. Start typing in a place option to see what exists.",
    'Can\'t be used: "500 km of Seattle" (a radius must be 10 to 200 km)',
    "Not added, the region is full (25 places): Lacey, Washington, United States. Remove a place with /region remove first.",
  ].join("\n"));
  const one = emptyAddOutcome();
  one.added.push("Europe");
  assert.equal(addSummary("Old World", one, 1, 25), "Old World: added 1 place (1 of 25).\nAdded: Europe");
});

test("summaries stay under Discord's 2,000 characters however long the input", () => {
  const o = emptyAddOutcome();
  for (let k = 0; k < 60; k++) {
    o.added.push(`Place number ${k}, Some State, Some Country`);
    o.present.push(`Present ${k}, Some State, Some Country`);
    o.ambiguous.push({ input: `name ${k} ${"x".repeat(200)}`, options: Array.from({ length: 9 }, (_, j) => `Option ${j}, State, Country`) });
    o.notFound.push({ input: `missing ${k} ${"y".repeat(200)}` });
    o.full.push(`Full ${k}, Some State, Some Country`);
  }
  const text = addSummary("R".repeat(40), o, 25, 25);
  assert.ok(text.length <= 1900, `${text.length} characters`);
  assert.match(text, /\+48 more/);
  assert.match(text, /or 4 more\./, "long option lists are cut too");
  const removed = removeSummary("R".repeat(40), { removed: o.added, ambiguous: o.ambiguous, notFound: o.notFound.map((n) => n.input) }, 0);
  assert.ok(removed.length <= 1900, `${removed.length} characters`);
});

test("removeSummary: removed, ambiguous, not in the region, and the empty-region warning", () => {
  assert.equal(removeSummary("Seattle Metro", { removed: [], ambiguous: [], notFound: [] }, 1), "Seattle Metro: nothing removed (1 place).");
  assert.equal(
    removeSummary("Seattle Metro", {
      removed: ["Tacoma, Washington, United States", "within 50 km of Seattle, Washington, United States"],
      ambiguous: [{ input: "Vancouver", options: ["Vancouver, British Columbia, Canada", "Vancouver, Washington, United States"] }],
      notFound: ["Atlantis"],
    }, 2),
    [
      "Seattle Metro: removed 2 places (2 left).",
      "Removed: Tacoma, Washington, United States; within 50 km of Seattle, Washington, United States",
      "More than one match, not removed:",
      '• "Vancouver" could be Vancouver, British Columbia, Canada or Vancouver, Washington, United States.',
      'Not in Seattle Metro: "Atlantis". Pick from the list that appears as you type.',
    ].join("\n"),
  );
  assert.equal(
    removeSummary("Seattle Metro", { removed: ["Europe"], ambiguous: [], notFound: [] }, 0),
    "Seattle Metro: removed 1 place (0 left).\nRemoved: Europe\nSeattle Metro has no places left, so its reports will have no events until you add some.",
  );
});
