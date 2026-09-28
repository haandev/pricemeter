import { isInsufficientCredit } from "./errors.js";
import {
  planCapture,
  planExtend,
  planHold,
  planRelease,
  unwrapHold,
  type CaptureResult,
  type HoldLike,
  type HoldPlanned,
  type HoldResult,
  type PricedHoldLine,
} from "./hold.js";
import { fail, type Failure, type Plan, type Ref, type Result } from "./plan.js";
import { lineKey, price as corePrice, type Dims, type PriceOptions, type Priced, type PricedLine } from "./price.js";
import { FREE_RATE, validateRate, type Rate, type RateValidation, type ValidRate } from "./rate.js";
import { isStandardSchema, isTyped, runSchema, type StandardSchemaV1, type Typed } from "./standard-schema.js";
import { poolQuantity } from "./util.js";

// ---------------------------------------------------------------------------
// Types

/** How a meter declares its dimensions. */
export type DimsSpec =
  | readonly string[]
  | { readonly [key: string]: StandardSchemaV1 }
  | StandardSchemaV1<any, Record<string, unknown>>
  | Typed<Record<string, unknown>>;

/** The dimension type a spec produces. */
export type DimsFromSpec<S> = S extends Typed<infer T>
  ? T
  : S extends StandardSchemaV1<any, infer O>
    ? O
    : S extends readonly (infer K extends string)[]
      ? { -readonly [P in K]: any }
      : S extends { readonly [key: string]: StandardSchemaV1 }
        ? { -readonly [P in keyof S]: StandardSchemaV1.InferOutput<S[P]> }
        : never;

/** One meter in the catalog's type: its id, dimension type and whether it can be a pool. */
export interface MeterEntry<Id extends string = string, D = unknown, P extends boolean = boolean> {
  id: Id;
  dims: D;
  /** Can be a `feeds` target: declared without dims and without feeds. */
  pool: P;
}

export interface BaseContext {
  accountId: string;
}

/**
 * The catalog's type-level state. `meters` is a union of `MeterEntry` interfaces.
 *
 * Large catalogs (hundreds of chained `.meter()` calls) stay cheap for `tsc` because each step's state is
 * written out as a plain `MeteringState<…>` reference in `meter()`'s return type. Do not wrap it in a type alias:
 * an alias keeps the previous state as an alias type argument, TypeScript re-instantiates that chain
 * recursively, and the checker hits its instantiation depth limit at ~100 meters.
 */
export interface CatalogState {
  ctx: BaseContext;
  ref: string;
  meters: MeterEntry;
  /** Ids that can be `feeds` targets, kept incrementally (deriving them from `meters` is quadratic). */
  pools: string;
  rate: boolean;
  commit: boolean;
}

export interface InitialState {
  ctx: BaseContext;
  ref: string;
  meters: never;
  pools: never;
  rate: false;
  commit: false;
}

export interface MeteringState<C extends BaseContext, R extends string, M extends MeterEntry, P extends string, Rt extends boolean, Cm extends boolean> {
  ctx: C;
  ref: R;
  meters: M;
  pools: P;
  rate: Rt;
  commit: Cm;
}
type With<S extends CatalogState, K extends "ctx" | "ref" | "rate" | "commit", V> = MeteringState<
  K extends "ctx" ? Extract<V, BaseContext> : S["ctx"],
  K extends "ref" ? Extract<V, string> : S["ref"],
  S["meters"],
  S["pools"],
  K extends "rate" ? Extract<V, boolean> : S["rate"],
  K extends "commit" ? Extract<V, boolean> : S["commit"]
>;

type IsEmpty<D> = [keyof D] extends [never] ? true : false;

export type MeterId<S extends CatalogState> = S["meters"]["id"];
export type DimsOf<S extends CatalogState, K extends MeterId<S>> = Extract<S["meters"], { id: K }>["dims"];
export type PoolId<S extends CatalogState> = S["pools"];

export type FeedWeight<D, C> = number | ((dims: D, ctx: C) => number);
/** Pools this meter may feed. With no pool declared yet, nothing is accepted (`{}` would skip excess-property checks). */
export type FeedsOf<S extends CatalogState, D> = [PoolId<S>] extends [never]
  ? { [key: string]: never }
  : { [P in PoolId<S>]?: FeedWeight<D, S["ctx"]> };

type DimsField<D> = IsEmpty<D> extends true ? { dims?: D } : { dims: D };

/** An observation line, discriminated by meter. */
export type LineOf<S extends CatalogState> =
  S["meters"] extends infer E ? (E extends MeterEntry ? { meter: E["id"]; quantity: number } & DimsField<E["dims"]> : never) : never;

export type CaptureLineOf<S extends CatalogState> =
  S["meters"] extends infer E ? (E extends MeterEntry ? { meter: E["id"]; quantity: number; dims?: E["dims"] } : never) : never;

export type PricedLineOf<S extends CatalogState> =
  S["meters"] extends infer E ? (E extends MeterEntry ? PricedLine<E["id"], E["dims"]> : never) : never;

export type RefOf<S extends CatalogState> = Ref<S["ref"]>;

export interface RateAnswer {
  /** The tariff in force: every tier. `rate()` decides which tier a line lands in. */
  rate: Rate | ValidRate;
  /** Units already used in the tier period. Required for tiered, flat, volume and package rates. */
  usedSoFar?: number;
  carry?: number;
}
type RateArgs<S extends CatalogState> =
  S["meters"] extends infer E ? (E extends MeterEntry ? [meter: E["id"], dims: E["dims"], ctx: S["ctx"], at: number] : never) : never;
type Awaitable<T> = T | Promise<T>;
/**
 * `(meter, dims, ctx, at) => { rate, usedSoFar? } | null`. `dims` narrows on `meter`.
 * Declare all four parameters (prefix unused ones with `_`): TypeScript only accepts a callback for a
 * union of argument tuples when it lists every element.
 */
export type GetRate<S extends CatalogState> = (...args: RateArgs<S>) => Awaitable<RateAnswer | null | undefined>;
export type Commit = (plan: Plan) => Awaitable<void>;

export interface ObserveOptions<U> {
  /** Observation time, passed to `getRate` and written on rows. Default `Date.now()`. */
  at?: number;
  /** Overrides `getRate`'s `usedSoFar`. */
  usedSoFar?: U;
  /** When `getRate` returns null: `reject` (write nothing, `no_price`) or `free` (count at 0). Default `reject`. */
  ifMissing?: "reject" | "free";
  /** `false` skips pool expansion. Default `true`. */
  feeds?: boolean;
}

export interface CaptureOptions {
  at?: number;
  /** Price the capture with this tariff (one for all lines, or per meter) instead of the one stored in the hold. */
  rate?: Rate | Record<string, Rate>;
}

export type CommitResult = { ok: true } | Failure;

export interface Planned<R> {
  result: R;
  plan: Plan;
  /** The resolved, priced lines (pool lines included). Re-price them with `metering.price()`, e.g. inside a Durable Object. */
  lines: PricedLine[];
}

export interface MeterInfo {
  dims: string[];
  feeds: string[];
}

export interface ContextOptions {
  /** `always` (default) validates the context on every bound call; `never` skips it. */
  validate?: "always" | "never";
}

export interface MeteringPriceOptions<S extends CatalogState> extends PriceOptions {
  /** Tariffs for pool lines `feeds` should add. Without them, missing pool lines throw. */
  pools?: { [P in PoolId<S>]?: { rate: ValidRate; usedSoFar?: number } };
  feeds?: boolean;
}

export interface CatalogApi<S extends CatalogState> {
  /** Flat, serializable view of the catalog. */
  readonly meters: { [K in MeterId<S>]: MeterInfo };

  context<C extends BaseContext>(): Metering<With<S, "ctx", C>>;
  context<C extends BaseContext>(schema: StandardSchemaV1<any, C> | Typed<C>, opts?: ContextOptions): Metering<With<S, "ctx", C>>;

  refs<R extends string>(): Metering<With<S, "ref", R>>;
  refs<const R extends string>(schema: StandardSchemaV1<any, R> | Typed<R> | readonly R[]): Metering<With<S, "ref", R>>;

  // The feeds overload comes first: calls without opts skip it on arity alone, calls with feeds do not
  // pay for a failed attempt at the plain overload.
  meter<const Id extends string, const Spec extends DimsSpec>(
    id: Id,
    dims: Spec,
    opts: { feeds: FeedsOf<S, DimsFromSpec<Spec>> },
  ): Metering<MeteringState<S["ctx"], S["ref"], S["meters"] | MeterEntry<Id, DimsFromSpec<Spec>, false>, S["pools"], S["rate"], S["commit"]>>;
  meter<const Id extends string, const Spec extends DimsSpec = readonly []>(
    id: Id,
    dims?: Spec,
    opts?: { feeds?: undefined },
  ): Metering<MeteringState<S["ctx"], S["ref"], S["meters"] | MeterEntry<Id, DimsFromSpec<Spec>, IsEmpty<DimsFromSpec<Spec>>>, IsEmpty<DimsFromSpec<Spec>> extends true ? S["pools"] | Id : S["pools"], S["rate"], S["commit"]>>;

  getRate(fn: GetRate<S>): Metering<With<S, "rate", true>>;
  commit(fn: Commit): Metering<With<S, "commit", true>>;

  /** Same catalog, other adapters: returns a new bound copy. */
  bind(adapters: { getRate: GetRate<S>; commit: Commit }): Metering<With<With<S, "rate", true>, "commit", true>>;

  /** Pure pricing with the catalog's `feeds`. Pool lines must be present or given via `opts.pools`. */
  price(lines: readonly PricedLineOf<S>[], ref: RefOf<S>, ctx: S["ctx"], opts?: MeteringPriceOptions<S>): Priced;

  validateRate(rate: unknown): RateValidation;
}

export interface BoundApi<S extends CatalogState> {
  observe<K extends MeterId<S>>(
    meter: K,
    dims: DimsOf<S, K>,
    quantity: number,
    ref: RefOf<S>,
    ctx: S["ctx"],
    opts?: ObserveOptions<number>,
  ): Promise<Result>;
  observe(lines: readonly LineOf<S>[], ref: RefOf<S>, ctx: S["ctx"], opts?: ObserveOptions<{ [K in MeterId<S>]?: number }>): Promise<Result>;

  hold<K extends MeterId<S>>(
    meter: K,
    dims: DimsOf<S, K>,
    quantity: number,
    ref: RefOf<S>,
    ctx: S["ctx"],
    opts?: ObserveOptions<number>,
  ): Promise<HoldResult>;
  hold(lines: readonly LineOf<S>[], ref: RefOf<S>, ctx: S["ctx"], opts?: ObserveOptions<{ [K in MeterId<S>]?: number }>): Promise<HoldResult>;

  extend(hold: HoldLike, lines: readonly LineOf<S>[], ctx: S["ctx"], opts?: ObserveOptions<{ [K in MeterId<S>]?: number }>): Promise<HoldResult>;
  capture(hold: HoldLike, lines: readonly CaptureLineOf<S>[], ctx: S["ctx"], opts?: CaptureOptions): Promise<CaptureResult>;
  release(hold: HoldLike, ctx: S["ctx"], opts?: { at?: number }): Promise<CaptureResult>;

  /** Writes an externally built plan (e.g. from `/adjustments`) through the bound `commit`. */
  commit(plan: Plan): Promise<CommitResult>;

  /** Same calls, no commit: returns what would be written. */
  readonly plan: {
    observe<K extends MeterId<S>>(
      meter: K,
      dims: DimsOf<S, K>,
      quantity: number,
      ref: RefOf<S>,
      ctx: S["ctx"],
      opts?: ObserveOptions<number>,
    ): Promise<Planned<Result>>;
    observe(lines: readonly LineOf<S>[], ref: RefOf<S>, ctx: S["ctx"], opts?: ObserveOptions<{ [K in MeterId<S>]?: number }>): Promise<Planned<Result>>;
    hold(lines: readonly LineOf<S>[], ref: RefOf<S>, ctx: S["ctx"], opts?: ObserveOptions<{ [K in MeterId<S>]?: number }>): Promise<Planned<HoldResult>>;
    extend(hold: HoldLike, lines: readonly LineOf<S>[], ctx: S["ctx"], opts?: ObserveOptions<{ [K in MeterId<S>]?: number }>): Promise<Planned<HoldResult>>;
    capture(hold: HoldLike, lines: readonly CaptureLineOf<S>[], ctx: S["ctx"], opts?: CaptureOptions): Promise<Planned<CaptureResult>>;
    release(hold: HoldLike, ctx: S["ctx"], opts?: { at?: number }): Promise<Planned<CaptureResult>>;
  };
}

export type Bound<S extends CatalogState> = S["rate"] extends true ? (S["commit"] extends true ? true : false) : false;

/** The single catalog object. Each chain step mutates it and narrows its type; always use the returned reference. */
export type Metering<S extends CatalogState = InitialState> = CatalogApi<S> & (Bound<S> extends true ? BoundApi<S> : {});

// ---------------------------------------------------------------------------
// Runtime

type DimsKind =
  | { kind: "none" }
  | { kind: "keys"; keys: string[] }
  | { kind: "shape"; shape: Record<string, StandardSchemaV1> }
  | { kind: "schema"; schema: StandardSchemaV1; keys: string[] }
  | { kind: "typed" };

interface MeterDef {
  id: string;
  dims: DimsKind;
  feeds: Map<string, FeedWeight<any, any>>;
}

interface Catalog {
  ctxSchema?: StandardSchemaV1 | undefined;
  validateCtx: boolean;
  refSchema?: StandardSchemaV1 | undefined;
  refList?: Set<string> | undefined;
  meters: Map<string, MeterDef>;
}

interface Expanded {
  meter: string;
  dims: Dims;
  quantity: number;
  feeder?: { meter: string; weight: number; line: number };
}

type AnyOpts = ObserveOptions<number | Record<string, number | undefined>>;

function dimsKind(spec: unknown): DimsKind {
  if (spec === undefined) return { kind: "none" };
  if (Array.isArray(spec)) {
    for (const k of spec) if (typeof k !== "string") throw new TypeError("dimension keys must be strings");
    return spec.length ? { kind: "keys", keys: [...spec] } : { kind: "none" };
  }
  if (isTyped(spec)) return { kind: "typed" };
  if (isStandardSchema(spec)) {
    const shape = (spec as { shape?: unknown }).shape;
    return { kind: "schema", schema: spec, keys: shape && typeof shape === "object" ? Object.keys(shape) : [] };
  }
  if (typeof spec === "object" && spec !== null) {
    const shape = spec as Record<string, unknown>;
    for (const [k, v] of Object.entries(shape)) {
      if (!isStandardSchema(v)) throw new TypeError(`dimension "${k}" must be a Standard Schema (zod, valibot, arktype…)`);
    }
    return Object.keys(shape).length ? { kind: "shape", shape: shape as Record<string, StandardSchemaV1> } : { kind: "none" };
  }
  throw new TypeError("dims must be a key array, a record of schemas, a schema or typed<T>()");
}

function dimKeys(d: DimsKind): string[] {
  switch (d.kind) {
    case "keys":
      return d.keys;
    case "shape":
      return Object.keys(d.shape);
    case "schema":
      return d.keys;
    default:
      return [];
  }
}

function assertQuantity(meter: string, q: number) {
  if (!Number.isSafeInteger(q) || q < 0) throw new RangeError(`quantity for "${meter}" must be a non-negative integer, got ${q}`);
}

type RawGetRate = (...args: any[]) => Awaitable<RateAnswer | null | undefined>;

class MeteringImpl {
  #cat: Catalog;
  #getRate?: RawGetRate | undefined;
  #commit?: Commit | undefined;

  constructor(cat?: Catalog, getRate?: RawGetRate, commit?: Commit) {
    this.#cat = cat ?? { validateCtx: true, meters: new Map() };
    this.#getRate = getRate;
    this.#commit = commit;
  }

  get meters(): Record<string, MeterInfo> {
    const out: Record<string, MeterInfo> = {};
    for (const m of this.#cat.meters.values()) out[m.id] = { dims: dimKeys(m.dims), feeds: [...m.feeds.keys()] };
    return out;
  }

  context(schema?: unknown, opts?: ContextOptions): this {
    if (schema !== undefined && !isTyped(schema)) {
      if (!isStandardSchema(schema)) throw new TypeError("context() takes a Standard Schema, typed<T>() or nothing");
      this.#cat.ctxSchema = schema;
    }
    this.#cat.validateCtx = opts?.validate !== "never";
    return this;
  }

  refs(schema?: unknown): this {
    if (Array.isArray(schema)) this.#cat.refList = new Set(schema as string[]);
    else if (schema !== undefined && !isTyped(schema)) {
      if (!isStandardSchema(schema)) throw new TypeError("refs() takes a Standard Schema, a string array, typed<T>() or nothing");
      this.#cat.refSchema = schema;
    }
    return this;
  }

  meter(id: string, dims?: unknown, opts?: { feeds?: Record<string, FeedWeight<any, any>> }): this {
    if (typeof id !== "string" || !id) throw new TypeError("meter id must be a non-empty string");
    if (this.#cat.meters.has(id)) throw new Error(`meter "${id}" is already defined`);
    const kind = dimsKind(dims);
    const feeds = new Map<string, FeedWeight<any, any>>();
    for (const [pool, w] of Object.entries(opts?.feeds ?? {})) {
      if (w === undefined) continue;
      const target = this.#cat.meters.get(pool);
      if (!target) throw new Error(`meter "${id}" feeds "${pool}", which is not defined yet; define pools first`);
      if (target.feeds.size) throw new Error(`"${pool}" feeds other meters and cannot be a pool`);
      if (dimKeys(target.dims).length || target.dims.kind === "schema" || target.dims.kind === "typed")
        throw new Error(`pool "${pool}" must be declared without dims`);
      if (typeof w !== "function" && !(typeof w === "number" && Number.isFinite(w) && w >= 0))
        throw new TypeError(`feed weight for "${pool}" must be a non-negative number or a function`);
      feeds.set(pool, w);
    }
    for (const m of this.#cat.meters.values()) {
      if (m.feeds.has(id)) throw new Error(`"${id}" is already a pool target`); // unreachable: pools are defined first
    }
    this.#cat.meters.set(id, { id, dims: kind, feeds });
    return this;
  }

  getRate(fn: RawGetRate): this {
    if (typeof fn !== "function") throw new TypeError("getRate must be a function");
    this.#getRate = fn;
    return this;
  }

  commit(arg: unknown): any {
    if (typeof arg === "function") {
      this.#commit = arg as Commit;
      return this;
    }
    return this.#runCommit(arg as Plan);
  }

  bind(adapters: { getRate: RawGetRate; commit: Commit }): MeteringImpl {
    // a copy: adding meters to the bound one must not change the original
    return new MeteringImpl({ ...this.#cat, meters: new Map(this.#cat.meters) }, adapters.getRate, adapters.commit);
  }

  validateRate(rate: unknown): RateValidation {
    return validateRate(rate);
  }

  price(lines: readonly PricedLine[], ref: Ref, ctx: BaseContext, opts: MeteringPriceOptions<any> = {}): Priced {
    const out: PricedLine[] = [...lines];
    if (opts.feeds !== false) {
      const present = new Set(lines.map((l) => l.meter));
      for (const l of lines) {
        if (l.feeder) continue;
        const def = this.#def(l.meter);
        for (const [pool, w] of def.feeds) {
          if (present.has(pool)) continue;
          const p = (opts.pools as Record<string, { rate: ValidRate; usedSoFar?: number }> | undefined)?.[pool];
          if (!p) throw new Error(`price(): "${l.meter}" feeds "${pool}" but no pool line or opts.pools["${pool}"] was given`);
          const weight = this.#weight(w, l.dims ?? {}, ctx, pool);
          const pl: PricedLine = { meter: pool, dims: {}, quantity: poolQuantity(l.quantity, weight), rate: p.rate, feeder: { meter: l.meter, weight } };
          if (p.usedSoFar !== undefined) pl.usedSoFar = p.usedSoFar;
          if (l.at !== undefined) pl.at = l.at;
          out.push(pl);
        }
      }
    }
    return corePrice(out, ref, ctx, opts);
  }

  // --- bound calls --------------------------------------------------------

  get plan() {
    return {
      observe: (...a: unknown[]) => this.#observe(a, false),
      hold: (...a: unknown[]) => this.#hold(a, false),
      extend: (h: HoldLike, lines: unknown[], ctx: BaseContext, opts?: AnyOpts) => this.#extend(h, lines, ctx, opts, false),
      capture: (h: HoldLike, lines: unknown[], ctx: BaseContext, opts?: CaptureOptions) => this.#capture(h, lines, ctx, opts, false),
      release: (h: HoldLike, ctx: BaseContext, opts?: { at?: number }) => this.#release(h, ctx, opts, false),
    };
  }

  async observe(...a: unknown[]): Promise<Result> {
    return (await this.#observe(a, true)).result;
  }
  async hold(...a: unknown[]): Promise<HoldResult> {
    return (await this.#hold(a, true)).result;
  }
  async extend(h: HoldLike, lines: unknown[], ctx: BaseContext, opts?: AnyOpts): Promise<HoldResult> {
    return (await this.#extend(h, lines, ctx, opts, true)).result;
  }
  async capture(h: HoldLike, lines: unknown[], ctx: BaseContext, opts?: CaptureOptions): Promise<CaptureResult> {
    return (await this.#capture(h, lines, ctx, opts, true)).result;
  }
  async release(h: HoldLike, ctx: BaseContext, opts?: { at?: number }): Promise<CaptureResult> {
    return (await this.#release(h, ctx, opts, true)).result;
  }

  // --- internals -----------------------------------------------------------

  #def(meter: string): MeterDef {
    const d = this.#cat.meters.get(meter);
    if (!d) throw new Error(`unknown meter "${meter}"`);
    return d;
  }

  #assertBound(write: boolean) {
    if (!this.#getRate) throw new Error("getRate is not bound: call .getRate(fn) or .bind({ getRate, commit })");
    if (write && !this.#commit) throw new Error("commit is not bound: call .commit(fn) or .bind({ getRate, commit })");
  }

  #weight(w: FeedWeight<any, any>, dims: Dims, ctx: BaseContext, pool: string): number {
    const weight = typeof w === "function" ? w(dims, ctx) : w;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0)
      throw new RangeError(`feed weight for "${pool}" must be a non-negative finite number, got ${weight}`);
    return weight;
  }

  /** Positional `(meter, dims, qty, ref, ctx, opts)` or `(lines, ref, ctx, opts)`. */
  #args(a: unknown[]): { lines: { meter: string; dims?: Dims; quantity: number }[]; ref: Ref; ctx: BaseContext; opts: AnyOpts } {
    if (typeof a[0] === "string") {
      const [meter, dims, quantity, ref, ctx, opts] = a as [string, Dims, number, Ref, BaseContext, ObserveOptions<number> | undefined];
      const o: AnyOpts = { ...(opts ?? {}) };
      if (typeof opts?.usedSoFar === "number") o.usedSoFar = { [meter]: opts.usedSoFar };
      return { lines: [{ meter, dims, quantity }], ref, ctx, opts: o };
    }
    const [lines, ref, ctx, opts] = a as [{ meter: string; dims?: Dims; quantity: number }[], Ref, BaseContext, AnyOpts | undefined];
    if (!Array.isArray(lines)) throw new TypeError("expected a meter id or an array of lines");
    return { lines, ref, ctx, opts: opts ?? {} };
  }

  async #checkCtx(ctx: unknown): Promise<{ ok: true; ctx: BaseContext } | Failure> {
    let value = ctx;
    if (this.#cat.ctxSchema && this.#cat.validateCtx) {
      const r = await runSchema(this.#cat.ctxSchema, ctx);
      if (!r.ok) return fail("invalid_context", { cause: r.issues });
      value = r.value;
    }
    if (typeof value !== "object" || value === null || typeof (value as BaseContext).accountId !== "string")
      return fail("invalid_context", { cause: "ctx.accountId must be a string" });
    return { ok: true, ctx: value as BaseContext };
  }

  async #checkRef(ref: Ref): Promise<Failure | null> {
    if (typeof ref !== "object" || ref === null || typeof ref.id !== "string" || typeof ref.type !== "string")
      return fail("invalid_ref", { cause: "ref must be { type: string, id: string }" });
    if (this.#cat.refList && !this.#cat.refList.has(ref.type)) return fail("invalid_ref", { cause: `unknown ref type "${ref.type}"` });
    if (this.#cat.refSchema) {
      const r = await runSchema(this.#cat.refSchema, ref.type);
      if (!r.ok) return fail("invalid_ref", { cause: r.issues });
    }
    return null;
  }

  async #checkDims(meter: string, dims: Dims | undefined): Promise<{ ok: true; dims: Dims } | Failure> {
    const def = this.#def(meter);
    const d = def.dims;
    const value = dims ?? {};
    if (typeof value !== "object" || value === null) return fail("invalid_dims", { meter, cause: "dims must be an object" });
    if (d.kind === "shape") {
      const out: Dims = {};
      const issues: unknown[] = [];
      for (const k of Object.keys(value)) if (!(k in d.shape)) issues.push({ message: `unknown dimension "${k}"`, path: [k] });
      for (const [k, schema] of Object.entries(d.shape)) {
        const r = await runSchema(schema, (value as Dims)[k]);
        if (r.ok) {
          if (r.value !== undefined) out[k] = r.value;
        } else issues.push(...r.issues.map((i) => ({ ...i, path: [k, ...(i.path ?? [])] })));
      }
      return issues.length ? fail("invalid_dims", { meter, cause: issues }) : { ok: true, dims: out };
    }
    if (d.kind === "schema") {
      const r = await runSchema(d.schema, value);
      return r.ok ? { ok: true, dims: r.value as Dims } : fail("invalid_dims", { meter, cause: r.issues });
    }
    return { ok: true, dims: value };
  }

  #expand(lines: readonly Expanded[], ctx: BaseContext, feeds: boolean, offset = 0): Expanded[] {
    const out = lines.map((l) => ({ ...l }));
    if (!feeds) return out;
    const present = new Set(lines.map((l) => l.meter));
    lines.forEach((l, i) => {
      if (l.feeder) return;
      for (const [pool, w] of this.#def(l.meter).feeds) {
        if (present.has(pool)) continue;
        const weight = this.#weight(w, l.dims, ctx, pool);
        out.push({ meter: pool, dims: {}, quantity: poolQuantity(l.quantity, weight), feeder: { meter: l.meter, weight, line: i + offset } });
      }
    });
    return out;
  }

  async #prepare(
    raw: readonly { meter: string; dims?: Dims; quantity: number }[],
    ref: Ref | false,
    ctx: unknown,
    opts: AnyOpts,
  ): Promise<{ ok: true; ctx: BaseContext; lines: Expanded[] } | Failure> {
    const c = await this.#checkCtx(ctx);
    if (!c.ok) return c;
    if (ref !== false) {
      const rf = await this.#checkRef(ref);
      if (rf) return rf;
    }
    const lines: Expanded[] = [];
    for (const l of raw) {
      assertQuantity(l.meter, l.quantity);
      const d = await this.#checkDims(l.meter, l.dims);
      if (!d.ok) return d;
      lines.push({ meter: l.meter, dims: d.dims, quantity: l.quantity });
    }
    return { ok: true, ctx: c.ctx, lines };
  }

  async #resolve(lines: readonly Expanded[], ctx: BaseContext, at: number, opts: AnyOpts): Promise<PricedHoldLine[] | Failure> {
    const cache = new Map<string, Promise<RateAnswer | null | undefined>>();
    const answers = await Promise.all(
      lines.map((l) => {
        const key = lineKey(l.meter, l.dims);
        let p = cache.get(key);
        if (!p) {
          p = Promise.resolve(this.#getRate!(l.meter, l.dims, ctx, at));
          cache.set(key, p);
        }
        return p;
      }),
    );
    const overrides = (opts.usedSoFar ?? {}) as Record<string, number | undefined>;
    const out: PricedHoldLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const ans = answers[i];
      let r: ValidRate;
      let used: number | undefined;
      let carry: number | undefined;
      if (ans === null || ans === undefined) {
        if ((opts.ifMissing ?? "reject") === "reject") return fail("no_price", { meter: l.meter });
        r = FREE_RATE;
      } else {
        const v = validateRate(ans.rate);
        if (!v.ok) return fail("invalid_rate", { meter: l.meter, cause: v.errors });
        r = v.rate;
        used = ans.usedSoFar;
        carry = ans.carry;
      }
      if (overrides[l.meter] !== undefined) used = overrides[l.meter];
      const pl: PricedHoldLine = { meter: l.meter, dims: l.dims, quantity: l.quantity, rate: r, at };
      if (used !== undefined) pl.usedSoFar = used;
      if (carry !== undefined) pl.carry = carry;
      if (l.feeder) pl.feeder = l.feeder;
      out.push(pl);
    }
    return out;
  }

  async #runCommit(plan: Plan): Promise<CommitResult> {
    if (!this.#commit) throw new Error("commit is not bound");
    if (plan.ledger.length === 0 && plan.usage.length === 0) return { ok: true };
    try {
      await this.#commit(plan);
      return { ok: true };
    } catch (e) {
      return fail(isInsufficientCredit(e) ? "insufficient_credit" : "commit_failed", { cause: e });
    }
  }

  async #finish<R extends { ok: boolean }>(p: HoldPlanned<R> & { lines?: PricedLine[] }, write: boolean): Promise<Planned<R | Failure>> {
    const lines = p.lines ?? [];
    if (!p.result.ok || !write) return { result: p.result, plan: p.plan, lines };
    const c = await this.#runCommit(p.plan);
    return { result: c.ok ? p.result : c, plan: p.plan, lines };
  }

  async #observe(a: unknown[], write: boolean): Promise<Planned<Result>> {
    this.#assertBound(write);
    const { lines, ref, ctx, opts } = this.#args(a);
    const at = opts.at ?? Date.now();
    const prep = await this.#prepare(lines, ref, ctx, opts);
    if (!prep.ok) return { result: prep, plan: { ledger: [], usage: [] }, lines: [] };
    const expanded = this.#expand(prep.lines, prep.ctx, opts.feeds !== false);
    const priced = await this.#resolve(expanded, prep.ctx, at, opts);
    if (!Array.isArray(priced)) return { result: priced, plan: { ledger: [], usage: [] }, lines: [] };
    const plain: PricedLine[] = priced.map(({ feeder, ...l }) => (feeder ? { ...l, feeder: { meter: feeder.meter, weight: feeder.weight } } : l));
    const p = corePrice(plain, ref, prep.ctx, { at });
    return this.#finish({ result: p.result, plan: p.plan, lines: plain }, write);
  }

  async #hold(a: unknown[], write: boolean): Promise<Planned<HoldResult>> {
    this.#assertBound(write);
    const { lines, ref, ctx, opts } = this.#args(a);
    const at = opts.at ?? Date.now();
    const prep = await this.#prepare(lines, ref, ctx, opts);
    if (!prep.ok) return { result: prep, plan: { ledger: [], usage: [] }, lines: [] };
    const expanded = this.#expand(prep.lines, prep.ctx, opts.feeds !== false);
    const priced = await this.#resolve(expanded, prep.ctx, at, opts);
    if (!Array.isArray(priced)) return { result: priced, plan: { ledger: [], usage: [] }, lines: [] };
    return this.#finish({ ...planHold(priced, ref, prep.ctx.accountId, at), lines: priced as PricedLine[] }, write);
  }

  async #extend(h: HoldLike, raw: unknown[], ctx: BaseContext, opts: AnyOpts = {}, write: boolean): Promise<Planned<HoldResult>> {
    this.#assertBound(write);
    const hold = unwrapHold(h);
    const at = opts.at ?? Date.now();
    const prep = await this.#prepare(raw as Expanded[], false, ctx, opts);
    if (!prep.ok) return { result: prep, plan: { ledger: [], usage: [] }, lines: [] };
    if (prep.ctx.accountId !== hold.account) return { result: fail("invalid_context", { cause: "ctx.accountId does not match the hold" }), plan: { ledger: [], usage: [] }, lines: [] };
    // held (meter, dims) only grow, keeping their tariff and position; new ones are expanded and priced
    const held = new Map(hold.lines.map((l) => [lineKey(l.meter, l.dims), l]));
    const grow: PricedHoldLine[] = [];
    const fresh: Expanded[] = [];
    for (const l of prep.lines) {
      const h = held.get(lineKey(l.meter, l.dims));
      if (h) grow.push({ meter: l.meter, dims: l.dims, quantity: l.quantity, rate: h.rate });
      else fresh.push(l);
    }
    const expanded = this.#expand(fresh, prep.ctx, opts.feeds !== false, grow.length);
    const priced = await this.#resolve(expanded, prep.ctx, at, opts);
    if (!Array.isArray(priced)) return { result: priced, plan: { ledger: [], usage: [] }, lines: [] };
    const added = [...grow, ...priced];
    return this.#finish({ ...planExtend(hold, added, at), lines: added as PricedLine[] }, write);
  }

  async #capture(h: HoldLike, lines: unknown[], ctx: BaseContext, opts: CaptureOptions = {}, write: boolean): Promise<Planned<CaptureResult>> {
    this.#assertBound(write);
    const hold = unwrapHold(h);
    const c = await this.#checkCtx(ctx);
    if (!c.ok) return { result: c, plan: { ledger: [], usage: [] }, lines: [] };
    if (c.ctx.accountId !== hold.account) return { result: fail("invalid_context", { cause: "ctx.accountId does not match the hold" }), plan: { ledger: [], usage: [] }, lines: [] };
    let override: Rate | Record<string, Rate> | undefined;
    if (opts.rate) {
      if ("model" in opts.rate) {
        const v = validateRate(opts.rate);
        if (!v.ok) return { result: fail("invalid_rate", { cause: v.errors }), plan: { ledger: [], usage: [] }, lines: [] };
        override = v.rate;
      } else {
        const m: Record<string, Rate> = {};
        for (const [meter, r] of Object.entries(opts.rate)) {
          const v = validateRate(r);
          if (!v.ok) return { result: fail("invalid_rate", { meter, cause: v.errors }), plan: { ledger: [], usage: [] }, lines: [] };
          m[meter] = v.rate;
        }
        override = m;
      }
    }
    return this.#finish(planCapture(hold, lines as { meter: string; quantity: number }[], opts.at ?? Date.now(), override), write);
  }

  async #release(h: HoldLike, ctx: BaseContext, opts: { at?: number } = {}, write: boolean): Promise<Planned<CaptureResult>> {
    this.#assertBound(write);
    const hold = unwrapHold(h);
    const c = await this.#checkCtx(ctx);
    if (!c.ok) return { result: c, plan: { ledger: [], usage: [] }, lines: [] };
    if (c.ctx.accountId !== hold.account) return { result: fail("invalid_context", { cause: "ctx.accountId does not match the hold" }), plan: { ledger: [], usage: [] }, lines: [] };
    return this.#finish(planRelease(hold, opts.at ?? Date.now()), write);
  }
}

/**
 * Starts a catalog. One object, one chain, no `build()`:
 *
 * ```ts
 * const metering = buildMetering()
 *   .context(z.object({ accountId: z.string() }))
 *   .refs(["otp_send"])
 *   .meter("otp/sms", { country: z.string().length(2) })
 *   .getRate(async (meter, dims, ctx, at) => ({ rate, usedSoFar }))
 *   .commit(async (plan) => { ... });
 * ```
 */
export function buildMetering(): Metering<InitialState> {
  return new MeteringImpl() as unknown as Metering<InitialState>;
}
