declare const runtimeInfo: {
  /** Electron version, e.g. "44.5.1". */
  version: string;
  /** Release asset file name → SHA-256 hex. */
  checksums: Record<string, string>;
};
export = runtimeInfo;
