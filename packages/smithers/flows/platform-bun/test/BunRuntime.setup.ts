if (process.env.SMITHERS_PLATFORM_BUN_LANE === "1" && !process.versions.bun) {
  throw new Error("The Bun compatibility lane started a worker without process.versions.bun")
}
