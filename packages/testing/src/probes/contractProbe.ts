import { boundaryShape, compareBoundaryShape, type BoundaryShape } from "./compareBoundaryShape.ts";
export type ProbeReport = Readonly<{
  readonly name: string;
  readonly passed: boolean;
  readonly expected: BoundaryShape;
  readonly actual: BoundaryShape;
  readonly differences: readonly string[];
}>;
const defaultSerialize = (value: unknown): unknown => {
  if (!(value instanceof Error)) return value;
  const record = value as unknown as Record<string, unknown>;
  return JSON.parse(
    JSON.stringify({
      name: value.name,
      message: value.message,
      ...Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      ),
    }),
  );
};
export const contractProbe = async (
  name: string,
  production: () => unknown | Promise<unknown>,
  simulated: () => unknown | Promise<unknown>,
  options: Readonly<{
    readonly serializeProduction?: (value: unknown) => unknown;
    readonly serializeSimulation?: (value: unknown) => unknown;
  }> = {},
): Promise<ProbeReport> => {
  let expected: unknown;
  let actual: unknown;
  let productionThrew = false;
  let simulationThrew = false;
  try {
    expected = await production();
  } catch (error) {
    productionThrew = true;
    expected = error;
  }
  try {
    actual = await simulated();
  } catch (error) {
    simulationThrew = true;
    actual = error;
  }
  const expectedShape = boundaryShape(expected, (options.serializeProduction ?? defaultSerialize)(expected));
  const actualShape = boundaryShape(actual, (options.serializeSimulation ?? defaultSerialize)(actual));
  const differences = [
    ...(productionThrew === simulationThrew ? [] : ["production and simulation must both throw or both succeed"]),
    ...compareBoundaryShape(expectedShape, actualShape),
  ];
  return { name, passed: differences.length === 0, expected: expectedShape, actual: actualShape, differences };
};
