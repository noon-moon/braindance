// Any OpenAI-compatible endpoint: DigitalOcean Gradient, Groq, Fireworks,
// OpenAI itself, a local llama.cpp server, Ollama, vLLM.
//
// Native `fetch`, no SDK. The Anthropic client earns its dependency by carrying
// structured outputs, prompt caching and typed errors; this is one POST to
// `/v1/chat/completions`, and a second SDK to express that would be furniture.
//
// ── THE JSON LADDER ─────────────────────────────────────────────────────────
//
// Providers disagree about how to ask for JSON, and the disagreement is not
// cosmetic — asking the wrong way is frequently IGNORED rather than refused, so
// you get prose where you expected an object and no error to tell you why.
// Anthropic's own OpenAI-compatibility layer does exactly this: `response_format`
// is documented as "Ignored", and "most unsupported fields are silently ignored
// rather than producing errors".
//
// So the mode is chosen, never guessed:
//
//   json_schema   constrained decoding against the schema. Strict.
//   json_object   valid JSON, no schema. Loose.
//   tool_call     one forced function whose parameters ARE the schema. Loose,
//                 and the widest-supported — it is what to use against an
//                 endpoint that ignores `response_format`.
//
// `strictSchema` follows from the mode, and that is what stops portability from
// costing notes their lives: see the field's own comment in `harness.ts`.
import { record, type Usage } from "./usage.js";
import { TransientError, RefusalError, type Harness } from "./harness.js";
import { SUGGESTION_SCHEMA, validate, classifySystemPrompt, neutraliseFences,
         MAX_NOTE_CHARS, NOTE_OPEN, NOTE_CLOSE, type ScopeBlurb, type Suggestion } from "./suggest.js";
import { intentSystemPrompt, intentUserPrompt, ACTION_SCHEMA } from "./intent.js";
import { takenRootNames } from "./vault.js";
import type { Proposal } from "./approval.js";

export type JsonMode = "json_schema" | "json_object" | "tool_call";

const env = (k: string, fallback = ""): string => process.env[k]?.trim() || fallback;

/** HTTP status → the taxonomy. Cleaner than the subprocess floor, because status
 *  codes actually mean something across providers.
 *
 *  Every status is TRANSIENT, and that is not laziness. A 429 is load, a 5xx is
 *  theirs, and a 4xx is a request THIS BUILD builds wrongly for every note
 *  alike — a bad key, a model name that moved, a schema keyword the provider
 *  rejects. None of them is evidence about the note in hand, and treating a
 *  deployment mistake as the note's fault is what buries a queue permanently
 *  over a config typo. The only thing that blames a note is output that arrived
 *  and could not be used, which happens after this function returns. */
async function post(url: string, key: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    // A DNS failure, a refused connection, our own abort. No answer arrived.
    const why = (e as Error).name === "AbortError" ? `timed out after ${timeoutMs}ms` : (e as Error).message;
    throw new TransientError(`api call failed: ${why}`, null);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  if (!res.ok) {
    // `retry-after` is honoured by the caller's backoff rather than slept on
    // here: sleeping holds the pass open, and the pass is on a timer.
    throw new TransientError(`api ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A 200 that is not JSON is the transport lying, not the model — a gateway
    // error page, a truncated body. Nothing was said about the note.
    throw new TransientError(`api 200 with a non-JSON body: ${text.slice(0, 200)}`, 200);
  }
}

interface Choice {
  message?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }>; refusal?: string | null };
  finish_reason?: string;
}

/** Pull the model's JSON out of whichever shape the mode produced, and record
 *  what it cost. Real numbers — `usage.prompt_tokens` / `usage.completion_tokens`
 *  are part of the OpenAI response contract and every compatible provider
 *  returns them, so `estimateUsage` stays unused here. */
function extract(res: Record<string, unknown>, mode: JsonMode, label: string): unknown {
  const u = res.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  record(label, { input_tokens: u?.prompt_tokens ?? 0, output_tokens: u?.completion_tokens ?? 0 } as Usage);

  const choice = (res.choices as Choice[] | undefined)?.[0];
  if (!choice) throw new Error("no choices in response");
  // Checked BEFORE content, as in suggest.ts: a refused response can carry an
  // empty content and reading it would throw something that reads like a bug.
  if (choice.message?.refusal) throw new RefusalError(String(choice.message.refusal));
  if (choice.finish_reason === "length") throw new Error("response truncated at max_tokens");

  const raw = mode === "tool_call"
    ? choice.message?.tool_calls?.[0]?.function?.arguments
    : choice.message?.content;
  if (!raw) throw new Error(`no ${mode === "tool_call" ? "tool call" : "content"} in response`);
  return JSON.parse(raw); // throws on non-JSON — a failure, handled as one
}

/** Shape the request so the model is obliged to answer in `schema`. */
function askFor(mode: JsonMode, name: string, schema: unknown): Record<string, unknown> {
  if (mode === "json_schema") {
    return { response_format: { type: "json_schema", json_schema: { name, schema, strict: true } } };
  }
  if (mode === "json_object") return { response_format: { type: "json_object" } };
  return {
    tools: [{ type: "function", function: { name, description: `Return the ${name}.`, parameters: schema } }],
    tool_choice: { type: "function", function: { name } },
  };
}

export const openaiHarness = (): Harness => {
  const base = env("BD_BASE_URL").replace(/\/$/, "");
  const key = env(env("BD_API_KEY_ENV", "BD_API_KEY"));
  const model = env("BD_MODEL");
  const mode = (env("BD_JSON_MODE", "json_schema") as JsonMode);
  const timeoutMs = Number(env("BD_TIMEOUT_MS", "120000"));

  // Checked at construction, not at the first call, so a half-configured
  // deployment says so on the pass that tried rather than blaming a note.
  const missing = [!base && "BD_BASE_URL", !key && "an API key", !model && "BD_MODEL"].filter(Boolean);
  if (missing.length) throw new Error(`openai harness is not configured: missing ${missing.join(", ")}`);

  const call = async (system: string, user: string, schema: unknown, name: string, label: string): Promise<unknown> => {
    const res = await post(`${base}/chat/completions`, key, {
      model,
      max_tokens: 8192,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...askFor(mode, name, schema),
    }, timeoutMs);
    return extract(res, mode, label);
  };

  return {
    name: `openai:${model}`,
    // Only the schema mode constrains decoding. The other two ask nicely, and
    // asking nicely is not a guarantee.
    strictSchema: mode === "json_schema",

    async classify(noteText: string, scopes: ScopeBlurb[]): Promise<Suggestion> {
      // Fail CLOSED at the door, exactly as suggestFor does: an empty catalogue
      // is a live instruction not to send anything anywhere.
      if (!scopes.length) throw new Error("no ingestable scopes — nothing to classify against");
      const body = neutraliseFences(noteText).slice(0, MAX_NOTE_CHARS);
      const parsed = await call(
        classifySystemPrompt(scopes, new Date().toISOString().slice(0, 10)),
        `${NOTE_OPEN}\n${body}\n${NOTE_CLOSE}`,
        SUGGESTION_SCHEMA, "suggestion", "classify",
      );
      const s = validate(parsed, scopes.map((x) => x.name), takenRootNames());
      if (!s) throw new Error("model output failed validation");
      return s;
    },

    readIntent(reply: string, p: Proposal, liveScopes: string[], today: string): Promise<unknown> {
      return call(intentSystemPrompt(p, liveScopes, today), intentUserPrompt(reply), ACTION_SCHEMA, "intent", "intent");
    },
  };
};
