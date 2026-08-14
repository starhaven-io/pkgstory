export const env: Record<string, unknown> = {};

export function resetCloudflareEnv(): void {
  for (const key of Object.keys(env)) delete env[key];
}
