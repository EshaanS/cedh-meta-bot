// Top-level error reporting for scripts. Prints the stack trace, with secrets redacted.
// Only the stack string is printed, never the error object: util.inspect would also print
// extra properties such as a URL error's `input`, which can hold the full DATABASE_URL.

const MIN_SECRET_LENGTH = 3;

/** DATABASE_URL, its password (raw and percent-decoded), and TOPDECK_API_KEY, when set. */
function secrets(): string[] {
  const found: string[] = [];
  const url = process.env.DATABASE_URL;
  if (url) {
    found.push(url);
    // Parsed by hand so a malformed URL can still be redacted: userinfo ends at the last "@"
    // before any query string, and the password is everything after the first ":" in it.
    const rest = url.slice(url.indexOf("://") + 3).split("?")[0] ?? "";
    const at = rest.lastIndexOf("@");
    const colon = at > 0 ? rest.indexOf(":") : -1;
    if (colon >= 0 && colon < at) {
      const password = rest.slice(colon + 1, at);
      found.push(password);
      try {
        found.push(decodeURIComponent(password));
      } catch {
        // Malformed percent-encoding: the raw form is already redacted.
      }
    }
  }
  const key = process.env.TOPDECK_API_KEY;
  if (key) found.push(key);
  // Longest first, so a password inside the URL doesn't break redaction of the whole URL.
  return found.filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

export function redact(text: string): string {
  return secrets().reduce((t, s) => t.split(s).join("[redacted]"), text);
}

/** Prints `<script> failed:` and the redacted stack trace to stderr, then exits with code 1. */
export function exitWithError(script: string, err: unknown): never {
  const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  process.stderr.write(`${script} failed:\n${redact(detail)}\n`);
  process.exit(1);
}
