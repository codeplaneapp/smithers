# Third-party notices for @smthrs/jj

This distribution contains third-party software. The notices below are
reproduced to satisfy the terms of the licenses those components are
distributed under. They are in addition to, and do not replace, this
package's own `LICENSE` (MIT).

`wasm/flows_jj.wasm` is a `wasm32-wasip1` reactor module built from
`crates/flows-jj` (`cargo build --release --target wasm32-wasip1 --package
flows-jj`). That crate statically links `jj-lib` — vendored as the
`vendor/jj` git submodule (a fork of Jujutsu pinned via `.gitmodules`) — and
every crate in `jj-lib`'s and `flows-jj`'s Rust dependency closure. This
file enumerates that closure, resolved from the repo's `Cargo.lock` with
`cargo metadata` / `cargo tree -e normal,build --target wasm32-wasip1
--package flows-jj`, and groups it by license. Dev-only dependencies (for
example the `tempfile` edge that comes from `flows-jj`'s own
`[dev-dependencies]`, used only by its native `cargo test` binaries) are
excluded because `cargo build --release` never compiles them into the wasm
artifact; `tempfile` still appears below because `jj-lib` itself also
depends on it as a normal (non-dev) dependency. Proc-macro crates are
included because they compile into code that is generated into, and shipped
as part of, the artifact.

## jj-lib (Apache-2.0)

- Upstream repository: <https://github.com/jj-vcs/jj>
- Vendored fork: `git@github.com:smithersai/jj.git`, branch `flows-wasm`
  (see `.gitmodules`), checked out as the `vendor/jj` git submodule
- Crates: `jj-lib` and `jj-lib-proc-macros`, both at `vendor/jj/lib`
  (see `crates/flows-jj/Cargo.toml`)
- Version statically linked into `wasm/flows_jj.wasm`: 0.44.0
- Copyright 2020–2026 The Jujutsu Authors (per-file copyright headers
  throughout `vendor/jj/lib/src`; `vendor/jj/AUTHORS` additionally credits
  Google LLC as a significant contributor)
- `vendor/jj` ships no separate `NOTICE` file; there is no attribution
  content beyond the per-file copyright headers and the Apache License 2.0
  text below.

jj-lib and jj-lib-proc-macros are distributed under the Apache License,
Version 2.0. Apache-2.0 §4(a) requires that any redistribution of the Work
give recipients a copy of the License; the full text is reproduced below.

## Apache License, Version 2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## All statically linked crates, by license

### Apache-2.0 (no alternate license offered)

jj-lib and jj-lib-proc-macros are covered by the Apache License 2.0 text
above; `prost`, `prost-derive`, and `unicode-bom` are separate crates in the
dependency closure that are also Apache-2.0–only.

| Crate                | Version | Copyright                                                                                                                                     | Repository                                 |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `jj-lib`             | 0.44.0  | (see repository)                                                                                                                              | <https://github.com/jj-vcs/jj>             |
| `jj-lib-proc-macros` | 0.44.0  | (see repository)                                                                                                                              | <https://github.com/jj-vcs/jj>             |
| `prost`              | 0.14.4  | Dan Burkert <dan@danburkert.com>; Lucio Franco <luciofranco14@gmail.com>; Casper Meijn <casper@meijn.net>; Tokio Contributors <team@tokio.rs> | <https://github.com/tokio-rs/prost>        |
| `prost-derive`       | 0.14.4  | Dan Burkert <dan@danburkert.com>; Lucio Franco <luciofranco14@gmail.com>; Casper Meijn <casper@meijn.net>; Tokio Contributors <team@tokio.rs> | <https://github.com/tokio-rs/prost>        |
| `unicode-bom`        | 2.0.3   | Phil Booth <pmbooth@gmail.com>                                                                                                                | <https://gitlab.com/philbooth/unicode-bom> |

### MIT OR Apache-2.0 (dual-licensed)

This project distributes `wasm/flows_jj.wasm` under the terms of MIT for
every crate below (this package's own `LICENSE` is MIT, and MIT text is
reproduced in the root `THIRD_PARTY_NOTICES.md`).

| Crate              | Version            | Copyright                                                                                                                                  | Repository                                            |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `allocator-api2`   | 0.2.21             | Zakarum <zaq.dev@icloud.com>                                                                                                               | <https://github.com/zakarumych/allocator-api2>        |
| `anyhow`           | 1.0.104            | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/anyhow>                   |
| `async-trait`      | 0.1.92             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/async-trait>              |
| `autocfg`          | 1.5.1              | Josh Stone <cuviper@gmail.com>                                                                                                             | <https://github.com/cuviper/autocfg>                  |
| `beef`             | 0.5.2              | Maciej Hirsz <hello@maciej.codes>                                                                                                          | <https://github.com/maciejhirsz/beef>                 |
| `bitflags`         | 2.13.1             | The Rust Project Developers                                                                                                                | <https://github.com/bitflags/bitflags>                |
| `blake2`           | 0.10.6             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/hashes>                |
| `block-buffer`     | 0.10.4             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/utils>                 |
| `bstr`             | 1.13.1             | Andrew Gallant <jamslam@gmail.com>                                                                                                         | <https://github.com/BurntSushi/bstr>                  |
| `cfg-if`           | 1.0.4              | Alex Crichton <alex@alexcrichton.com>                                                                                                      | <https://github.com/rust-lang/cfg-if>                 |
| `chacha20`         | 0.10.1             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/stream-ciphers>        |
| `chrono`           | 0.4.45             | (see repository)                                                                                                                           | <https://github.com/chronotope/chrono>                |
| `crossbeam-deque`  | 0.8.7              | (see repository)                                                                                                                           | <https://github.com/crossbeam-rs/crossbeam>           |
| `crossbeam-epoch`  | 0.9.20             | (see repository)                                                                                                                           | <https://github.com/crossbeam-rs/crossbeam>           |
| `crossbeam-utils`  | 0.8.22             | (see repository)                                                                                                                           | <https://github.com/crossbeam-rs/crossbeam>           |
| `crypto-common`    | 0.1.7              | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/traits>                |
| `digest`           | 0.10.7             | RustCrypto Developers                                                                                                                      | <https://github.com/RustCrypto/traits>                |
| `either`           | 1.17.0             | (see repository)                                                                                                                           | <https://github.com/rayon-rs/either>                  |
| `equivalent`       | 1.0.2              | (see repository)                                                                                                                           | <https://github.com/indexmap-rs/equivalent>           |
| `errno`            | 0.3.14             | Chris Wong <lambda.fairy@gmail.com>; Dan Gohman <dev@sunfishcode.online>                                                                   | <https://github.com/lambda-fairy/rust-errno>          |
| `etcetera`         | 0.11.0             | (see repository)                                                                                                                           | <https://github.com/lunacookies/etcetera>             |
| `fastrand`         | 2.5.0              | Stjepan Glavina <stjepang@gmail.com>                                                                                                       | <https://github.com/smol-rs/fastrand>                 |
| `fnv`              | 1.0.7              | Alex Crichton <alex@alexcrichton.com>                                                                                                      | <https://github.com/servo/rust-fnv>                   |
| `futures`          | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-channel`  | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-core`     | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-executor` | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-io`       | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-macro`    | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-sink`     | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-task`     | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `futures-util`     | 0.3.33             | (see repository)                                                                                                                           | <https://github.com/rust-lang/futures-rs>             |
| `getrandom`        | 0.4.3              | The Rand Project Developers                                                                                                                | <https://github.com/rust-random/getrandom>            |
| `gix-features`     | 0.48.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-glob`         | 0.26.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-ignore`       | 0.21.1             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-path`         | 0.12.4             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-trace`        | 0.1.21             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `gix-validate`     | 0.11.3             | Sebastian Thiel <sebastian.thiel@icloud.com>                                                                                               | <https://github.com/GitoxideLabs/gitoxide>            |
| `hashbrown`        | 0.16.1             | Amanieu d'Antras <amanieu@gmail.com>                                                                                                       | <https://github.com/rust-lang/hashbrown>              |
| `hashbrown`        | 0.17.1             | (see repository)                                                                                                                           | <https://github.com/rust-lang/hashbrown>              |
| `indexmap`         | 2.14.0             | (see repository)                                                                                                                           | <https://github.com/indexmap-rs/indexmap>             |
| `itertools`        | 0.14.0             | bluss                                                                                                                                      | <https://github.com/rust-itertools/itertools>         |
| `itertools`        | 0.15.0             | bluss                                                                                                                                      | <https://github.com/rust-itertools/itertools>         |
| `itoa`             | 1.0.18             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/itoa>                     |
| `lazy_static`      | 1.5.0              | Marvin Löbel <loebel.marvin@gmail.com>                                                                                                     | <https://github.com/rust-lang-nursery/lazy-static.rs> |
| `libc`             | 0.2.189            | (see repository)                                                                                                                           | <https://github.com/rust-lang/libc>                   |
| `log`              | 0.4.33             | The Rust Project Developers                                                                                                                | <https://github.com/rust-lang/log>                    |
| `logos`            | 0.15.1             | Maciej Hirsz <hello@maciej.codes>; Jérome Eertmans (maintainer) <jeertmans@icloud.com>                                                     | <https://github.com/maciejhirsz/logos>                |
| `logos-codegen`    | 0.15.1             | Maciej Hirsz <hello@maciej.codes>; Jérome Eertmans (maintainer) <jeertmans@icloud.com>                                                     | <https://github.com/maciejhirsz/logos>                |
| `logos-derive`     | 0.15.1             | Maciej Hirsz <hello@maciej.codes>; Jérome Eertmans (maintainer) <jeertmans@icloud.com>                                                     | <https://github.com/maciejhirsz/logos>                |
| `maplit`           | 1.0.2              | bluss                                                                                                                                      | <https://github.com/bluss/maplit>                     |
| `num-traits`       | 0.2.19             | The Rust Project Developers                                                                                                                | <https://github.com/rust-num/num-traits>              |
| `once_cell`        | 1.21.4             | Aleksey Kladov <aleksey.kladov@gmail.com>                                                                                                  | <https://github.com/matklad/once_cell>                |
| `pest`             | 2.8.8              | Dragoș Tiselice <dragostiselice@gmail.com>                                                                                                 | <https://github.com/pest-parser/pest>                 |
| `pest_derive`      | 2.8.8              | Dragoș Tiselice <dragostiselice@gmail.com>                                                                                                 | <https://github.com/pest-parser/pest>                 |
| `pest_generator`   | 2.8.8              | Dragoș Tiselice <dragostiselice@gmail.com>                                                                                                 | <https://github.com/pest-parser/pest>                 |
| `pest_meta`        | 2.8.8              | Dragoș Tiselice <dragostiselice@gmail.com>                                                                                                 | <https://github.com/pest-parser/pest>                 |
| `pin-project-lite` | 0.2.17             | (see repository)                                                                                                                           | <https://github.com/taiki-e/pin-project-lite>         |
| `pollster`         | 1.0.1              | Joshua Barretto <joshua@jsbarretto.com>                                                                                                    | <https://github.com/zesterer/pollster>                |
| `ppv-lite86`       | 0.2.21             | The CryptoCorrosion Contributors                                                                                                           | <https://github.com/cryptocorrosion/cryptocorrosion>  |
| `proc-macro2`      | 1.0.107            | David Tolnay <dtolnay@gmail.com>; Alex Crichton <alex@alexcrichton.com>                                                                    | <https://github.com/dtolnay/proc-macro2>              |
| `quote`            | 1.0.47             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/quote>                    |
| `rand`             | 0.10.2             | The Rand Project Developers; The Rust Project Developers                                                                                   | <https://github.com/rust-random/rand>                 |
| `rand_chacha`      | 0.10.0             | The Rand Project Developers; The Rust Project Developers; The CryptoCorrosion Contributors                                                 | <https://github.com/rust-random/rand>                 |
| `rand_core`        | 0.10.1             | The Rand Project Developers                                                                                                                | <https://github.com/rust-random/rand_core>            |
| `rayon`            | 1.12.0             | (see repository)                                                                                                                           | <https://github.com/rayon-rs/rayon>                   |
| `rayon-core`       | 1.13.0             | (see repository)                                                                                                                           | <https://github.com/rayon-rs/rayon>                   |
| `ref-cast`         | 1.0.26             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/ref-cast>                 |
| `ref-cast-impl`    | 1.0.26             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/ref-cast>                 |
| `regex`            | 1.13.1             | The Rust Project Developers; Andrew Gallant <jamslam@gmail.com>                                                                            | <https://github.com/rust-lang/regex>                  |
| `regex-automata`   | 0.4.18             | The Rust Project Developers; Andrew Gallant <jamslam@gmail.com>                                                                            | <https://github.com/rust-lang/regex>                  |
| `regex-syntax`     | 0.8.11             | The Rust Project Developers; Andrew Gallant <jamslam@gmail.com>                                                                            | <https://github.com/rust-lang/regex>                  |
| `rustc_version`    | 0.4.1              | (see repository)                                                                                                                           | <https://github.com/djc/rustc-version-rs>             |
| `semver`           | 1.0.28             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/semver>                   |
| `serde`            | 1.0.229            | Erick Tryzelaar <erick.tryzelaar@gmail.com>; David Tolnay <dtolnay@gmail.com>                                                              | <https://github.com/serde-rs/serde>                   |
| `serde_core`       | 1.0.229            | Erick Tryzelaar <erick.tryzelaar@gmail.com>; David Tolnay <dtolnay@gmail.com>                                                              | <https://github.com/serde-rs/serde>                   |
| `serde_derive`     | 1.0.229            | Erick Tryzelaar <erick.tryzelaar@gmail.com>; David Tolnay <dtolnay@gmail.com>                                                              | <https://github.com/serde-rs/serde>                   |
| `serde_json`       | 1.0.151            | Erick Tryzelaar <erick.tryzelaar@gmail.com>; David Tolnay <dtolnay@gmail.com>                                                              | <https://github.com/serde-rs/json>                    |
| `serde_spanned`    | 1.1.1              | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `smallvec`         | 1.15.2             | The Servo Project Developers                                                                                                               | <https://github.com/servo/rust-smallvec>              |
| `syn`              | 2.0.119            | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/syn>                      |
| `syn`              | 3.0.3              | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/syn>                      |
| `tempfile`         | 3.27.0             | Steven Allen <steven@stebalien.com>; The Rust Project Developers; Ashley Mannix <ashleymannix@live.com.au>; Jason White <me@jasonwhite.io> | <https://github.com/Stebalien/tempfile>               |
| `thiserror`        | 2.0.20             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/thiserror>                |
| `thiserror-impl`   | 2.0.20             | David Tolnay <dtolnay@gmail.com>                                                                                                           | <https://github.com/dtolnay/thiserror>                |
| `toml_datetime`    | 1.1.1+spec-1.1.0   | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `toml_edit`        | 0.25.13+spec-1.1.0 | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `toml_parser`      | 1.1.3+spec-1.1.0   | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `toml_writer`      | 1.1.2+spec-1.1.0   | (see repository)                                                                                                                           | <https://github.com/toml-rs/toml>                     |
| `typenum`          | 1.20.1             | (see repository)                                                                                                                           | <https://github.com/paholg/typenum>                   |
| `ucd-trie`         | 0.1.7              | Andrew Gallant <jamslam@gmail.com>                                                                                                         | <https://github.com/BurntSushi/ucd-generate>          |
| `version_check`    | 0.9.5              | Sergio Benitez <sb@sergio.bz>                                                                                                              | <https://github.com/SergioBenitez/version_check>      |

### Unlicense OR MIT

| Crate          | Version | Copyright                                 | Repository                                                         |
| -------------- | ------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `aho-corasick` | 1.1.5   | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/aho-corasick>                       |
| `globset`      | 0.4.20  | Andrew Gallant <jamslam@gmail.com>        | <https://github.com/BurntSushi/ripgrep/tree/master/crates/globset> |
| `memchr`       | 2.8.3   | Andrew Gallant <jamslam@gmail.com>; bluss | <https://github.com/BurntSushi/memchr>                             |

### MIT

| Crate                | Version | Copyright                                                                                               | Repository                                     |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `bytes`              | 1.12.1  | Carl Lerche <me@carllerche.com>; Sean McArthur <sean@seanmonstar.com>                                   | <https://github.com/tokio-rs/bytes>            |
| `clru`               | 0.6.3   | marmeladema <xademax@gmail.com>                                                                         | <https://github.com/marmeladema/clru-rs>       |
| `generic-array`      | 0.14.7  | Bartłomiej Kamiński <fizyk20@gmail.com>; Aaron Trent <novacrazy@gmail.com>                              | <https://github.com/fizyk20/generic-array.git> |
| `interim`            | 0.2.1   | Conrad Ludgate <conradludgate@gmail.com>                                                                | <https://github.com/conradludgate/interim>     |
| `slab`               | 0.4.12  | Carl Lerche <me@carllerche.com>                                                                         | <https://github.com/tokio-rs/slab>             |
| `strsim`             | 0.11.1  | Danny Guo <danny@dannyguo.com>; maxbachmann <oss@maxbachmann.de>                                        | <https://github.com/rapidfuzz/strsim-rs>       |
| `tracing`            | 0.1.44  | Eliza Weisman <eliza@buoyant.io>; Tokio Contributors <team@tokio.rs>                                    | <https://github.com/tokio-rs/tracing>          |
| `tracing-attributes` | 0.1.31  | Tokio Contributors <team@tokio.rs>; Eliza Weisman <eliza@buoyant.io>; David Barsky <dbarsky@amazon.com> | <https://github.com/tokio-rs/tracing>          |
| `tracing-core`       | 0.1.36  | Tokio Contributors <team@tokio.rs>                                                                      | <https://github.com/tokio-rs/tracing>          |
| `winnow`             | 1.0.4   | (see repository)                                                                                        | <https://github.com/winnow-rs/winnow>          |
| `zmij`               | 1.0.23  | David Tolnay <dtolnay@gmail.com>                                                                        | <https://github.com/dtolnay/zmij>              |

### BSD-3-Clause

| Crate    | Version | Copyright                                                                                | Repository                                     |
| -------- | ------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `subtle` | 2.6.1   | Isis Lovecruft <isis@patternsinthevoid.net>; Henry de Valence <hdevalence@hdevalence.ca> | <https://github.com/dalek-cryptography/subtle> |

### Zlib

| Crate      | Version | Copyright                            | Repository                         |
| ---------- | ------- | ------------------------------------ | ---------------------------------- |
| `foldhash` | 0.2.0   | Orson Peters <orsonpeters@gmail.com> | <https://github.com/orlp/foldhash> |

### Combined or multi-option licenses

These crates offer more than two alternatives, or combine a permissive
license with an additional narrow grant. Each includes at least one option
(MIT, MIT-0, or plain Apache-2.0) that this project's own MIT distribution
already satisfies.

| Crate           | Version | Copyright                                                                | Repository                                   |
| --------------- | ------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `dunce`         | 1.0.5   | Kornel <kornel@geekhood.net>                                             | <https://gitlab.com/kornelski/dunce>         |
| `rustix`        | 1.1.4   | Dan Gohman <dev@sunfishcode.online>; Jakub Konka <kubkon@jakubkonka.com> | <https://github.com/bytecodealliance/rustix> |
| `unicode-ident` | 1.0.24  | David Tolnay <dtolnay@gmail.com>                                         | <https://github.com/dtolnay/unicode-ident>   |
| `zerocopy`      | 0.8.56  | (see repository)                                                         | <https://github.com/google/zerocopy>         |

- `unicode-ident` is additionally licensed under Unicode-3.0
  (<https://spdx.org/licenses/Unicode-3.0.html>) for its Unicode
  character-database tables.
- `rustix` offers `Apache-2.0 WITH LLVM-exception` as one of its options,
  in addition to plain `Apache-2.0` and `MIT`.
