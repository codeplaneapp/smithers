import { satisfies } from "semver"

/** The first npm version certified with every optional-peer consumer profile. */
export const smokeNpmRange = ">=11.16.0"

export const assertSmokeNpmSupport = (version) => {
  if (!satisfies(version, smokeNpmRange)) {
    throw new Error(`release smoke requires npm ${smokeNpmRange}; found ${version}. Use npm@11.16.0 on PATH, including with Node 22.19.0. npm 10.9.3 crashes in Arborist on the testing optional-peer graph.`)
  }
}
