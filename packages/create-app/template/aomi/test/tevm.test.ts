/**
 * The chain tool, both layers.
 *
 * Two suites live here for one reason: the mock is what every fixture, pane,
 * and e2e replay is recorded against, so the value of the mock is entirely in
 * whether the real client agrees with it. The parity suite runs with no network
 * and pins the shape each binding returns; the fork suite runs the same inputs
 * through `tevm@rc` against a real chain and checks it produces that same
 * shape. A field the real client renders differently fails here rather than in
 * a pane six months from now.
 *
 * The fork suite needs `TEVM_FORK_RPC_URL`. Without it the whole suite is
 * skipped, because a chain test that quietly passes without a chain is worse
 * than no test.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { beforeAll, describe, expect, test } from "vitest"
import {
  CallOutput,
  ForkOutput,
  GetBalanceOutput,
  GetBlockOutput,
  layerTevm,
  makeMock,
  MineOutput,
  ReadContractOutput,
  type Service,
  SetAccountOutput,
  SimulateOutput,
  Tevm,
  type TevmError
} from "../tools/tevm.ts"

// ---------------------------------------------------------------------------
// Fixtures shared by both suites
// ---------------------------------------------------------------------------

/** Mainnet USDC. Present on any mainnet fork, at any block this decade. */
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
/** vitalik.eth. Holds a non-zero balance of both ether and USDC. */
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
/** An address no one holds a key to, used as a transfer sink. */
const SINK = "0x1111111111111111111111111111111111111111"

const BALANCE_OF = ["function balanceOf(address) view returns (uint256)"]
/** `balanceOf(VITALIK)`, encoded, for the raw-calldata bindings. */
const BALANCE_OF_VITALIK = `0x70a08231000000000000000000000000${VITALIK.slice(2).toLowerCase()}`

/**
 * One binding: the call that exercises it, and its declared output schema
 * already turned into a decoder.
 *
 * The decoder is built here rather than stored as a schema because the eight
 * schemas have eight different types; erasing them to one decoder signature is
 * what lets the cases sit in one array.
 */
interface Case {
  readonly name: string
  readonly decode: (value: unknown) => unknown
  readonly run: (chain: Service) => Effect.Effect<unknown, TevmError>
}

/**
 * The seven state-reading calls, run identically against both layers.
 *
 * `fork` is absent because only one layer can honour it. `setAccount` and
 * `simulate` write first so the real layer has state to report; the mock
 * ignores the write and answers with its constants either way, which is
 * exactly the divergence the parity assertion is looking for.
 */
const CASES: ReadonlyArray<Case> = [
  {
    name: "getBalance",
    decode: Schema.decodeUnknownSync(GetBalanceOutput),
    run: (chain: Service) => chain.getBalance({ address: VITALIK })
  },
  {
    name: "readContract",
    decode: Schema.decodeUnknownSync(ReadContractOutput),
    run: (chain: Service) =>
      chain.readContract({ address: USDC, abi: BALANCE_OF, functionName: "balanceOf", args: [VITALIK] })
  },
  {
    name: "call",
    decode: Schema.decodeUnknownSync(CallOutput),
    run: (chain: Service) => chain.call({ to: USDC, data: BALANCE_OF_VITALIK })
  },
  {
    name: "setAccount",
    decode: Schema.decodeUnknownSync(SetAccountOutput),
    run: (chain: Service) => chain.setAccount({ address: SINK, balance: "5000000000000000000", nonce: 3 })
  },
  {
    name: "mine",
    decode: Schema.decodeUnknownSync(MineOutput),
    run: (chain: Service) => chain.mine({ blocks: 2 })
  },
  {
    name: "simulate",
    decode: Schema.decodeUnknownSync(SimulateOutput),
    run: (chain: Service) =>
      Effect.flatMap(
        chain.setAccount({ address: VITALIK, balance: "100000000000000000000" }),
        () => chain.simulate({ calls: [{ to: SINK, data: "0x", from: VITALIK, value: "1000000000000000000" }] })
      )
  },
  {
    name: "getBlock",
    decode: Schema.decodeUnknownSync(GetBlockOutput),
    run: (chain: Service) => chain.getBlock({})
  }
]

/**
 * The shape of a value: its keys, recursively, with every leaf replaced by its
 * type name.
 *
 * Comparing shapes rather than values is the point. Two layers cannot agree on
 * a balance, and they must agree on every key and every key's type.
 */
const shapeOf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])]
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])])
    )
  }
  return typeof value
}

/** Builds the service a layer provides, so a test can call it directly. */
const serviceOf = (layer: Layer.Layer<Tevm>): Promise<Service> =>
  Effect.runPromise(Effect.provide(Effect.map(Tevm, (chain) => chain), layer))

// ---------------------------------------------------------------------------
// Parity: no network
// ---------------------------------------------------------------------------

describe("layerMock", () => {
  const mock = makeMock()

  test("every binding decodes as its declared output schema", async () => {
    for (const item of CASES) {
      const output = await Effect.runPromise(item.run(mock))
      expect(() => item.decode(output), item.name).not.toThrow()
    }
  })

  test("fork decodes as ForkOutput", async () => {
    const output = await Effect.runPromise(mock.fork({ rpcUrl: "https://example.invalid" }))
    expect(() => Schema.decodeUnknownSync(ForkOutput)(output)).not.toThrow()
    expect(output.chainId).toBe(1)
  })

  test("wei and ether are strings, never numbers", async () => {
    const balance = await Effect.runPromise(mock.getBalance({ address: VITALIK }))
    expect(typeof balance.wei).toBe("string")
    expect(typeof balance.ether).toBe("string")
    expect(BigInt(balance.wei)).toBeGreaterThan(0n)
  })

  test("mine returns one block number per block asked for", async () => {
    const mined = await Effect.runPromise(mock.mine({ blocks: 3 }))
    expect(mined.blockNumbers).toHaveLength(3)
    for (const number of mined.blockNumbers) expect(number).toMatch(/^\d+$/)
  })

  test("simulate reports one result per call", async () => {
    const simulated = await Effect.runPromise(
      mock.simulate({ calls: [{ to: SINK, data: "0x", from: VITALIK }, { to: SINK, data: "0x" }] })
    )
    expect(simulated.results).toHaveLength(2)
    expect(simulated.balanceChanges).toHaveLength(1)
  })
})

describe("layerTevm without a fork", () => {
  test("a binding called before tevm/fork fails with a message naming it", async () => {
    const chain = await serviceOf(layerTevm({}))
    const failure = await Effect.runPromise(Effect.flip(chain.getBalance({ address: VITALIK })))
    expect(failure._tag).toBe("aomi/tools/TevmError")
    expect(failure.message).toContain("tevm/fork")
  })

  test("building the layer does not open a connection", async () => {
    // The mock layer threw on construction before milestone 3. The real one
    // must not: the Worker builds it per session, long before a cell calls it.
    await expect(serviceOf(layerTevm({ rpcUrl: "https://example.invalid" }))).resolves.toBeDefined()
  })

  test("an unusable rpcUrl fails as a TevmError, not as a defect", async () => {
    const chain = await serviceOf(layerTevm({ rpcUrl: "https://127.0.0.1:1/not-a-node" }))
    const failure = await Effect.runPromise(Effect.flip(chain.getBlock({})))
    expect(failure._tag).toBe("aomi/tools/TevmError")
    expect(failure.message).toContain("getBlock failed")
  })

  test("a blockTag that is neither a number nor a known tag is rejected", async () => {
    const chain = await serviceOf(layerTevm({ rpcUrl: "https://example.invalid" }))
    const failure = await Effect.runPromise(Effect.flip(chain.getBalance({ address: VITALIK, blockTag: "yesterday" })))
    expect(failure.message).toContain("yesterday")
    expect(failure.message).toContain("finalized")
  })
})

// ---------------------------------------------------------------------------
// The real client, against a fork
// ---------------------------------------------------------------------------

const RPC_URL = process.env["TEVM_FORK_RPC_URL"]

if (RPC_URL === undefined) {
  describe.skip("layerTevm against a mainnet fork", () => {
    test("set TEVM_FORK_RPC_URL to a mainnet JSON-RPC endpoint to run this suite", () => {})
  })
} else {
  describe("layerTevm against a mainnet fork", () => {
    let chain: Service

    beforeAll(async () => {
      chain = await serviceOf(layerTevm({ rpcUrl: RPC_URL, blockTag: process.env["TEVM_FORK_BLOCK"] }))
      // Open the fork once. Every later test reads the same in-memory chain,
      // so the suite costs one fork rather than one per test.
      await Effect.runPromise(chain.fork({ rpcUrl: RPC_URL, blockTag: process.env["TEVM_FORK_BLOCK"] }))
    }, 120_000)

    test("fork reports the chain it connected to", async () => {
      const forked = await Effect.runPromise(chain.fork({ rpcUrl: RPC_URL, blockTag: process.env["TEVM_FORK_BLOCK"] }))
      expect(() => Schema.decodeUnknownSync(ForkOutput)(forked)).not.toThrow()
      expect(forked.chainId).toBe(1)
      expect(forked.blockNumber).toMatch(/^\d+$/)
      expect(BigInt(forked.blockNumber)).toBeGreaterThan(20_000_000n)
      expect(forked.blockHash).toMatch(/^0x[0-9a-f]{64}$/)
    })

    test("getBalance reads real state", async () => {
      const balance = await Effect.runPromise(chain.getBalance({ address: VITALIK }))
      expect(balance.address).toBe(VITALIK)
      expect(BigInt(balance.wei)).toBeGreaterThan(0n)
      expect(Number(balance.ether)).toBeGreaterThan(0)
    })

    test("readContract decodes a uint256 through a human-readable abi", async () => {
      const read = await Effect.runPromise(
        chain.readContract({ address: USDC, abi: BALANCE_OF, functionName: "balanceOf", args: [VITALIK] })
      )
      expect(read.value).toMatch(/^\d+$/)
      expect(read.raw).toMatch(/^0x[0-9a-f]{64}$/)
      // The decoded value and the raw word are two renderings of one number.
      expect(BigInt(read.raw)).toBe(BigInt(read.value))
    })

    test("readContract rejects a function the abi does not declare", async () => {
      const failure = await Effect.runPromise(
        Effect.flip(chain.readContract({ address: USDC, abi: BALANCE_OF, functionName: "totalSupply" }))
      )
      expect(failure.message).toContain("totalSupply")
    })

    test("call runs raw calldata and reports gas", async () => {
      const result = await Effect.runPromise(chain.call({ to: USDC, data: BALANCE_OF_VITALIK }))
      expect(result.reverted).toBe(false)
      expect(result.data).toMatch(/^0x[0-9a-f]{64}$/)
      expect(BigInt(result.gasUsed)).toBeGreaterThan(21_000n)
    })

    test("a reverting call reports the reason instead of failing", async () => {
      // Deploy code that reverts with Error("nope"), then call it.
      const reverter = "0x2222222222222222222222222222222222222222"
      const reason =
        "08c379a0" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000004" +
        "6e6f706500000000000000000000000000000000000000000000000000000000"
      const size = (reason.length / 2).toString(16).padStart(2, "0")
      // PUSH1 size; PUSH1 0x0a; PUSH0; CODECOPY; PUSH1 size; PUSH0; REVERT
      await Effect.runPromise(chain.setAccount({ address: reverter, code: `0x60${size}600a5f3960${size}5ffd${reason}` }))
      const result = await Effect.runPromise(chain.call({ to: reverter, data: "0x" }))
      expect(result.reverted).toBe(true)
      expect(result.revertReason).toBe("nope")
    })

    test("setAccount writes a balance and a nonce, and reads them back", async () => {
      const set = await Effect.runPromise(
        chain.setAccount({ address: SINK, balance: "5000000000000000000", nonce: 3 })
      )
      expect(set).toEqual({ address: SINK, balance: "5000000000000000000", nonce: 3 })
      const balance = await Effect.runPromise(chain.getBalance({ address: SINK }))
      expect(balance.wei).toBe("5000000000000000000")
    })

    test("mine advances the chain by one block number per block", async () => {
      const before = await Effect.runPromise(chain.getBlock({}))
      const mined = await Effect.runPromise(chain.mine({ blocks: 2 }))
      expect(mined.blockNumbers).toHaveLength(2)
      expect(BigInt(mined.blockNumbers[0]!)).toBe(BigInt(before.number) + 1n)
      expect(BigInt(mined.blockNumbers[1]!)).toBe(BigInt(before.number) + 2n)
      const after = await Effect.runPromise(chain.getBlock({}))
      expect(after.number).toBe(mined.blockNumbers[1])
    })

    test("simulate reports balance changes and commits nothing", async () => {
      await Effect.runPromise(chain.setAccount({ address: VITALIK, balance: "100000000000000000000" }))
      const simulated = await Effect.runPromise(
        chain.simulate({
          calls: [
            { to: SINK, data: "0x", from: VITALIK, value: "1000000000000000000" },
            { to: SINK, data: "0x", from: VITALIK, value: "2000000000000000000" }
          ]
        })
      )
      expect(simulated.results).toHaveLength(2)
      for (const result of simulated.results) expect(result.reverted).toBe(false)
      expect(simulated.balanceChanges).toHaveLength(1)
      const [change] = simulated.balanceChanges
      expect(change!.address).toBe(VITALIK)
      // Three ether left, plus gas, so the sender is strictly poorer.
      expect(BigInt(change!.after)).toBeLessThan(BigInt(change!.before))
      // Nothing was committed: the sink still holds what setAccount gave it,
      // and mining afterwards does not release the simulated transfers.
      const sink = await Effect.runPromise(chain.getBalance({ address: SINK }))
      expect(sink.wei).toBe("5000000000000000000")
      await Effect.runPromise(chain.mine({}))
      const afterMine = await Effect.runPromise(chain.getBalance({ address: SINK }))
      expect(afterMine.wei).toBe("5000000000000000000")
    })

    test("getBlock reports a full header", async () => {
      const block = await Effect.runPromise(chain.getBlock({}))
      expect(() => Schema.decodeUnknownSync(GetBlockOutput)(block)).not.toThrow()
      expect(block.hash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(block.parentHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(BigInt(block.timestamp)).toBeGreaterThan(1_700_000_000n)
      expect(BigInt(block.gasLimit)).toBeGreaterThan(0n)
      expect(BigInt(block.baseFeePerGas)).toBeGreaterThanOrEqual(0n)
    })

    test("getBlock accepts a decimal block number", async () => {
      const latest = await Effect.runPromise(chain.getBlock({}))
      const earlier = (BigInt(latest.number) - 1n).toString()
      const block = await Effect.runPromise(chain.getBlock({ blockTag: earlier }))
      expect(block.number).toBe(earlier)
      expect(block.hash).toBe(latest.parentHash)
    })

    test("every binding returns the shape the mock returns", async () => {
      const mock = makeMock()
      for (const item of CASES) {
        const real = await Effect.runPromise(item.run(chain))
        const fake = await Effect.runPromise(item.run(mock))
        expect(shapeOf(real), item.name).toEqual(shapeOf(fake))
        expect(() => item.decode(real), item.name).not.toThrow()
      }
    })
  })
}
