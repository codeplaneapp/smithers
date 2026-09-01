import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as TestHost from "../../src/test/TestHost.ts"
import { runHostContract } from "./HostContract.ts"

runHostContract(
  "TestHost",
  TestHost.layer({
    files: {},
    commands: {
      "host-contract-exec": { stdout: "test-exec" },
      "host-contract-stream": { stdout: "test-stream" },
      "host-contract-options": { stdout: "test-options" },
      "host-contract-interrupt": { stdout: "" }
    }
  }),
  {
    fileSystem: {
      expected: "success",
      scratchPath: "/test-host-contract",
      unsupported: {
        chmod: "NotFound",
        chown: "NotFound",
        copy: "NotFound",
        copyFile: "NotFound",
        glob: "NotFound",
        link: "NotFound",
        makeTempDirectory: "NotFound",
        makeTempDirectoryScoped: "NotFound",
        makeTempFile: "NotFound",
        makeTempFileScoped: "NotFound",
        open: "NotFound",
        readLink: "NotFound",
        rename: "NotFound",
        sink: "NotFound",
        symlink: "NotFound",
        truncate: "NotFound",
        utimes: "NotFound",
        watch: "NotFound"
      }
    },
    path: { expected: "success" },
    childProcess: {
      expected: "success",
      execCommand: ChildProcess.make("host-contract-exec"),
      expectedStdout: "test-exec",
      streamCommand: ChildProcess.make("host-contract-stream"),
      expectedStreamText: "test-stream",
      optionsCommand: ChildProcess.make("host-contract-options", [], {
        cwd: "/",
        env: { HOST_CONTRACT_ENV: "test" }
      }),
      expectedOptionsStdout: "test-options",
      // The scripted interpreter runs a command line to completion; it has no
      // stdin to feed.
      stdin: { expected: "failure", code: "BadArgument" },
      interruptCommand: ChildProcess.make("host-contract-interrupt")
    },
    jj: { expected: "failure", code: "not_installed" },
    httpClient: { expected: "failure", code: "TransportError" }
  }
)
