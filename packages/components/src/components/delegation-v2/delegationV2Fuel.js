/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

/** @param {string} left @param {string} right */
function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Partition one invocation's remaining subtree fuel into disjoint immutable
 * budgets for its continuation and immediate nested authors. Unused child fuel
 * is intentionally not reclaimed: that keeps replay a pure fold over persisted
 * rows and makes the global upper bound independent of scheduling order.
 *
 * @param {{nestedLogicalIds: readonly string[], remainingTurns: number, parentCapacity: number}} options
 */
export function partitionDelegationV2AuthorFuel(options) {
  const remainingTurns = positiveInteger(options.remainingTurns, "remainingTurns");
  const parentCapacity = positiveInteger(options.parentCapacity, "parentCapacity");
  const nestedLogicalIds = [...new Set(options.nestedLogicalIds)].sort(compareCodePoints);
  if (nestedLogicalIds.length !== options.nestedLogicalIds.length) {
    throw new TypeError("nested author logical ids must be unique");
  }
  const bucketCount = nestedLogicalIds.length + 1;
  if (remainingTurns < bucketCount) {
    throw new RangeError(
      `remaining author fuel ${remainingTurns} cannot fund ${nestedLogicalIds.length} children plus the parent continuation`,
    );
  }

  const base = Math.floor(remainingTurns / bucketCount);
  let remainder = remainingTurns % bucketCount;
  let parentTurns = base + (remainder > 0 ? 1 : 0);
  if (remainder > 0) remainder -= 1;
  /** @type {Record<string, number>} */
  const childTurns = Object.create(null);
  for (const logicalId of nestedLogicalIds) {
    childTurns[logicalId] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }

  if (parentTurns > parentCapacity) {
    let overflow = parentTurns - parentCapacity;
    parentTurns = parentCapacity;
    if (nestedLogicalIds.length > 0) {
      for (let index = 0; overflow > 0; index = (index + 1) % nestedLogicalIds.length) {
        childTurns[nestedLogicalIds[index]] += 1;
        overflow -= 1;
      }
    }
    // With no child there is nowhere useful to spend capacity beyond the
    // remaining local author turns. Dropping it still preserves the hard cap.
  }

  return {
    parentTurns,
    childTurns,
    allocatedTurns: parentTurns + Object.values(childTurns).reduce((sum, value) => sum + value, 0),
  };
}

/**
 * Turn an otherwise accepted program into a typed rejection before any child
 * is mounted when the current subtree cannot fund every nested author and one
 * mandatory parent continuation.
 *
 * @param {Record<string, any>} validation
 * @param {number} remainingTurns
 */
export function enforceDelegationV2AuthorFuel(validation, remainingTurns) {
  if (!validation?.ok || !validation.normalizedProgram) return validation;
  const needed = Number(validation.stats?.authors ?? 0) + 1;
  if (remainingTurns >= needed) return validation;
  return {
    ...validation,
    ok: false,
    status: "rejected",
    normalizedProgram: undefined,
    diagnostics: [
      {
        code: "author_fuel_limit",
        path: "root.root",
        message: `Program needs ${needed} remaining author turns (${needed - 1} nested authors plus one parent continuation); only ${remainingTurns} remain.`,
      },
    ],
  };
}
