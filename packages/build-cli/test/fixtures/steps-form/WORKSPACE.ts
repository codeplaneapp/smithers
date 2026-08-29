import { Smithers as S } from "@smthrs/targets"

const rust = S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.91" })

export const Workspace = S.Workspace("steps-form-fixture", {
  repository: "git+https://example.invalid/steps-form-fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [rust]
})
