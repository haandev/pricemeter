/**
 * The Worker's application logic: OTP send / resend / verify / expire, WhatsApp windows, monthly fees.
 * Dependencies are injected so the same code runs on Cloudflare (`worker.ts`) and in tests.
 */
import type { Hold, Rate } from "pricemeter";
import { monthKey } from "pricemeter/calendar";
import { doCommit } from "pricemeter/cloudflare";
import type { PriceVersion } from "pricemeter/rates";
import type { AccountApi } from "./account.js";
import { catalog, type Context } from "./catalog.js";
import { findRate, type RouteCost } from "./prices.js";

export interface OtpRecord {
  id: string;
  ctx: Context;
  channel: "sms" | "whatsapp";
  country: string;
  /** The hold is a value: it lives on the OTP record, the library never reads the ledger. */
  hold: Hold;
  sends: number;
}

export interface WindowMessage {
  ctx: Context;
  windowId: string;
  country: string;
  at: number;
}

export interface Deps {
  account(accountId: string): AccountApi;
  priceRows(): Promise<readonly PriceVersion[]>;
  routes(): Promise<readonly RouteCost[]>;
  otps: { get(id: string): Promise<OtpRecord | undefined>; put(r: OtpRecord): Promise<void>; delete(id: string): Promise<void> };
  windowQueue: { send(m: WindowMessage): Promise<void> };
  /** Sandbox accounts are never metered. */
  sandbox?: ReadonlySet<string>;
}

const SEGMENT_CHARS = 160;
const segments = (text: string) => Math.max(1, Math.ceil(text.length / SEGMENT_CHARS));

export function createApp(deps: Deps) {
  // bind() returns a bound copy; the shared catalog (also used by the DO) stays adapter-free
  const metering = catalog.bind({
    getRate: async (meter, dims, ctx, at) => {
      const rate: Rate | null = findRate({ rows: await deps.priceRows(), routes: await deps.routes(), meter, dims, ctx, at });
      if (!rate) return null;
      const multiTier = rate.tiers.length > 1 || rate.tiers.some((t) => t.flatMicroUsd);
      return multiTier ? { rate, usedSoFar: await deps.account(ctx.accountId).used(meter, monthKey({ at })) } : { rate };
    },
    commit: doCommit((id) => deps.account(id)),
  });

  const sandboxed = (ctx: Context) => deps.sandbox?.has(ctx.accountId) ?? false;

  return {
    metering,

    /** Send: reserve the message segments and one verification in a single two-line hold. */
    async sendOtp(i: { id: string; ctx: Context; channel: "sms" | "whatsapp"; country: string; text: string; at: number }) {
      if (sandboxed(i.ctx)) return { ok: true as const, sandbox: true };
      const meter = i.channel === "sms" ? "otp/sms" : "otp/whatsapp";
      const h = await metering.hold(
        [
          { meter, dims: { country: i.country }, quantity: segments(i.text) },
          { meter: "otp/verify", quantity: 1 },
        ],
        { type: "otp_send", id: i.id },
        i.ctx,
        { at: i.at },
      );
      if (!h.ok) return h;
      await deps.otps.put({ id: i.id, ctx: i.ctx, channel: i.channel, country: i.country, hold: h.hold, sends: 1 });
      return h;
    },

    /** Resend: grow the same hold. */
    async resendOtp(i: { id: string; text: string; at: number }) {
      const otp = await deps.otps.get(i.id);
      if (!otp) return { ok: false as const, reason: "unknown_otp" };
      const meter = otp.channel === "sms" ? "otp/sms" : "otp/whatsapp";
      const e = await metering.extend(otp.hold, [{ meter, dims: { country: otp.country }, quantity: segments(i.text) }], otp.ctx, { at: i.at });
      if (e.ok) await deps.otps.put({ ...otp, hold: e.hold, sends: otp.sends + 1 });
      return e;
    },

    /** Verified: capture what was actually sent plus the verification, release the rest. */
    async verifyOtp(i: { id: string; delivered: number; at: number }) {
      const otp = await deps.otps.get(i.id);
      if (!otp) return { ok: false as const, reason: "unknown_otp" };
      const meter = otp.channel === "sms" ? "otp/sms" : "otp/whatsapp";
      const c = await metering.capture(
        otp.hold,
        [
          { meter, quantity: i.delivered },
          { meter: "otp/verify", quantity: 1 },
        ],
        otp.ctx,
        { at: i.at },
      );
      if (!c.ok) return c;
      const r = await metering.release(c.hold, otp.ctx, { at: i.at });
      if (r.ok) await deps.otps.delete(i.id);
      return { ...c, released: r.ok };
    },

    /** Never verified (cron): charge delivered segments, no verification fee, release the reservation. */
    async expireOtp(i: { id: string; delivered: number; at: number }) {
      const otp = await deps.otps.get(i.id);
      if (!otp) return { ok: false as const, reason: "unknown_otp" };
      const meter = otp.channel === "sms" ? "otp/sms" : "otp/whatsapp";
      const c = await metering.capture(otp.hold, [{ meter, quantity: i.delivered }], otp.ctx, { at: i.at });
      if (!c.ok) return c;
      const r = await metering.release(c.hold, otp.ctx, { at: i.at });
      if (r.ok) await deps.otps.delete(i.id);
      return r;
    },

    /**
     * A WhatsApp conversation window closed. Embedded mode: the Worker plans with its view, the account DO
     * re-prices with its own counters and applies. If the country's price isn't published yet, queue it:
     * the retry uses the original `at`.
     */
    async closeWindow(m: WindowMessage) {
      if (sandboxed(m.ctx)) return { ok: true as const, sandbox: true };
      const planned = await metering.plan.observe("wa/window", { country: m.country }, 1, { type: "wa_window", id: m.windowId }, m.ctx, { at: m.at });
      if (!planned.result.ok) {
        if (planned.result.reason === "no_price") await deps.windowQueue.send(m);
        return planned.result;
      }
      return deps.account(m.ctx.accountId).observeEmbedded(planned.lines, { type: "wa_window", id: m.windowId }, m.ctx);
    },

    /** Monthly cron: dedicated IP fee. The flat fee lands once per month however often this runs. */
    async monthlyFees(i: { ctx: Context; at: number }) {
      return metering.observe("ip/dedicated", {}, 1, { type: "month", id: `${i.ctx.accountId}:${monthKey({ at: i.at })}` }, i.ctx, { at: i.at });
    },
  };
}

export type App = ReturnType<typeof createApp>;
