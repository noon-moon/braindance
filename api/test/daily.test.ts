// Daily-note tests — the naming contract with Obsidian's Daily Notes plugin.
// Run: `npm run test:daily`.
//
// This module exists to agree with a plugin nobody here controls, and the whole
// value of it is that agreement: get the folder or the format wrong and the
// Today tab creates a SECOND note for a day that already had one, in a directory
// the user is also typing into. Nothing fails loudly when that happens — you
// find out days later, with the day's thinking split across two files. So the
// format subset is pinned token by token, the config reader is pinned on the
// defaults it falls back to (Obsidian's own, so an unconfigured vault still
// resolves to the file the plugin would make), and both path readers are pinned
// on refusing anything that could escape the vault.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolved at module load, so it is set before the import.
const VAULT = mkdtempSync(join(tmpdir(), "bd-daily-"));
process.env.VAULT_PATH = VAULT;

const {
  dailyConfig, invalidateDaily, formatDay, dailyName, dailyRel,
  readDaily, readDailyByName, dailyDateOf, dailyStarter, stripFrontmatter,
} = await import("../src/daily.js");

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
};

/** Rewrite the plugin config and drop the cache, as a settings change would. */
const configure = (cfg: unknown) => {
  mkdirSync(join(VAULT, ".obsidian"), { recursive: true });
  if (cfg === null) rmSync(join(VAULT, ".obsidian", "daily-notes.json"), { force: true });
  else writeFileSync(join(VAULT, ".obsidian", "daily-notes.json"), JSON.stringify(cfg));
  invalidateDaily();
};

console.log("test: formatDay — the moment.js subset");
{
  const D = "2026-08-22"; // a Saturday
  check("YYYY-MM-DD is the plugin default", formatDay(D, "YYYY-MM-DD") === "2026-08-22");
  check("[literal] escapes are emitted verbatim", formatDay(D, "[Daily-]YYYY-MM-DD") === "Daily-2026-08-22");
  check("a literal can hold token letters", formatDay(D, "[Day M D]-YYYY") === "Day M D-2026");
  check("longest token first — D never eats half of DD", formatDay(D, "DD/MM/YY") === "22/08/26");
  check("unpadded M and D", formatDay("2026-01-05", "M/D/YYYY") === "1/5/2026");
  check("month names", formatDay(D, "MMMM MMM") === "August Aug");
  check("weekday names", formatDay(D, "dddd ddd dd d") === "Saturday Sat Sa 6");
  check("ordinal day", formatDay(D, "Do") === "22nd");
  check("ordinal teens are th", formatDay("2026-08-11", "Do") === "11th");
  check("ordinals 1/2/3", ["2026-08-01", "2026-08-02", "2026-08-03"].map((d) => formatDay(d, "Do")).join(" ") === "1st 2nd 3rd");
  check("day of year", formatDay("2026-02-01", "DDD DDDD") === "32 032");
  check("clock tokens default to midnight", formatDay(D, "HH:mm:ss") === "00:00:00");
  check("clock tokens read the clock passed in", formatDay(D, "HH:mm A", { h: 14, m: 7, s: 0 }) === "14:07 PM");
  check("12-hour tokens", formatDay(D, "h:mm a", { h: 0, m: 5, s: 0 }) === "12:05 am");
  check("an unknown format is not a crash", typeof formatDay(D, "%Q!") === "string");
  check("a nonsense date falls back to itself", formatDay("not-a-date", "YYYY") === "not-a-date");
}

console.log("test: dailyConfig — the plugin's settings, or its defaults");
{
  configure(null);
  const d = dailyConfig();
  check("no config file ⇒ Obsidian's own defaults (root, YYYY-MM-DD, no template)",
    d.folder === "" && d.format === "YYYY-MM-DD" && d.template === "");

  configure({ folder: "daily/", format: "[Daily-]YYYY-MM-DD", template: "_templates/daily" });
  const c = dailyConfig();
  check("folder loses its trailing slash", c.folder === "daily");
  check("format is read as written", c.format === "[Daily-]YYYY-MM-DD");
  check("template is read as written", c.template === "_templates/daily");

  configure({ folder: "../../etc", format: "YYYY-MM-DD" });
  check("a folder that climbs out of the vault is refused, not followed", dailyConfig().folder === "");
  configure({ folder: "/srv/somewhere", format: "YYYY-MM-DD" });
  check("an absolute folder is taken as vault-relative", dailyConfig().folder === "srv/somewhere");
  configure({ folder: 7, format: "" });
  check("wrong types fall back rather than throw",
    dailyConfig().folder === "" && dailyConfig().format === "YYYY-MM-DD");
  writeFileSync(join(VAULT, ".obsidian", "daily-notes.json"), "{not json");
  invalidateDaily();
  check("unparseable config falls back rather than throw", dailyConfig().format === "YYYY-MM-DD");
}

console.log("test: naming and reading a day's note");
{
  configure({ folder: "daily/", format: "[Daily-]YYYY-MM-DD", template: "_templates/daily" });
  check("dailyName is the format applied to the day", dailyName("2026-08-22") === "Daily-2026-08-22");
  check("dailyRel joins the folder", dailyRel("2026-08-22") === "daily/Daily-2026-08-22.md");

  const absent = readDaily("2026-08-22");
  check("a day with no note reads as text:null, not an empty note", absent.text === null);
  check("…but still knows where it would go", absent.rel === "daily/Daily-2026-08-22.md");

  mkdirSync(join(VAULT, "daily"), { recursive: true });
  const raw = "---\ntags:\n  - daily\n---\n# Daily-2026-08-22\n\n## Log\nsomething\n";
  writeFileSync(join(VAULT, "daily", "Daily-2026-08-22.md"), raw);
  check("an existing note reads back byte-identical", readDaily("2026-08-22").text === raw);

  check("by name, inside the folder", readDailyByName("Daily-2026-08-22")?.text === raw);
  check("by name, the day comes back with it", readDailyByName("Daily-2026-08-22")?.iso === "2026-08-22");
  check("a name with a separator is refused", readDailyByName("../Loon") === null);
  check("a name that is a traversal is refused", readDailyByName("..") === null);
  check("a root note is not a daily note", readDailyByName("Loon") === null);

  configure({ folder: "", format: "YYYY-MM-DD" });
  check("root-folder vaults resolve at the root", dailyRel("2026-08-22") === "2026-08-22.md");
}

console.log("test: dailyDateOf — a name back to its day, or an honest null");
{
  configure({ folder: "daily/", format: "[Daily-]YYYY-MM-DD" });
  check("the round trip confirms the guess", dailyDateOf("Daily-2026-08-22") === "2026-08-22");
  check("a name the format wouldn't produce answers null", dailyDateOf("2026-08-22") === null);
  check("a name with no date in it answers null", dailyDateOf("Loon") === null);
  configure({ folder: "daily/", format: "YYYY-MM-DD" });
  check("plain format round-trips too", dailyDateOf("2026-08-22") === "2026-08-22");
}

console.log("test: dailyStarter — the template, filled the way Obsidian fills it");
{
  mkdirSync(join(VAULT, "_templates"), { recursive: true });
  writeFileSync(join(VAULT, "_templates", "daily.md"),
    "---\ntags:\n  - daily\n---\n# {{title}}\n\n{{date}} at {{time}}\n{{date:dddd}}\n");
  configure({ folder: "daily/", format: "[Daily-]YYYY-MM-DD", template: "_templates/daily" });
  const started = dailyStarter("2026-08-22", new Date(2026, 7, 22, 9, 41, 0));
  check("{{title}} is the note's own name", started.includes("# Daily-2026-08-22"));
  check("{{date}} defaults to YYYY-MM-DD", started.includes("2026-08-22 at"));
  check("{{time}} defaults to HH:mm and reads the clock", started.includes("at 09:41"));
  check("{{date:FMT}} takes a format", started.trimEnd().endsWith("Saturday"));
  check("the template's frontmatter comes through", started.startsWith("---\ntags:\n  - daily\n---"));

  configure({ folder: "daily/", format: "[Daily-]YYYY-MM-DD", template: "" });
  check("no template ⇒ the smallest real note, and NO invented frontmatter",
    dailyStarter("2026-08-22") === "# Daily-2026-08-22\n\n");
  configure({ folder: "daily/", format: "[Daily-]YYYY-MM-DD", template: "_templates/gone" });
  check("a configured-but-missing template degrades to the same",
    dailyStarter("2026-08-22") === "# Daily-2026-08-22\n\n");
}

console.log("test: stripFrontmatter");
{
  check("a leading block goes", stripFrontmatter("---\na: 1\n---\n# T\n") === "# T\n");
  check("a note with no frontmatter is its own body", stripFrontmatter("# T\n\nx\n") === "# T\n\nx\n");
  check("only the LEADING block goes", stripFrontmatter("---\na: 1\n---\nx\n---\ny\n") === "x\n---\ny\n");
  check("a lone rule is not frontmatter", stripFrontmatter("---\n") === "---\n");
}

console.log(`\n${passed} checks passed`);
