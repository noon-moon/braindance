// Commit captures directly to `main`, into ctx/vault/inbox/, via the GitHub
// REST Contents API. The admin app is Tailscale-only (no public exposure), so
// the old belt-and-suspenders `inbox` branch is retired: captures land on
// `main` and are visible in the vault immediately, then triaged into the flat
// vault at the desk.
//
// Robustness: every capture is a unique timestamped path, so the Contents API
// PUT never hits a same-file sha conflict; GitHub applies the commit on the
// current tip of `main` server-side (atomic ref update). A short retry loop
// absorbs the rare transient 409/422 when a sibling commit lands on `main`
// between GitHub reading the tip and updating the ref.
const GITHUB_API = "https://api.github.com";
const BRANCH = "main";
const MAX_RETRIES = 4;

interface NotePayload {
  content: string;
  scope: string;
}

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

export async function createNote({ content, scope }: NotePayload): Promise<{ path: string }> {
  const repo = process.env.GITHUB_REPO;
  if (!repo) throw new Error("GITHUB_REPO not set");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `ctx/vault/inbox/${timestamp}.md`;
  const body = `---\ntags:\n  - ${scope}\n---\n\n${content}\n`;
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`;
  const payload = JSON.stringify({
    message: `inbox: ${scope} capture`,
    content: Buffer.from(body, "utf8").toString("base64"),
    branch: BRANCH,
  });

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "PUT", headers: ghHeaders(), body: payload });
    if (res.ok) return { path };
    // 409 (ref moved under us) / 422 (stale) — a sibling commit raced ours.
    // Back off briefly and retry; GitHub re-applies on the new tip.
    if ((res.status === 409 || res.status === 422) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      continue;
    }
    throw new Error(`GitHub contents PUT ${path} failed: ${res.status} ${await res.text()}`);
  }
}
