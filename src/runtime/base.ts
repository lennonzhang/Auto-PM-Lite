import type { Account, AppConfig, Policy, Profile } from "../core/types.js";
import { redactText } from "../core/redaction.js";
import { EnvSecretBackend, isLocalSecretRef, sourceEnvAuthMode, type SecretBackend } from "../orchestrator/secrets.js";
import { buildRuntimeEnv } from "./env.js";

export interface RuntimeDependencies {
  config: AppConfig;
  configPath?: string | undefined;
  secretBackend?: SecretBackend;
  sourceEnv?: NodeJS.ProcessEnv | undefined;
  runtimeLog?: ((message: string) => void | Promise<void>) | undefined;
}

export abstract class BaseRuntimeAdapter {
  protected readonly secretBackend: SecretBackend;

  constructor(protected readonly deps: RuntimeDependencies) {
    this.secretBackend = deps.secretBackend ?? new EnvSecretBackend(deps.sourceEnv);
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

  protected async resolveSecretEnv(account: Account, runtime: Profile["runtime"]): Promise<Record<string, string>> {
    if (isLocalSecretRef(account.secretRef, runtime) || sourceEnvAuthMode(this.deps.sourceEnv, runtime) === "local") {
      this.writeRuntimeLog(`runtime.local_auth runtime=${runtime} account=${account.id} secretRef=${account.secretRef}`);
      return buildRuntimeEnv({
        runtime,
        account,
        sourceEnv: this.deps.sourceEnv,
        authMode: "local",
      });
    }

    const secret = await this.secretBackend.resolve(account.secretRef);
    this.writeRuntimeLog(`runtime.secret_resolved runtime=${runtime} account=${account.id} secretRef=${account.secretRef}`);
    return buildRuntimeEnv({
      runtime,
      account,
      secret,
      sourceEnv: this.deps.sourceEnv,
    });
  }

  protected writeRuntimeLog(message: string): void {
    if (!this.deps.runtimeLog) {
      return;
    }
    const redacted = redactText(message, { additionalPatterns: this.deps.config.redaction.additionalPatterns });
    void Promise.resolve(this.deps.runtimeLog(redacted)).catch(() => {});
  }
}
