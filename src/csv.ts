/** Parses a simple CSV with `email` and `user_id` columns (no embedded commas). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseUsersCsv(text: string): { email: string; userId: string }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines.shift()?.split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase()) ?? [];
  const ei = header.indexOf("email");
  const ui = header.indexOf("user_id");
  if (ei < 0 || ui < 0) throw new Error("CSV needs `email` and `user_id` columns");
  return lines
    .map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")))
    .map((c) => ({ email: (c[ei] ?? "").toLowerCase(), userId: c[ui] ?? "" }))
    .filter((r) => EMAIL_RE.test(r.email) && r.userId);
}
