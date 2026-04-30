export interface RateLimitConfig {
  requestsPerMinute?: number | undefined;
  requestsPerHour?: number | undefined;
  tokensPerMinute?: number | undefined;
}

export interface RateLimitCheck {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export interface RateLimiter {
  checkLimit(accountId: string, estimatedTokens?: number): Promise<RateLimitCheck>;
  recordRequest(accountId: string): void;
  recordUsage(accountId: string, tokens?: number): void;
}

export class NoOpRateLimiter implements RateLimiter {
  async checkLimit(_accountId: string, _estimatedTokens?: number): Promise<RateLimitCheck> {
    return { allowed: true };
  }

  recordRequest(_accountId: string): void {}

  recordUsage(_accountId: string, _tokens?: number): void {}
}

export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly config: RateLimitConfig) {}

  async checkLimit(accountId: string, estimatedTokens = 0): Promise<RateLimitCheck> {
    const bucket = this.getOrCreateBucket(accountId);
    return bucket.check(estimatedTokens);
  }

  recordRequest(accountId: string): void {
    const bucket = this.getOrCreateBucket(accountId);
    bucket.recordRequest();
  }

  recordUsage(accountId: string, tokens = 0): void {
    const bucket = this.getOrCreateBucket(accountId);
    bucket.recordUsage(tokens);
  }

  private getOrCreateBucket(accountId: string): TokenBucket {
    let bucket = this.buckets.get(accountId);
    if (!bucket) {
      bucket = new TokenBucket(this.config);
      this.buckets.set(accountId, bucket);
    }
    return bucket;
  }
}

class TokenBucket {
  private requestsInLastMinute: Array<{ ts: number }> = [];
  private requestsInLastHour: Array<{ ts: number }> = [];
  private tokenUsageInLastMinute: Array<{ ts: number; tokens: number }> = [];

  constructor(private readonly config: RateLimitConfig) {}

  check(estimatedTokens: number): RateLimitCheck {
    const now = Date.now();
    this.cleanup(now);

    if (this.config.requestsPerMinute) {
      const recentRequests = this.requestsInLastMinute.length;
      if (recentRequests >= this.config.requestsPerMinute) {
        const oldestRequest = this.requestsInLastMinute[0];
        const retryAfterMs = oldestRequest ? 60_000 - (now - oldestRequest.ts) : 60_000;
        return {
          allowed: false,
          retryAfterMs,
          reason: `Rate limit: ${recentRequests}/${this.config.requestsPerMinute} requests per minute`,
        };
      }
    }

    if (this.config.requestsPerHour) {
      const recentRequests = this.requestsInLastHour.length;
      if (recentRequests >= this.config.requestsPerHour) {
        const oldestRequest = this.requestsInLastHour[0];
        const retryAfterMs = oldestRequest ? 3_600_000 - (now - oldestRequest.ts) : 3_600_000;
        return {
          allowed: false,
          retryAfterMs,
          reason: `Rate limit: ${recentRequests}/${this.config.requestsPerHour} requests per hour`,
        };
      }
    }

    if (this.config.tokensPerMinute && estimatedTokens > 0) {
      const tokensInLastMinute = this.tokenUsageInLastMinute.reduce((sum, req) => sum + req.tokens, 0);
      if (tokensInLastMinute + estimatedTokens > this.config.tokensPerMinute) {
        const oldestRequest = this.requestsInLastMinute[0];
        const retryAfterMs = oldestRequest ? 60_000 - (now - oldestRequest.ts) : 60_000;
        return {
          allowed: false,
          retryAfterMs,
          reason: `Token rate limit: ${tokensInLastMinute + estimatedTokens}/${this.config.tokensPerMinute} tokens per minute`,
        };
      }
    }

    return { allowed: true };
  }

  recordRequest(): void {
    const now = Date.now();
    this.requestsInLastMinute.push({ ts: now });
    this.requestsInLastHour.push({ ts: now });
    this.cleanup(now);
  }

  recordUsage(tokens: number): void {
    const now = Date.now();
    this.tokenUsageInLastMinute.push({ ts: now, tokens });
    this.cleanup(now);
  }

  private cleanup(now: number): void {
    this.requestsInLastMinute = this.requestsInLastMinute.filter((req) => now - req.ts < 60_000);
    this.requestsInLastHour = this.requestsInLastHour.filter((req) => now - req.ts < 3_600_000);
    this.tokenUsageInLastMinute = this.tokenUsageInLastMinute.filter((req) => now - req.ts < 60_000);
  }
}
