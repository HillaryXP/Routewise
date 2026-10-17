import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { handleRpc } from "./mcp.js";
import { CURRENCIES } from "./data.js";
import { rates, route, timing, ratesInput, routeInput, timingInput } from "./tools.js";

const app = new Hono();
app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));

// ---- x402 paywall (config via env) ------------------------------------------------------------
const PAY_TO_SOL = process.env.PAY_TO_SOL; // Solana address that receives USDC
const PAY_TO_EVM = process.env.PAY_TO_EVM; // optional EVM address (Base)
const SOL_NETWORK = process.env.X402_SOL_NETWORK ?? "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // devnet by default
const EVM_NETWORK = process.env.X402_EVM_NETWORK ?? "eip155:84532"; // Base Sepolia by default
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const PRICES = {
  rates: process.env.PRICE_RATES ?? "$0.005",
  route: process.env.PRICE_ROUTE ?? "$0.01",
  timing: process.env.PRICE_TIMING ?? "$0.01",
};

const accepts = (price: string) => [
  ...(PAY_TO_SOL ? [{ scheme: "exact" as const, price, network: SOL_NETWORK as `${string}:${string}`, payTo: PAY_TO_SOL }] : []),
  ...(PAY_TO_EVM ? [{ scheme: "exact" as const, price, network: EVM_NETWORK as `${string}:${string}`, payTo: PAY_TO_EVM }] : []),
];

const paywallEnabled = Boolean(PAY_TO_SOL || PAY_TO_EVM);
if (paywallEnabled) {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator);
  if (PAY_TO_SOL) server.register(SOL_NETWORK as `${string}:${string}`, new ExactSvmScheme());
  if (PAY_TO_EVM) server.register(EVM_NETWORK as `${string}:${string}`, new ExactEvmScheme());
  app.use(
    paymentMiddleware(
      {
        "GET /v1/rates": { accepts: accepts(PRICES.rates), description: "Routewise: official vs street rate and spread", mimeType: "application/json" },
        "GET /v1/route": { accepts: accepts(PRICES.route), description: "Routewise: ranked cash-out routes by net amount received", mimeType: "application/json" },
        "GET /v1/timing": { accepts: accepts(PRICES.timing), description: "Routewise: convert now or wait?", mimeType: "application/json" },
      },
      server,
    ),
  );
} else {
  console.warn("[routewise] PAY_TO_SOL / PAY_TO_EVM not set: x402 paywall DISABLED (dev mode). Endpoints are free.");
}

// ---- paid REST endpoints ----------------------------------------------------------------------
const bad = (c: any, issues: unknown) => c.json({ error: "invalid_input", issues }, 400);

app.get("/v1/rates", async (c) => {
  const p = ratesInput.safeParse({ currency: c.req.query("currency")?.toUpperCase() });
  if (!p.success) return bad(c, p.error.issues);
  try { return c.json(await rates(p.data)); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});

app.get("/v1/route", async (c) => {
  const p = routeInput.safeParse({ currency: c.req.query("currency")?.toUpperCase(), amount_usd: Number(c.req.query("amount_usd")) });
  if (!p.success) return bad(c, p.error.issues);
  try { return c.json(await route(p.data)); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});

app.get("/v1/timing", async (c) => {
  const p = timingInput.safeParse({ currency: c.req.query("currency")?.toUpperCase() });
  if (!p.success) return bad(c, p.error.issues);
  try { return c.json(await timing(p.data)); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});

// ---- MCP endpoint -----------------------------------------------------------------------------
app.post("/mcp", async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handleRpc))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handleRpc(body);
  return out ? c.json(out) : c.body(null, 202);
});
app.get("/mcp", (c) => c.json({ error: "Use POST for MCP over streamable HTTP" }, 405));

// ---- meta -------------------------------------------------------------------------------------
app.get("/health", (c) => c.json({ ok: true, paywall: paywallEnabled }));
app.get("/", (c) =>
  c.json({
    name: "Routewise",
    tagline: "Know the rate you'll actually get. Best way to cash out USDC into local currency.",
    currencies: CURRENCIES,
    paywall: paywallEnabled,
    endpoints: {
      "GET /v1/rates?currency=NGN": PRICES.rates,
      "GET /v1/route?currency=NGN&amount_usd=200": PRICES.route,
      "GET /v1/timing?currency=NGN": PRICES.timing,
      "POST /mcp": "MCP (streamable HTTP): routewise_rates, routewise_route, routewise_timing",
    },
  }),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`[routewise] listening on :${port} (paywall ${paywallEnabled ? "ON" : "OFF"})`));
export default app;
