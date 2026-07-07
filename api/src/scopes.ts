import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

const VAULT_PATH = process.env.VAULT_PATH ?? "/srv/braindance/ctx/vault";

export function getScopes(): string[] {
  const scopes: string[] = [];

  for (const entry of readdirSync(VAULT_PATH)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(VAULT_PATH, entry);
    if (!statSync(path).isFile()) continue;

    const { data } = matter(readFileSync(path, "utf8"));
    const tags = Array.isArray(data.tags) ? data.tags : [];
    if (tags.includes("scope")) {
      scopes.push(entry.replace(/\.md$/, ""));
    }
  }

  return scopes.sort();
}
