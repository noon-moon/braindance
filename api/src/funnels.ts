// Declarative capture funnels. Each is one spec: the server renders its form and
// build()s a vault-correct note (frontmatter + scoping links). Everything lands on
// the `inbox` branch for desk triage — the phone never writes `main`.
// See [[Braindance Admin App]] "Workflow 1 — Note ingest".

export interface Field {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "scope" | "date" | "url" | "number";
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

export interface BuiltNote {
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface Funnel {
  id: string;
  label: string;
  hint: string;
  fields: Field[];
  build(input: Record<string, string>): BuiltNote;
}

const yaml = (fm: Record<string, unknown>): string => {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === "" || v === null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
};

export const compose = (n: BuiltNote): string =>
  `${yaml(n.frontmatter)}\n\n${n.body.trim()}\n`;

const MEDIA_SCOPE: Record<string, string> = {
  Game: "Video Games",
  Book: "Books",
  Music: "Music",
  Film: "Film",
};

export const FUNNELS: Funnel[] = [
  {
    id: "memo",
    label: "Memo",
    hint: "an unaffiliated thought → inbox",
    fields: [
      { key: "title", label: "title", type: "text" },
      { key: "body", label: "body", type: "textarea", required: true },
    ],
    build: (i) => ({
      title: i.title || "memo",
      frontmatter: { tags: ["memo"] },
      body: `# ${i.title || "memo"}\n\n${i.body}`,
    }),
  },
  {
    id: "todo",
    label: "TODO",
    hint: "a task with status + due",
    fields: [
      { key: "title", label: "title", type: "text", required: true },
      { key: "body", label: "detail", type: "textarea" },
      { key: "status", label: "status", type: "select", options: ["open", "in-progress"] },
      { key: "due", label: "due", type: "date" },
      { key: "scope", label: "scope", type: "scope" },
    ],
    build: (i) => ({
      title: i.title,
      frontmatter: { tags: ["memo", "todo"], status: i.status || "open", due: i.due || undefined },
      body: `${i.scope ? `Tags: [[${i.scope}]]\n` : ""}# ${i.title}\n\n${i.body || ""}`,
    }),
  },
  {
    id: "media",
    label: "Media",
    hint: "a game / book / album / film to check out",
    fields: [
      { key: "kind", label: "kind", type: "select", required: true, options: ["Game", "Book", "Music", "Film"] },
      { key: "title", label: "title", type: "text", required: true },
      { key: "creator", label: "creator", type: "text", placeholder: "author / director / artist / studio" },
      { key: "url", label: "url", type: "url" },
      { key: "why", label: "why", type: "textarea" },
      { key: "status", label: "status", type: "select", options: ["want", "consuming", "done"] },
    ],
    build: (i) => ({
      title: i.title,
      frontmatter: { tags: ["memo"], kind: i.kind, status: i.status || "want", url: i.url || undefined },
      body:
        `Tags: [[${MEDIA_SCOPE[i.kind] ?? "Media"}]]\n# ${i.title}\n\n` +
        `${i.creator ? `*${i.creator}*\n\n` : ""}${i.why || ""}`,
    }),
  },
  {
    id: "resource",
    label: "Resource",
    hint: "a standing go-to for an activity",
    fields: [
      { key: "title", label: "title", type: "text", required: true },
      { key: "activity", label: "activity", type: "scope", required: true },
      { key: "url", label: "url", type: "url" },
      { key: "note", label: "what it's for", type: "textarea" },
    ],
    build: (i) => ({
      title: i.title,
      frontmatter: { tags: ["memo", "reference"], url: i.url || undefined },
      body: `Tags: [[${i.activity}]]\n# ${i.title}\n\n${i.note || ""}`,
    }),
  },
];

export const funnelById = (id: string): Funnel | undefined => FUNNELS.find((f) => f.id === id);
