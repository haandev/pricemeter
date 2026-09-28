/** Cloudflare Worker entry: HTTP → app, queue consumer for late window prices, monthly cron. */
import type { PriceVersion } from "pricemeter/rates";
import { createApp, type OtpRecord, type WindowMessage } from "./app.js";
import type { AccountDO } from "./do.js";
import { PRICE_ROWS, type RouteCost } from "./prices.js";

export { AccountDO } from "./do.js";

export interface Env {
  ACCOUNT: DurableObjectNamespace<AccountDO>;
  DB: D1Database;
  OTPS: KVNamespace;
  WINDOWS: Queue<WindowMessage>;
  SANDBOX_ACCOUNTS?: string;
  /** "1" enables POST /dev/credit (set in .dev.vars for `wrangler dev`; never in production). */
  DEV_CREDIT?: string;
}

function app(env: Env) {
  return createApp({
    account: (id) => env.ACCOUNT.get(env.ACCOUNT.idFromName(id)) as never,
    // In production: D1 rows cached per isolate. The shipped table keeps the example self-contained.
    priceRows: async () => PRICE_ROWS as readonly PriceVersion[],
    routes: async () => ((await env.OTPS.get("routes", "json")) as RouteCost[] | null) ?? [],
    otps: {
      get: async (id) => (await env.OTPS.get(`otp:${id}`, "json")) as OtpRecord | undefined,
      put: (r) => env.OTPS.put(`otp:${r.id}`, JSON.stringify(r), { expirationTtl: 86_400 }),
      delete: (id) => env.OTPS.delete(`otp:${id}`),
    },
    windowQueue: {
      send: async (m) => {
        await env.WINDOWS.send(m, { delaySeconds: 3600 });
      },
    },
    sandbox: new Set((env.SANDBOX_ACCOUNTS ?? "").split(",").filter(Boolean)),
  });
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const a = app(env);
    const url = new URL(req.url);
    const body = (req.method === "POST" ? await req.json() : {}) as any;
    const at = Date.now();
    switch (`${req.method} ${url.pathname}`) {
      case "POST /otp/send":
        return reply(await a.sendOtp({ ...body, at }));
      case "POST /otp/resend":
        return reply(await a.resendOtp({ ...body, at }));
      case "POST /otp/verify":
        return reply(await a.verifyOtp({ ...body, at }));
      case "POST /wa/window/close":
        return reply(await a.closeWindow({ ...body, at }));
      case "POST /dev/credit": {
        if (env.DEV_CREDIT !== "1") return json({ error: "not_found" }, 404);
        const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(body.accountId));
        await stub.credit(body.amountMicroUsd);
        return json(await stub.state());
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  },

  async queue(batch: MessageBatch<WindowMessage>, env: Env) {
    const a = app(env);
    for (const msg of batch.messages) {
      const r = await a.closeWindow(msg.body); // re-queues itself if the price is still missing
      if (r.ok || r.reason === "no_price") msg.ack();
      else msg.retry();
    }
  },

  async scheduled(_event: ScheduledController, env: Env) {
    // Accounts with a dedicated IP; in production a D1 query.
    const accounts = ((await env.OTPS.get("dedicated-ip-accounts", "json")) as { accountId: string; plan: "free" | "pro" | "enterprise" }[] | null) ?? [];
    const a = app(env);
    for (const ctx of accounts) await a.monthlyFees({ ctx, at: Date.now() });
  },
} satisfies ExportedHandler<Env, WindowMessage>;

/** HTTP mapping of results: the status code is the app's decision, not the library's. */
function reply(r: { ok: boolean; reason?: string }) {
  if (r.ok) return json(r);
  const status = r.reason === "insufficient_credit" ? 402 : r.reason === "no_price" ? 422 : r.reason === "unknown_otp" ? 404 : 400;
  return json(r, status);
}
