import { satisfies } from "semver"

/** Check the complete declared range, including unsupported major-version gaps. */
export const assertNodeSupport = (manifest, version) => {
  const range = manifest.engines?.node
  if (range !== undefined && !satisfies(version, range)) {
    throw new Error(`${manifest.name} requires node ${range}; this smoke runs on ${version}`)
  }
}
