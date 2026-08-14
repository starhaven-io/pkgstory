declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}

interface ExportedHandler<TEnv = unknown> {
  scheduled?: (
    controller: unknown,
    env: TEnv,
    context: { waitUntil(promise: Promise<unknown>): void },
  ) => void | Promise<void>;
}
