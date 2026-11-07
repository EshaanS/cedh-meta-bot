// Plain-text table printer shared by quality.ts and report.ts.

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
};

/** Columns whose values are all numbers (optionally signed or with a trailing %) are right-aligned. */
export function renderTable(columns: string[], rows: Record<string, unknown>[]): string {
  const cells = rows.map((r) => columns.map((c) => cell(r[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)));
  const numeric = columns.map(
    (_, i) => cells.length > 0 && cells.every((row) => row[i] === "" || /^[+-]?\d+(\.\d+)?%?$/.test(row[i]!)),
  );
  const line = (vals: string[]) =>
    vals.map((v, i) => (numeric[i] ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(columns), widths.map((w) => "-".repeat(w)).join("  "), ...cells.map(line)].join("\n");
}
