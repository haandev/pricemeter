/**
 * The Standard Schema interface (https://standardschema.dev), copied as the spec recommends
 * so the library takes no dependency. zod, valibot and arktype all implement it.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}

export function isStandardSchema(x: unknown): x is StandardSchemaV1 {
  // arktype schemas are callable, so functions count too
  return (typeof x === "object" || typeof x === "function") && x !== null && typeof (x as any)["~standard"]?.validate === "function";
}

export async function runSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): Promise<{ ok: true; value: T } | { ok: false; issues: ReadonlyArray<StandardSchemaV1.Issue> }> {
  let r = schema["~standard"].validate(value);
  if (r instanceof Promise) r = await r;
  if (r.issues) return { ok: false, issues: r.issues };
  return { ok: true, value: r.value };
}

/** A compile-time-only type marker: `.meter("x", typed<{ region: string }>())` — typed, never validated. */
export interface Typed<T> {
  readonly "~typed": true;
  /** Phantom; never set at runtime. */
  readonly "~type"?: T;
}

/** Declares a type without a runtime schema. Nothing is validated. */
export function typed<T>(): Typed<T> {
  return { "~typed": true } as Typed<T>;
}

export function isTyped(x: unknown): x is Typed<unknown> {
  return typeof x === "object" && x !== null && (x as any)["~typed"] === true;
}
