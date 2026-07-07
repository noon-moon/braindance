const GITHUB_API = "https://api.github.com";

interface NotePayload {
  content: string;
  scope: string;
}

async function githubRequest(path: string, init?: RequestInit): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");

  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub API ${path} failed: ${res.status} ${await res.text()}`);
  }

  return res;
}

async function ensureInboxBranch(repo: string): Promise<void> {
  const existing = await githubRequest(`/repos/${repo}/git/ref/heads/inbox`);
  if (existing.status !== 404) return;

  const mainRef = await githubRequest(`/repos/${repo}/git/ref/heads/main`);
  const { object } = await mainRef.json();

  await githubRequest(`/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: "refs/heads/inbox", sha: object.sha }),
  });
}

export async function createNote({ content, scope }: NotePayload): Promise<{ path: string }> {
  const repo = process.env.GITHUB_REPO;
  if (!repo) throw new Error("GITHUB_REPO not set");

  await ensureInboxBranch(repo);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `ctx/vault/inbox/${timestamp}.md`;
  const body = `---\ntags:\n  - ${scope}\n---\n\n${content}\n`;

  await githubRequest(`/repos/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `inbox: ${scope} capture`,
      content: Buffer.from(body, "utf8").toString("base64"),
      branch: "inbox",
    }),
  });

  return { path };
}
