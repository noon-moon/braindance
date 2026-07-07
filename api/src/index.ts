import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createNote } from "./notes.js";
import { getScopes } from "./scopes.js";

const app = new Hono();

app.get("/scopes", (c) => c.json({ scopes: getScopes() }));

app.post("/notes", async (c) => {
  const body = await c.req.json<{ content?: string; scope?: string }>();
  if (!body.content || !body.scope) {
    return c.json({ error: "content and scope are required" }, 400);
  }

  const result = await createNote({ content: body.content, scope: body.scope });
  return c.json(result, 201);
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`braindance api listening on :${port}`);
