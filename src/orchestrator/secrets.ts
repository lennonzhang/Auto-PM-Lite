export interface SecretBackend {
  resolve(ref: string): Promise<string>;
}

export function isLocalSecretRef(ref: string, runtime?: "claude" | "codex"): boolean {
  const normalized = ref.trim().toLowerCase();
  return normalized === "local" || (runtime ? normalized === `local:${runtime}` : normalized.startsWith("local:"));
}

export function sourceEnvAuthMode(sourceEnv: NodeJS.ProcessEnv | undefined, runtime: "claude" | "codex"): "env" | "local" {
  const value = readEnv(sourceEnv ?? process.env, `${runtime.toUpperCase()}_AUTH_MODE`)?.trim().toLowerCase();
  return value === "local" ? "local" : "env";
}

export class EnvSecretBackend implements SecretBackend {
  constructor(private readonly sourceEnv: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: string): Promise<string> {
    if (!ref.startsWith("env:")) {
      throw new Error(`Unsupported secret ref: ${ref}`);
    }

    const envName = ref.slice(4);
    const value = readEnv(this.sourceEnv, envName);
    if (!value) {
      throw new Error(`Missing environment variable: ${envName}`);
    }

    return value;
  }
}

function readEnv(sourceEnv: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = sourceEnv[key];
  if (exact !== undefined) {
    return exact;
  }

  if (process.platform !== "win32") {
    return undefined;
  }

  const normalized = key.toUpperCase();
  const match = Object.keys(sourceEnv).find((candidate) => candidate.toUpperCase() === normalized);
  return match ? sourceEnv[match] : undefined;
}
