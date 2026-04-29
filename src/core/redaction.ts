export interface RedactionOptions {
  additionalPatterns?: string[];
}

const BUILTIN_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /Authorization\s*:\s*Bearer\s+[^\s"']+/gi,
  /x-api-key\s*[:=]\s*[^\s"']+/gi,
  /https?:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----\\n?"/g,
  /"client_email"\s*:\s*"[^"]+"/g,
  /"token_uri"\s*:\s*"https:\/\/oauth2\.googleapis\.com\/token"/g,
];

export function redactText(input: string, options: RedactionOptions = {}): string {
  let output = input;

  for (const pattern of BUILTIN_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }

  for (const pattern of options.additionalPatterns ?? []) {
    output = output.replace(new RegExp(pattern, "g"), "[REDACTED]");
  }

  return output;
}

export function redactJson<T>(value: T, options: RedactionOptions = {}): T {
  return JSON.parse(redactText(JSON.stringify(value), options)) as T;
}
