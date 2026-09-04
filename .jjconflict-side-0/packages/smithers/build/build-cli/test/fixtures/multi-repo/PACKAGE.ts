import { Smithers as S } from "@smthrs/targets"

const childTest = S.Repo.Target("child", "//:test")

export const Package = S.Package({
  targets: {
    childTest,
    suite: S.Suite({ tests: [childTest] }),
    alias: S.Alias(childTest),
    gated: S.Shell.Test({
      bin: S.Runtime.bin,
      args: ["-e", "console.log('parent gate consumer')"],
      gates: [childTest]
    }),
    parentReadme: S.Shell.Test({
      bin: S.Runtime.bin,
      args: [
        "-e",
        "import('node:fs').then(fs => { const text = fs.readFileSync('child/README.md', 'utf8'); " +
        "if (!text.includes('child workspace root')) process.exit(2) })"
      ],
      data: [S.file("child/README.md")]
    }),
    broken: S.Repo.Target("broken", "//:test")
  }
})
