import type { Capability, Tenant } from "../domain/model.js";

export type OrganizationRole = "owner" | "admin" | "developer" | "viewer";
export type EnvironmentType = "test" | "live";

export type PlatformScope =
  | "tenants:read"
  | "tenants:write"
  | "facilities:read"
  | "facilities:write"
  | "availability:read"
  | "holds:read"
  | "holds:write"
  | "bookings:read"
  | "bookings:write"
  | "webhooks:read"
  | "webhooks:write"
  | "usage:read";

export const ALL_PLATFORM_SCOPES: readonly PlatformScope[] = [
  "tenants:read",
  "tenants:write",
  "facilities:read",
  "facilities:write",
  "availability:read",
  "holds:read",
  "holds:write",
  "bookings:read",
  "bookings:write",
  "webhooks:read",
  "webhooks:write",
  "usage:read",
];

export const READONLY_PLATFORM_SCOPES: readonly PlatformScope[] = [
  "tenants:read",
  "facilities:read",
  "availability:read",
  "holds:read",
  "bookings:read",
  "webhooks:read",
  "usage:read",
];

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  status: "active" | "invited" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Environment {
  id: string;
  organizationId: string;
  projectId: string;
  type: EnvironmentType;
  name: string;
  createdAt: string;
}

export interface PlatformTenant extends Tenant {
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentType: EnvironmentType;
}

export interface Location {
  id: string;
  tenantId: string;
  name: string;
  addressLine1?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
  timeZone: string;
  active: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ApiKeyStatus = "active" | "rotated" | "revoked";

export interface ApiKeySummary {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentType: EnvironmentType;
  tenantId: string | null;
  name: string;
  keyPrefix: string;
  scopes: PlatformScope[];
  status: ApiKeyStatus;
  rotatedFromKeyId: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface IssuedApiKey {
  apiKey: ApiKeySummary;
  /** Raw secret token shown ONLY once upon creation or rotation. Never persisted in plaintext. */
  token: string;
}

export interface AuthenticatedPrincipal {
  apiKeyId: string;
  keyPrefix: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentType: EnvironmentType;
  /** Bound tenant ID when credential belongs to a single tenant; null for environment-wide keys. */
  tenantId: string | null;
  scopes: PlatformScope[];
}

export interface WebhookEndpointSummary {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  tenantId: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  active: boolean;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedWebhookEndpoint {
  endpoint: WebhookEndpointSummary;
  /** HMAC signing secret returned ONLY at creation/secret-rotation time. */
  signingSecret: string;
}

export type WebhookDeliveryStatus = "pending" | "retrying" | "delivered" | "dead_letter";

export interface WebhookDeliveryRecord {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  tenantId: string;
  outboxEventId: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  deadLetteredAt: string | null;
  replayedCount: number;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type UsageMetric =
  | "api_request"
  | "hold_created"
  | "booking_confirmed"
  | "booking_cancelled"
  | "webhook_delivered";

export interface RecordUsageInput {
  organizationId: string;
  projectId: string;
  environmentId: string;
  tenantId?: string | null | undefined;
  metric: UsageMetric;
  quantity?: number | undefined;
  idempotencyKey: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface UsageSummaryRow {
  metric: UsageMetric;
  totalQuantity: number;
  recordCount: number;
}

export interface PlatformAuditLogEntry {
  id: string;
  organizationId: string;
  projectId: string | null;
  environmentId: string | null;
  tenantId: string | null;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  correlationId: string | null;
  recordedAt: string;
}

/**
 * Maps Phase 6 API credential scopes to internal V1 TenantBookingClient capabilities.
 */
export function mapScopesToCapabilities(scopes: readonly PlatformScope[]): Capability[] {
  const caps = new Set<Capability>();
  for (const scope of scopes) {
    switch (scope) {
      case "facilities:read":
        caps.add("facility:read");
        break;
      case "facilities:write":
        caps.add("facility:read");
        caps.add("facility:write");
        caps.add("schedule:write");
        caps.add("blackout:write");
        break;
      case "availability:read":
        caps.add("availability:read");
        caps.add("facility:read");
        break;
      case "holds:read":
        caps.add("hold:read");
        break;
      case "holds:write":
        caps.add("hold:read");
        caps.add("hold:create");
        caps.add("hold:release");
        caps.add("hold:convert");
        break;
      case "bookings:read":
        caps.add("booking:read");
        caps.add("audit:read");
        break;
      case "bookings:write":
        caps.add("booking:read");
        caps.add("booking:create_direct");
        caps.add("booking:cancel");
        caps.add("booking:complete");
        caps.add("booking:no_show");
        break;
      case "tenants:read":
      case "tenants:write":
      case "webhooks:read":
      case "webhooks:write":
      case "usage:read":
        break;
    }
  }
  return Array.from(caps);
}

