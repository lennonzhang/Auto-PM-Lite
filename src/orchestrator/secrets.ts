export interface SecretBackend {
  resolve(ref: string): Promise<string>;
}

export class EnvSecretBackend implements SecretBackend {
  async resolve(ref: string): Promise<string> {
    if (!ref.startsWith("env:")) {
      throw new Error(`Unsupported secret ref: ${ref}`);
    }

    const envName = ref.slice(4);
    const value = process.env[envName];
    if (!value) {
      throw new Error(`Missing environment variable: ${envName}`);
    }

    return value;
  }
}
