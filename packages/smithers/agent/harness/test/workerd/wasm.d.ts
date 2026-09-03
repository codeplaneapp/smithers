/**
 * What a bundler hands a worker for a `.wasm` import.
 *
 * Cloudflare's toolchain compiles the file and passes the `WebAssembly.Module`
 * through as the module's default export. Nothing in the package's own types
 * says so, because the shape depends on the bundler rather than on the package.
 */
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const wasmModule: WebAssembly.Module
  export default wasmModule
}
