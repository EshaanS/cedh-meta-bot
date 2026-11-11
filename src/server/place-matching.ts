// Tolerant matching of typed place names, parsing of a typed list of places, and the summary replies for
// bulk add and remove. Pure functions: no database, no Discord. The rule throughout is to never guess: a name
// with several candidates is reported with its options, and nothing is added for it.

/** Lower case, accents and full stops removed, whitespace collapsed: "  St. Louis " -> "st louis". */
export const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();

/**
 * Something a typed name can resolve to. `names` are the normalized names it answers to (a city's name, a
 * region's name, a code such as "wa" for a state); `quals` are the normalized qualifiers that may follow the
 * name (state name and code, country name and code).
 */
export type Candidate = { value: string; label: string; names: string[]; quals: string[] };
export type Match = { kind: "one"; candidate: Candidate } | { kind: "many"; options: Candidate[] } | { kind: "none" };

/** Several candidates are listed in label order, so the same question always gets the same answer. */
const toMatch = (found: Candidate[]): Match =>
  found.length === 0 ? { kind: "none" }
  : found.length === 1 ? { kind: "one", candidate: found[0]! }
  : { kind: "many", options: [...found].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)) };

/** True when `text` is one qualifier of the candidate, or several of them in a row ("wa usa"). */
function isQualified(c: Candidate, text: string): boolean {
  if (c.quals.includes(text)) return true;
  const words = text.split(" ");
  for (let i = 1; i < words.length; i++) {
    if (c.quals.includes(words.slice(0, i).join(" ")) && isQualified(c, words.slice(i).join(" "))) return true;
  }
  return false;
}

/**
 * Finds what a typed name means among `candidates`:
 *   1. an exact label ("Tacoma, Washington, United States");
 *   2. a name with qualifiers after commas ("Tacoma, WA", "Portland, Oregon, US");
 *   3. a name with qualifiers after spaces ("Vancouver BC"), preferring the longest name ("New York" before
 *      "New" + "York").
 * Names must be equal after normalizing; there is no prefix or fuzzy matching.
 */
export function matchName(candidates: Candidate[], text: string): Match {
  const t = norm(text);
  if (!t) return { kind: "none" };
  const exact = candidates.filter((c) => norm(c.label) === t);
  if (exact.length) return toMatch(exact);

  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const [name, ...quals] = parts;
    const found = candidates.filter((c) => c.names.includes(name!) && quals.every((q) => isQualified(c, q)));
    if (found.length) return toMatch(found);
  }

  const words = parts.join(" ").split(" ");
  for (let k = 0; k < words.length && k <= 5; k++) {
    const name = words.slice(0, words.length - k).join(" ");
    const qual = words.slice(words.length - k).join(" ");
    const found = candidates.filter((c) => c.names.includes(name) && (k === 0 || isQualified(c, qual)));
    if (found.length) return toMatch(found);
  }
  return { kind: "none" };
}

// ---------- a typed list of places ----------

/**
 * Splits a typed list. Semicolons (or line breaks) separate places when there are any, and then commas belong
 * to the place ("Tacoma, Washington; Portland, Oregon"). Otherwise commas separate ("Tacoma, Issaquah, Lacey").
 */
export function splitList(text: string): { items: string[]; byComma: boolean } {
  const bySemicolon = /[;\n\r]/.test(text);
  const items = text.split(bySemicolon ? /[;\n\r]+/ : /,/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  return { items, byComma: !bySemicolon };
}

/** "50 km of Seattle", "within 80km of Tacoma, WA", "25 km around Boise": the distance and the center text. */
export function parseRadius(text: string): { km: number; center: string } | null {
  const m = /^(?:within\s+)?(\d{1,5})\s*km\s+(?:of|around|from)\s+(.+)$/i.exec(text.trim());
  return m ? { km: Number(m[1]), center: m[2]!.trim() } : null;
}

export type Resolved<T> =
  | { kind: "one"; input: string; value: T }
  | { kind: "many"; input: string; options: string[] }
  | { kind: "split"; input: string; options: string[] }
  | { kind: "none"; input: string }
  | { kind: "invalid"; input: string; reason: string };

/** What resolving one piece of text gave: a value, several options, nothing, or a reason it can't be used. */
export type Lookup<T> =
  | { kind: "one"; value: T; label: string }
  | { kind: "many"; options: string[] }
  | { kind: "none" }
  | { kind: "invalid"; reason: string };

/** One piece of text looked up as a single thing (what a place option holds when it was typed, not picked). */
export function asResolved<T>(input: string, r: Lookup<T>): Resolved<T> {
  if (r.kind === "one") return { kind: "one", input, value: r.value };
  if (r.kind === "many") return { kind: "many", input, options: r.options };
  if (r.kind === "invalid") return { kind: "invalid", input, reason: r.reason };
  return { kind: "none", input };
}

/**
 * Resolves the items of a typed list in order. With semicolons each item is looked up as it is. In a comma
 * list a comma can also sit inside one place ("Tacoma, WA"), so items are joined with the one or two that
 * follow when that reads as a single place:
 *   - if what follows is only state or country codes ("WA", "BC", "US"), it is the qualifier, as people write it;
 *   - if it is a full name that is also a place by itself ("Portland, Oregon"), the text could be one place or
 *     two, so it is reported ("split") and nothing is added for it.
 */
export function resolveList<T>(
  text: string,
  lookup: (item: string) => Lookup<T>,
  isCode: (token: string) => boolean,
  /** True when the text is, word for word, the label of exactly one thing (as pasted from the list). */
  isExactLabel: (text: string) => boolean = () => false,
): Resolved<T>[] {
  const whole = text.replace(/\s+/g, " ").trim();
  const { items, byComma } = splitList(text);
  const out: Resolved<T>[] = [];
  const push = (input: string, r: Lookup<T>) => out.push(asResolved(input, r));
  if (!byComma) {
    for (const item of items) push(item, lookup(item));
    return out;
  }
  // The whole text may be one label pasted from the list ("Tacoma, Washington, United States").
  if (items.length > 1 && isExactLabel(whole)) {
    const asOne = lookup(whole);
    if (asOne.kind === "one") return [{ kind: "one", input: whole, value: asOne.value }];
  }
  for (let i = 0; i < items.length; ) {
    let taken = 1;
    let result: Resolved<T> | null = null;
    for (const span of [3, 2]) {
      if (i + span > items.length) continue;
      const joined = items.slice(i, i + span).join(", ");
      const r = lookup(joined);
      if (r.kind === "none" || r.kind === "invalid") continue;
      const rest = items.slice(i + 1, i + span);
      const restArePlaces = rest.some((token) => !isCode(token) && lookup(token).kind !== "none");
      if (restArePlaces) {
        result = { kind: "split", input: joined, options: r.kind === "one" ? [r.label] : r.options };
      } else {
        result = r.kind === "one" ? { kind: "one", input: joined, value: r.value } : { kind: "many", input: joined, options: r.options };
      }
      taken = span;
      break;
    }
    if (result) out.push(result);
    else push(items[i]!, lookup(items[i]!));
    i += taken;
  }
  return out;
}

// ---------- summaries ----------

export type AddOutcome = {
  added: string[];
  present: string[];
  ambiguous: { input: string; options: string[] }[];
  split: { input: string; options: string[] }[];
  notFound: { input: string; hint?: string }[];
  invalid: { input: string; reason: string }[];
  /** Resolved, but not added because the region already has the maximum number of places. */
  full: string[];
};
export const emptyAddOutcome = (): AddOutcome => ({ added: [], present: [], ambiguous: [], split: [], notFound: [], invalid: [], full: [] });

export type RemoveOutcome = { removed: string[]; ambiguous: { input: string; options: string[] }[]; notFound: string[] };

const SHOWN = 12;
const REPLY_MAX = 1900;
const count = (n: number) => `${n} ${n === 1 ? "place" : "places"}`;
const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 59)}…` : s}"`;
/** "a; b; c" with at most SHOWN entries, then "+N more". */
const some = (xs: string[], sep = "; ") => (xs.length <= SHOWN ? xs.join(sep) : `${xs.slice(0, SHOWN).join(sep)}${sep}+${xs.length - SHOWN} more`);
const orList = (xs: string[]) => {
  const shown = xs.slice(0, 5);
  const tail = xs.length > 5 ? ` or ${xs.length - 5} more` : "";
  return shown.length > 1 && !tail ? `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}` : `${shown.join(", ")}${tail}`;
};
const clip = (lines: string[]) => {
  const text = lines.join("\n");
  return text.length <= REPLY_MAX ? text : `${text.slice(0, REPLY_MAX - 1)}…`;
};

/** The reply to /region add: exactly what was added and what was not, and why. */
export function addSummary(region: string, o: AddOutcome, total: number, max: number): string {
  const lines = [
    o.added.length
      ? `${region}: added ${count(o.added.length)} (${total} of ${max}).`
      : `${region}: nothing added (${total} of ${max} places).`,
  ];
  if (o.added.length) lines.push(`Added: ${some(o.added)}`);
  if (o.present.length) lines.push(`Already in the region: ${some(o.present)}`);
  if (o.ambiguous.length) {
    lines.push("More than one match, not added:");
    for (const a of o.ambiguous.slice(0, SHOWN)) lines.push(`• ${quote(a.input)} could be ${orList(a.options)}.`);
    if (o.ambiguous.length > SHOWN) lines.push(`• +${o.ambiguous.length - SHOWN} more`);
    lines.push('Add the state or country, for example "Vancouver BC", or pick from the list that appears as you type.');
  }
  if (o.split.length) {
    lines.push("Could be one place or several, not added:");
    for (const a of o.split.slice(0, SHOWN)) lines.push(`• ${quote(a.input)} could be ${orList(a.options)}, or separate places.`);
    lines.push('Put semicolons between places, for example "Portland, Oregon; Tacoma, Washington".');
  }
  if (o.notFound.length) {
    lines.push(`Not found: ${some(o.notFound.map((n) => (n.hint ? `${quote(n.input)} (${n.hint})` : quote(n.input))))}`);
    if (o.notFound.some((n) => !n.hint)) lines.push("Cities are listed only when they have events in the data. Start typing in a place option to see what exists.");
  }
  if (o.invalid.length) lines.push(`Can't be used: ${some(o.invalid.map((n) => `${quote(n.input)} (${n.reason})`))}`);
  if (o.full.length) lines.push(`Not added, the region is full (${count(max)}): ${some(o.full)}. Remove a place with /region remove first.`);
  return clip(lines);
}

/** The reply to /region remove. */
export function removeSummary(region: string, o: RemoveOutcome, left: number): string {
  const lines = [o.removed.length ? `${region}: removed ${count(o.removed.length)} (${left} left).` : `${region}: nothing removed (${count(left)}).`];
  if (o.removed.length) lines.push(`Removed: ${some(o.removed)}`);
  if (o.ambiguous.length) {
    lines.push("More than one match, not removed:");
    for (const a of o.ambiguous.slice(0, SHOWN)) lines.push(`• ${quote(a.input)} could be ${orList(a.options)}.`);
  }
  if (o.notFound.length) lines.push(`Not in ${region}: ${some(o.notFound.map(quote))}. Pick from the list that appears as you type.`);
  if (o.removed.length && left === 0) lines.push(`${region} has no places left, so its reports will have no events until you add some.`);
  return clip(lines);
}
