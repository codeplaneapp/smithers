/*
 * The remote-cache HTTP service.
 *
 * It implements the protocol the Smithers client and the smthrs CLI already
 * speak, and adds nothing to it. protocol.js is the protocol, storage.js is
 * the Postgres translation of it, config.js is the environment contract, and
 * this file is only startup.
 *
 * Sources: RemoteCacheStore.ts and RemoteArtifacts.ts in this repository, which
 * define the status vocabulary this service mirrors, and infra/worker, which
 * serves the same protocol on Cloudflare. Bazel's HttpCacheClient is the
 * upstream shape; findMissing is the Smithers addition.
 *
 * Written in JavaScript, run by Bun, using Bun's built-in Postgres client so
 * the image has no dependency tree of its own.
 */
import { SQL } from "bun"
import { readConfig } from "./config.js"
import { createHandler, describeFailure, maxActionCacheBodyBytes } from "./protocol.js"
import { createStorage } from "./storage.js"

/** Exit code for a configuration failure, the sysexits.h EX_CONFIG value. */
const configurationExitCode = 78
const temporaryFailureExitCode = 75

/**
 * The listener's own body cap, above every bound the protocol enforces.
 *
 * Bun.serve refuses bodies past `maxRequestBodySize` itself, and its default
 * (128 MiB) silently overrides a larger configured artifact bound. The cap is
 * therefore wired from the configuration, with one chunk of headroom so the
 * protocol's bounded reads always answer first: a refusal from the handler is
 * a 413 with a diagnostic body, while the listener tripping mid-stream would
 * surface as a read failure and become a 503.
 *
 * @category utilities
 */
export const requestBodyCap = (maxArtifactBytes) => Math.max(maxArtifactBytes, maxActionCacheBodyBytes) + 1024 * 1024

/**
 * Validates the environment, opens the connection, and starts listening.
 *
 * Nothing here runs on import, so the protocol and the storage translation can
 * be tested without a listener and without a database.
 *
 * @category constructors
 */
export const main = async (env = process.env, runtime = {}) => {
  const processRuntime = runtime.process ?? process
  const logger = runtime.console ?? console
  const openSql = runtime.openSql ?? ((databaseUrl) => new SQL(databaseUrl, { max: 8 }))
  const serve = runtime.serve ?? ((options) => Bun.serve(options))
  const result = readConfig(env)
  if (!result.ok) {
    for (const problem of result.problems) logger.error(`smithers build cache: ${problem}`)
    processRuntime.exitCode = configurationExitCode
    return null
  }
  const config = result.config
  const database = openSql(config.databaseUrl)
  const { actionCache, contentStore, health } = createStorage(database)
  try {
    await health()
  } catch (cause) {
    logger.error("smithers build cache: database readiness check failed")
    logger.error(describeFailure(cause))
    try {
      await database.close?.()
    } catch (closeCause) {
      logger.error(describeFailure(closeCause))
    }
    processRuntime.exitCode = temporaryFailureExitCode
    return null
  }

  let server
  try {
    server = serve({
      hostname: config.hostname,
      port: config.port,
      idleTimeout: 60,
      maxRequestBodySize: requestBodyCap(config.maxArtifactBytes),
      fetch: createHandler({
        actionCache,
        contentStore,
        health,
        readTokenHash: config.readTokenHash,
        writeTokenHash: config.writeTokenHash,
        maxArtifactBytes: config.maxArtifactBytes
      }),
      error(cause) {
        // The handler already answers its own failures with a 503. This is the
        // backstop for a failure outside it, with the same secret-free log.
        logger.error(describeFailure(cause))
        return new Response(JSON.stringify({ error: "the cache tier failed to answer" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
      }
    })
  } catch (cause) {
    logger.error("smithers build cache: listener startup failed")
    logger.error(describeFailure(cause))
    try {
      await database.close?.()
    } catch (closeCause) {
      logger.error(describeFailure(closeCause))
    }
    processRuntime.exitCode = temporaryFailureExitCode
    return null
  }

  const signals = ["SIGINT", "SIGTERM"]
  let closePromise = null
  const removeSignalHandlers = () => {
    for (const signal of signals) processRuntime.off?.(signal, onSignal)
  }
  const close = () => {
    if (closePromise !== null) return closePromise
    closePromise = (async () => {
      removeSignalHandlers()
      let failure = null
      try {
        await server.stop?.()
      } catch (cause) {
        failure = cause
      }
      try {
        await database.close?.()
      } catch (cause) {
        failure ??= cause
      }
      if (failure !== null) throw failure
    })()
    return closePromise
  }
  const onSignal = () => {
    void close().catch((cause) => {
      logger.error(describeFailure(cause))
      processRuntime.exitCode = temporaryFailureExitCode
    })
  }
  for (const signal of signals) processRuntime.once?.(signal, onSignal)

  if (config.development) {
    logger.warn(
      "smithers build cache: SMITHERS_CACHE_READ_TOKEN and SMITHERS_CACHE_WRITE_TOKEN are empty, " +
        "so every request is accepted. The listener is restricted to loopback."
    )
  }
  logger.log(`smithers build cache listening on ${config.hostname}:${server.port}`)
  return { server, close }
}

if (import.meta.main) {
  main().catch((cause) => {
    console.error(describeFailure(cause))
    process.exitCode = temporaryFailureExitCode
  })
}
