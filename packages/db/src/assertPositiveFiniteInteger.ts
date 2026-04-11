import { SmithersError } from "@smithers/errors/SmithersError";
import { assertPositiveFiniteNumber } from "./assertPositiveFiniteNumber";

export function assertPositiveFiniteInteger(
  field: string,
  value: unknown,
): number {
  const numberValue = assertPositiveFiniteNumber(field, value);
  if (!Number.isInteger(numberValue)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${field} must be an integer greater than 0.`,
      { field, value },
    );
  }
  return numberValue;
}
