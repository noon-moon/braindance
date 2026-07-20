// Proposal store (v2 Slice 4 — data plane).
//
// Agents don't write the vault directly; they submit self-contained PROPOSAL
// artifacts that surface in the admin-app review queue, where the user approves
// / edits / sends them back. This module is the persistence + validation for
// those artifacts. Applying an approved proposal (adapter.commit) and the review
// UI are the next increments (B1b).
//
// Proposals are api-owned control-plane state, NOT vault content — stored as JSON
// OUTSIDE the vault checkout (PROPOSALS_DIR) so they're never captured/synced.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { REPO_PATH } from "./config.js";
import type { ChangeOp } from "./adapter.js";

export type ProposalStatus = "pending" | "approved" | "rejected" | "returned";

export interface Proposal {
  id: string;
  createdAt: string; // ISO-8601
  status: ProposalStatus;
  /** What the operation is / why — human-facing, shown in the queue. */
  intent: string;
  /** Deeper reasoning — the load-bearing field for a good re-seeded follow-up. */
  rationale?: string;
  /** The proposed file operations (applied atomically as one op on approval). */
  changeset: ChangeOp[];
  /** Notes/paths the follow-up agent should re-read. */
  contextPointers?: string[];
  /** The operation id this builds on, if any. */
  parentOp?: string;
  /** Set when the user sends the proposal back for revision. */
  feedback?: string;
}

export interface ProposalInput {
  intent: string;
  changeset: ChangeOp[];
  rationale?: string;
  contextPointers?: string[];
  parentOp?: string;
}

// Outside the vault checkout by default, so proposals are never committed/synced.
const DIR = process.env.PROPOSALS_DIR ?? join(REPO_PATH, "..", "braindance-proposals");
const pathFor = (id: string): string => join(DIR, `${id}.json`);

/** Validate + persist a new pending proposal. Path/content safety is enforced
 *  again at apply time by the adapter; this catches shape errors early. */
export async function submitProposal(input: ProposalInput): Promise<Proposal> {
  if (!input?.intent?.trim()) throw new Error("proposal.intent is required");
  if (!Array.isArray(input.changeset) || input.changeset.length === 0) {
    throw new Error("proposal.changeset must be a non-empty array");
  }
  // Validate against untrusted JSON — treat each op as a loose record so the
  // checks are runtime-real (not just type-level narrowing).
  for (const raw of input.changeset as unknown[]) {
    const op = (raw ?? {}) as { op?: unknown; path?: unknown; content?: unknown };
    if (op.op !== "put" && op.op !== "delete") throw new Error(`invalid changeset op: ${JSON.stringify(op.op)}`);
    if (typeof op.path !== "string" || !op.path) throw new Error("each changeset op needs a non-empty path");
    if (op.op === "put" && typeof op.content !== "string") throw new Error(`put op for ${op.path} needs string content`);
  }
  const proposal: Proposal = {
    id: `prop_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    status: "pending",
    intent: input.intent.trim(),
    rationale: input.rationale,
    changeset: input.changeset,
    contextPointers: input.contextPointers,
    parentOp: input.parentOp,
  };
  await mkdir(DIR, { recursive: true });
  await writeFile(pathFor(proposal.id), JSON.stringify(proposal, null, 2), "utf8");
  return proposal;
}

export async function getProposal(id: string): Promise<Proposal | null> {
  try {
    return JSON.parse(await readFile(pathFor(id), "utf8")) as Proposal;
  } catch {
    return null;
  }
}

/** All proposals (optionally filtered by status), newest-first. */
export async function listProposals(status?: ProposalStatus): Promise<Proposal[]> {
  let files: string[];
  try {
    files = await readdir(DIR);
  } catch {
    return []; // dir not created yet ⇒ no proposals
  }
  const out: Proposal[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(await readFile(join(DIR, f), "utf8")) as Proposal;
      if (!status || p.status === status) out.push(p);
    } catch {
      /* skip a corrupt file rather than fail the whole list */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function setStatus(id: string, status: ProposalStatus): Promise<Proposal | null> {
  const p = await getProposal(id);
  if (!p) return null;
  p.status = status;
  await writeFile(pathFor(id), JSON.stringify(p, null, 2), "utf8");
  return p;
}

/** Merge a partial patch into a stored proposal (intent / changeset / status /
 *  feedback). Returns the updated proposal, or null if it doesn't exist. */
export async function updateProposal(
  id: string,
  patch: Partial<Pick<Proposal, "intent" | "changeset" | "status" | "feedback">>,
): Promise<Proposal | null> {
  const p = await getProposal(id);
  if (!p) return null;
  const updated: Proposal = { ...p, ...patch };
  await writeFile(pathFor(id), JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

export async function removeProposal(id: string): Promise<void> {
  await unlink(pathFor(id)).catch(() => undefined);
}
