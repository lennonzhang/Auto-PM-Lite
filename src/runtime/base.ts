import type { Account, AppConfig, Policy, Profile } from "../core/types.js";
import { sanitizeEnvKey } from "../core/credentials.js";
import { EnvSecretBackend, type SecretBackend } from "../orchestrator/secrets.js";

export interface RuntimeDependencies {
  config: AppConfig;
  configPath?: string | undefined;
  secretBackend?: SecretBackend;
}

export abstract class BaseRuntimeAdapter {
  protected readonly secretBackend: SecretBackend;

  constructor(protected readonly deps: RuntimeDependencies) {
    this.secretBackend = deps.secretBackend ?? new EnvSecretBackend();
  }

  protected getProfile(profileId: string): Profile {
    const profile = this.deps.config.profiles[profileId];
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    return profile;
  }

  protected getAccount(accountId: string): Account {
    const account = this.deps.config.accounts[accountId];
    if (!account) {
      throw new Error(`Unknown account: ${accountId}`);
    }

    return account;
  }

  protected getPolicy(policyId: string): Policy {
    const policy = this.deps.config.policies[policyId];
    if (!policy) {
      throw new Error(`Unknown policy: ${policyId}`);
    }

    return policy;
  }

  protected getConfigPath(): string {
    if (!this.deps.configPath) {
      throw new Error("Runtime adapter requires configPath for this operation");
    }

    return this.deps.configPath;
  }

  protected async resolveSecretEnv(account: Account): Promise<Record<string, string>> {
    const secret = await this.secretBackend.resolve(account.secretRef);
    return {
      [sanitizeEnvKey(account.id)]: secret,
    };
  }
}
