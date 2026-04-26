import type { z } from "zod";
import type { CreateSmithersApi } from "../CreateSmithersApi";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;

type Api = CreateSmithersApi<{
  input: z.ZodObject<{ prompt: z.ZodString }>;
}>;
type Ctx = Parameters<Parameters<Api["smithers"]>[0]>[0];

type _PromptIsString = Assert<Equal<Ctx["input"]["prompt"], string>>;

// @ts-expect-error input.foo is not declared by the workflow input schema.
type _MissingFoo = Ctx["input"]["foo"];
