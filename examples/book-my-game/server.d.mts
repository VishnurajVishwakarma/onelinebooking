import type { Server } from "node:http";

export function createBookMyGameApp(config: {
  apiBaseUrl: string;
  apiKey: string;
  tenantId?: string;
  webhookSecret?: string;
}): Server;

