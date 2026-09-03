| Namespace                   | Import                                      | What it is                                                                |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `RemoteChildProcessSpawner` | `@smthrs/sandbox/RemoteChildProcessSpawner` | Remote implementation of Effect's `ChildProcessSpawner`.                  |
| `ProviderConformance`       | `@smthrs/sandbox/ProviderConformance`       | The conformance suite a provider implementation must pass.                |
| `Sandbox`                   | `@smthrs/sandbox/Sandbox`                   | The provisioned-machine contract and its projections.                     |
| `SandboxConformance`        | `@smthrs/sandbox/SandboxConformance`        | The conformance suite a sandbox session provider must pass.               |
| `DirectorySandbox`          | `@smthrs/sandbox/DirectorySandbox`          | The scratch-directory sandbox provider.                                   |
| `ContainerSandbox`          | `@smthrs/sandbox/ContainerSandbox`          | The container-lifecycle sandbox provider, over a Docker-compatible CLI.   |
| `KubernetesSandbox`         | `@smthrs/sandbox/KubernetesSandbox`         | The Pod-per-session sandbox provider, over `kubectl`.                     |
| `JustBashSandbox`           | `@smthrs/sandbox/JustBashSandbox`           | The in-process interpreter sandbox provider, for hosts that cannot spawn. |
| `MicrosandboxSandbox`       | `@smthrs/sandbox/MicrosandboxSandbox`       | The Microsandbox microVM provider.                                        |
| `VercelSandbox`             | `@smthrs/sandbox/VercelSandbox`             | The Vercel Sandbox provider.                                              |
| `DaytonaSandbox`            | `@smthrs/sandbox/DaytonaSandbox`            | The Daytona sandbox provider.                                             |
| `AwsSandbox`                | `@smthrs/sandbox/AwsSandbox`                | The AWS ECS task provider.                                                |
| `CloudflareSandbox`         | `@smthrs/sandbox/CloudflareSandbox`         | The Cloudflare Durable Object provider.                                   |
| `SandboxHealth`             | `@smthrs/sandbox/SandboxHealth`             | Sandbox health-check contracts.                                           |
| `SandboxSupervision`        | `@smthrs/sandbox/SandboxSupervision`        | Heartbeat supervision over a remote sandbox session.                      |
