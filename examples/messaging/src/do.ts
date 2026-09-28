/** The Durable Object Cloudflare instantiates: one per account, a thin wrapper over AccountCore. */
import { DurableObject } from "cloudflare:workers";
import type { Plan, PricedLine, Ref } from "pricemeter";
import { d1UsageSink } from "pricemeter/cloudflare";
import { AccountCore } from "./account.js";
import type { Context } from "./catalog.js";
import type { Env } from "./worker.js";

export class AccountDO extends DurableObject<Env> {
  #core: AccountCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = new AccountCore(ctx.storage, d1UsageSink(env.DB));
  }

  commit(plan: Plan) {
    const reply = this.#core.commit(plan);
    // ship usage to D1 after the response; retries are idempotent
    this.ctx.waitUntil(this.#core.flush());
    return reply;
  }
  used(meter: string, period: string) {
    return this.#core.used(meter, period);
  }
  observeEmbedded(lines: PricedLine[], ref: Ref, ctx: Context) {
    const r = this.#core.observeEmbedded(lines, ref, ctx);
    this.ctx.waitUntil(this.#core.flush());
    return r;
  }
  credit(amountMicroUsd: number) {
    return this.#core.credit(amountMicroUsd);
  }
  state() {
    return this.#core.state();
  }
}
