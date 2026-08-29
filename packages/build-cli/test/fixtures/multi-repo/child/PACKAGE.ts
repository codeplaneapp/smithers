import { Smithers as S } from "@smthrs/targets"

export const Package = S.Package({
  targets: {
    test: S.Shell.Test({
      bin: S.Runtime.bin,
      args: [
        "-e",
        "import('node:fs').then(fs => { const text = fs.readFileSync('README.md', 'utf8'); " +
        "if (!text.includes('child workspace root')) process.exit(2); console.log('child repository echo') })"
      ],
      data: [S.file("//README.md")]
    }),
    files: S.Filegroup({ srcs: [S.file("//README.md")] })
  }
})
