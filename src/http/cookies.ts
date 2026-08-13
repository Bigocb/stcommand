/**
 * A minimal `Cookie` header parser — deliberately not the `cookie-parser`
 * package. The app only ever needs to read back one value it wrote itself
 * (see crypto.ts's "no JWT library" note for the same reasoning applied to
 * session signing), so a small hand-rolled parser is less surface than a
 * dependency for a one-line job.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}
