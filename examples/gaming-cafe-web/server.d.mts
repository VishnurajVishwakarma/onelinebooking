import type { Server } from "node:http";

export function createGamingCafeApp(config: {
  apiBaseUrl: string;
  apiKey: string;
  tenantId?: string;
  webhookSecret?: string;
}): Server;

