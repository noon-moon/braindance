// The Anthropic implementation of `Harness` — and, for now, the only one.
//
// It is deliberately thin: `suggestFor` and `intentOf` already had exactly the
// right shape, so this adapts rather than reimplements. That thinness is the
// evidence the seam is in the right place. If a second implementation needs
// something this one does not expose, the interface is wrong, not the harness.
import { suggestFor, type ScopeBlurb, type Suggestion } from "./suggest.js";
import { intentOf } from "./intent.js";
import type { Proposal } from "./approval.js";
import type { Harness } from "./harness.js";

export const anthropicHarness = (): Harness => ({
  name: "anthropic",
  // Structured outputs, so the schema is enforced by constrained decoding rather
  // than asked for politely — see `output_config.format` in suggest.ts.
  strictSchema: true,
  classify: (noteText: string, scopes: ScopeBlurb[]): Promise<Suggestion> => suggestFor(noteText, scopes),
  readIntent: (reply: string, p: Proposal, liveScopes: string[], today: string): Promise<unknown> =>
    intentOf(reply, p, liveScopes, today),
});
