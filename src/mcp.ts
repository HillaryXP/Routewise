// Minimal MCP server (streamable HTTP, JSON responses only) exposing the Routewise tools.
// Hand-rolled JSON-RPC so it runs anywhere fetch-style handlers run (Node, Workers, Vercel).
import { z } from "zod/v4";
import { TOOLS } from "./tools.js";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const SERVER_INFO = { name: "routewise", version: "0.1.0" };
const PROTOCOL = "2025-06-18";

const toolList = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: z.toJSONSchema(t.schema as z.ZodType),
  annotations: { readOnlyHint: true, openWorldHint: true },
}));

const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const err = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleRpc(msg: Rpc): Promise<object | null> {
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Routewise finds the best way to cash out USDC into local currency (NGN, GHS, KES, ZAR, ARS, PHP, INR, BRL, MXN). Fees are estimates.",
      });
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: toolList });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return err(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      const parsed = (tool.schema as z.ZodType).safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) {
        return ok(msg.id, { isError: true, content: [{ type: "text", text: `Invalid input: ${parsed.error.message}` }] });
      }
      try {
        const data = await (tool.run as (i: unknown) => Promise<unknown>)(parsed.data);
        return ok(msg.id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        });
      } catch (e) {
        return ok(msg.id, { isError: true, content: [{ type: "text", text: (e as Error).message }] });
      }
    }
    default:
      // Notifications (no id) get no response.
      if (msg.id === undefined) return null;
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
