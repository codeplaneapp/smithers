{
  # The toolchain the root BUILD.ts pins, as one Nix closure.
  #
  # `Smithers.Nix.Environment({ flake: Smithers.file("//flake.nix") })` in a
  # BUILD.ts makes smithers build resolve every tool from this shell and key
  # every spawning target on the shell's store hash. The declared runtime and
  # package-manager versions in BUILD.ts are asserted against what this shell
  # provides, so a pin here and a pin there cannot drift apart silently.
  #
  # Rust comes from `rust-toolchain.toml` through rust-overlay, so the crates
  # build with the same channel, profile, components, and targets rustup would
  # install. `flake.lock` pins nixpkgs and the overlay; regenerate it with
  # `nix flake update` and rebuild the wasm artifact when the Rust channel
  # moves (see rust-toolchain.toml).
  description = "smithers toolchain";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; }));
      # pnpm at exactly the version `packageManager` in package.json and the
      # root BUILD.ts declare. nixpkgs carries a moving pnpm; a build tool that
      # asserts an exact version needs the tarball npm publishes, not a
      # channel's latest.
      pnpmPinned = pkgs: pkgs.stdenvNoCC.mkDerivation rec {
        pname = "pnpm";
        version = "11.21.0";
        src = pkgs.fetchurl {
          url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
          hash = "sha256-hyN9N+rbedxiagV26zpS0j1wQiwyOuXgD8BckfQyN4A=";
        };
        nativeBuildInputs = [ pkgs.nodejs_22 ];
        dontBuild = true;
        installPhase = ''
          mkdir -p $out/lib/pnpm $out/bin
          cp -r . $out/lib/pnpm
          chmod +x $out/lib/pnpm/bin/pnpm.cjs $out/lib/pnpm/bin/pnpx.cjs
          ln -s $out/lib/pnpm/bin/pnpm.cjs $out/bin/pnpm
          ln -s $out/lib/pnpm/bin/pnpx.cjs $out/bin/pnpx
        '';
      };
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            (pnpmPinned pkgs)
            pkgs.bun
            pkgs.jujutsu
            pkgs.ripgrep
            pkgs.git
            pkgs.cacert
            (pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml)
          ];
        };
      });
    };
}
