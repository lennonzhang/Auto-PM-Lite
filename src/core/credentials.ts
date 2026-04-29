export function sanitizeEnvKey(accountId: string): string {
  const normalized = accountId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `AUTO_PM_KEY_${normalized || "ACCOUNT"}`;
}
