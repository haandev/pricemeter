/**
 * The messaging catalog (Cellonay-style OTP + WhatsApp), shared by the Worker and the account Durable Object.
 * No adapters here: the Worker binds `getRate` + `commit`, the DO uses the catalog only for `price()`.
 */
import { buildMetering } from "pricemeter";
import { z } from "zod";

export const Context = z.object({
  accountId: z.string(),
  plan: z.enum(["free", "pro", "enterprise"]),
});
export type Context = z.infer<typeof Context>;

const country = z.string().length(2);

export const catalog = buildMetering()
  .context(Context)
  .refs(["otp_send", "wa_window", "month"])
  // pool first: every message, whatever the channel, counts toward the monthly free platform quota
  .meter("msg/free_pool")
  .meter("otp/sms", { country }, { feeds: { "msg/free_pool": 1 } })
  .meter("otp/whatsapp", { country }, { feeds: { "msg/free_pool": 1 } })
  .meter("otp/verify")
  .meter("wa/window", { country })
  .meter("ip/dedicated");

export type Catalog = typeof catalog;
