export type StreamingProcessResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type GitRef = { name: string; objectId: string };

export type IsolatedCloneManifest = {
  version: 1;
  sourceCommit: string;
  dirtyPaths: string[];
  patch: { file: string; sha256: string };
  bundle: { file: string; sha256: string };
  freshImportVerified: true;
};

export type BundleHandoff = {
  patchPath: string;
  bundlePath: string;
  manifestPath: string;
  manifest: IsolatedCloneManifest;
};

export type IsolatedCloneCapsule = {
  path: string;
  commit: string;
  marker: {
    version: 1;
    nonce: string;
    source: string;
    commit: string;
    createdAt: string;
  };
  run(
    command: string,
    args?: string[],
    options?: { env?: Record<string, string | undefined> },
  ): Promise<StreamingProcessResult>;
  emitBundle(options: { outputDir: string; name?: string }): Promise<BundleHandoff>;
  cleanup(): Promise<void>;
};
