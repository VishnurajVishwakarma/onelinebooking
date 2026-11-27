import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { IANAZone } from "luxon";
import type { Pool, PoolClient } from "pg";
import { BookingError } from "../domain/errors.js";
import {
  decryptSecret,
  encryptWithKeyring,
  maskWebhookSecret,
  resolveMasterKeyring,
  type KmsKeyring,
} from "./security/crypto.js";
import { validateWebhookUrlAndResolve, type SsrfValidationOptions } from "./security/ssrf.js";
import {
  ALL_PLATFORM_SCOPES,
  type ApiKeyStatus,
  type ApiKeySummary,
  type AuthenticatedPrincipal,
  type CreatedWebhookEndpoint,
  type Environment,
  type EnvironmentType,
  type IssuedApiKey,
  type Location,
  type Organization,
  type OrganizationMember,
  type OrganizationRole,
  type PlatformAuditLogEntry,
  type PlatformScope,
  type PlatformTenant,
  type Project,
  type RecordUsageInput,
  type UsageMetric,
  type UsageSummaryRow,
  type WebhookDeliveryRecord,
  type WebhookDeliveryStatus,
  type WebhookEndpointSummary,
} from "./model.js";

const API_KEY_TOKEN_RE = /^olb_(test|live)_([a-f0-9]{16})_([a-f0-9]{48})$/;
const SECRET_REDACTION_PATTERNS: readonly RegExp[] = [
  /olb_(?:test|live)_[a-f0-9]{16}_[a-f0-9]{48}/gi,
  /whsec_[a-f0-9]{32,}/gi,
];

/**
 * Redacts raw API keys and webhook signing secrets from arbitrary error strings and log messages.
 */
export function redactSecrets(input: string): string {
  let sanitized = input;
  for (const pattern of SECRET_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED_SECRET]");
  }
  return sanitized;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function generateRawApiKey(environmentType: EnvironmentType): {
  token: string;
  keyPrefix: string;
  keyHash: string;
} {
  const keyIdHex = randomBytes(8).toString("hex");
  const secretHex = randomBytes(24).toString("hex");
  const keyPrefix = `olb_${environmentType}_${keyIdHex}`;
  const token = `${keyPrefix}_${secretHex}`;
  return {
    token,
    keyPrefix,
    keyHash: sha256Hex(token),
  };
}

function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

function validateScopes(scopes: readonly PlatformScope[]): PlatformScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new BookingError("INVALID_INPUT", "At least one API scope is required");
  }
  const allowed = new Set<string>(ALL_PLATFORM_SCOPES);
  const unique: PlatformScope[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!allowed.has(scope)) {
      throw new BookingError("INVALID_INPUT", `Unsupported scope: ${scope}`);
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      unique.push(scope);
    }
  }
  return unique;
}

function normalizeSlug(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(trimmed)) {
    throw new BookingError(
      "INVALID_INPUT",
      "Slug must contain 3-63 lowercase alphanumeric characters or hyphens",
    );
  }
  return trimmed;
}

function mapOrganizationRow(row: Record<string, unknown>): Organization {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    status: row.status === "suspended" ? "suspended" : "active",
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapMemberRow(row: Record<string, unknown>): OrganizationMember {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    email: String(row.email),
    role: row.role as OrganizationRole,
    status: row.status as "active" | "invited" | "disabled",
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapProjectRow(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    slug: String(row.slug),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapEnvironmentRow(row: Record<string, unknown>): Environment {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    type: row.type as EnvironmentType,
    name: String(row.name),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function mapPlatformTenantRow(row: Record<string, unknown>): PlatformTenant {
  return {
    id: String(row.id),
    name: String(row.name),
    status: row.status === "archived" ? "archived" : "active",
    archivedAt: row.archived_at ? new Date(String(row.archived_at)) : null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: String(row.environment_id),
    environmentType: row.environment_type as EnvironmentType,
  };
}

function mapLocationRow(row: Record<string, unknown>): Location {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    ...(row.address_line1 != null ? { addressLine1: String(row.address_line1) } : {}),
    ...(row.city != null ? { city: String(row.city) } : {}),
    ...(row.region != null ? { region: String(row.region) } : {}),
    ...(row.postal_code != null ? { postalCode: String(row.postal_code) } : {}),
    ...(row.country != null ? { country: String(row.country) } : {}),
    timeZone: String(row.time_zone),
    active: Boolean(row.active),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapApiKeyRow(row: Record<string, unknown>): ApiKeySummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: String(row.environment_id),
    environmentType: row.environment_type as EnvironmentType,
    tenantId: row.tenant_id != null ? String(row.tenant_id) : null,
    name: String(row.name),
    keyPrefix: String(row.key_prefix),
    scopes: ((row.scopes as string[]) ?? []) as PlatformScope[],
    status: row.status as ApiKeyStatus,
    rotatedFromKeyId: row.rotated_from_key_id != null ? String(row.rotated_from_key_id) : null,
    lastUsedAt: row.last_used_at != null ? new Date(String(row.last_used_at)).toISOString() : null,
    expiresAt: row.expires_at != null ? new Date(String(row.expires_at)).toISOString() : null,
    revokedAt: row.revoked_at != null ? new Date(String(row.revoked_at)).toISOString() : null,
    createdBy: row.created_by != null ? String(row.created_by) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function mapWebhookEndpointRow(row: Record<string, unknown>): WebhookEndpointSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: String(row.environment_id),
    tenantId: String(row.tenant_id),
    url: String(row.url),
    description: row.description != null ? String(row.description) : null,
    eventTypes: ((row.event_types as string[]) ?? []).slice(),
    active: Boolean(row.active),
    disabledAt: row.disabled_at != null ? new Date(String(row.disabled_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export function mapWebhookDeliveryRow(row: Record<string, unknown>): WebhookDeliveryRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: String(row.environment_id),
    tenantId: String(row.tenant_id),
    outboxEventId: String(row.outbox_event_id),
    endpointId: String(row.endpoint_id),
    eventType: String(row.event_type),
    payload: (row.payload as Record<string, unknown>) ?? {},
    status: row.status as WebhookDeliveryStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: new Date(String(row.next_attempt_at)).toISOString(),
    responseStatus: row.response_status != null ? Number(row.response_status) : null,
    responseBodyExcerpt: row.response_body_excerpt != null ? String(row.response_body_excerpt) : null,
    lastError: row.last_error != null ? String(row.last_error) : null,
    deliveredAt: row.delivered_at != null ? new Date(String(row.delivered_at)).toISOString() : null,
    deadLetteredAt: row.dead_lettered_at != null ? new Date(String(row.dead_lettered_at)).toISOString() : null,
    replayedCount: Number(row.replayed_count ?? 0),
    lastAttemptAt: row.last_attempt_at != null ? new Date(String(row.last_attempt_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export interface PlatformServiceOptions {
  masterKey?: Buffer | undefined;
  keyring?: KmsKeyring | undefined;
  ssrfOptions?: SsrfValidationOptions | undefined;
}

/**
 * Multi-tenant SaaS control plane service managing organizations, projects, environments,
 * API credentials, locations, encrypted webhooks, audit logs, and idempotent usage metering.
 */
export class PlatformService {
  private readonly keyring: KmsKeyring;
  private readonly ssrfOptions: SsrfValidationOptions;

  constructor(
    private readonly pool: Pool,
    options?: PlatformServiceOptions,
  ) {
    this.keyring =
      options?.keyring ??
      (options?.masterKey
        ? { activeVersion: 1, keys: { 1: options.masterKey }, providerName: "explicit-buffer" }
        : resolveMasterKeyring());
    this.ssrfOptions = options?.ssrfOptions ?? {};
  }

  private async writeAuditLog(
    client: Pool | PoolClient,
    entry: {
      organizationId: string;
      projectId?: string | null;
      environmentId?: string | null;
      tenantId?: string | null;
      actorType: string;
      actorId: string;
      action: string;
      targetType: string;
      targetId: string;
      details?: Record<string, unknown>;
      correlationId?: string | null;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO platform_audit_logs (
        organization_id, project_id, environment_id, tenant_id,
        actor_type, actor_id, action, target_type, target_id, details, correlation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        entry.organizationId,
        entry.projectId ?? null,
        entry.environmentId ?? null,
        entry.tenantId ?? null,
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(entry.details ?? {}),
        entry.correlationId ?? null,
      ],
    );
  }

  async createOrganization(input: {
    name: string;
    slug: string;
    ownerEmail?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ organization: Organization; ownerMember?: OrganizationMember }> {
    const slug = normalizeSlug(input.slug);
    const name = input.name.trim();
    if (!name) {
      throw new BookingError("INVALID_INPUT", "Organization name is required");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orgRes = await client.query(
        `INSERT INTO organizations (name, slug, metadata)
         VALUES ($1, $2, $3::jsonb)
         RETURNING *`,
        [name, slug, JSON.stringify(input.metadata ?? {})],
      );
      const organization = mapOrganizationRow(orgRes.rows[0] as Record<string, unknown>);

      let ownerMember: OrganizationMember | undefined;
      if (input.ownerEmail) {
        const email = input.ownerEmail.trim().toLowerCase();
        if (!email.includes("@")) {
          throw new BookingError("INVALID_INPUT", "Valid ownerEmail is required");
        }
        const memberRes = await client.query(
          `INSERT INTO organization_members (organization_id, email, role, status)
           VALUES ($1, $2, 'owner', 'active')
           RETURNING *`,
          [organization.id, email],
        );
        ownerMember = mapMemberRow(memberRes.rows[0] as Record<string, unknown>);
      }

      await this.writeAuditLog(client, {
        organizationId: organization.id,
        actorType: ownerMember ? "member" : "system",
        actorId: ownerMember?.email ?? "system",
        action: "organization.created",
        targetType: "organization",
        targetId: organization.id,
        details: { slug },
      });

      await client.query("COMMIT");
      return ownerMember ? { organization, ownerMember } : { organization };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if ((err as { code?: string })?.code === "23505") {
        throw new BookingError("INVALID_INPUT", `Organization slug '${slug}' already exists`);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async addOrganizationMember(input: {
    organizationId: string;
    email: string;
    role: OrganizationRole;
    actorId?: string;
  }): Promise<OrganizationMember> {
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) {
      throw new BookingError("INVALID_INPUT", "Valid member email is required");
    }
    const res = await this.pool.query(
      `INSERT INTO organization_members (organization_id, email, role, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (organization_id, email)
       DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()
       RETURNING *`,
      [input.organizationId, email, input.role],
    );
    const member = mapMemberRow(res.rows[0] as Record<string, unknown>);
    await this.writeAuditLog(this.pool, {
      organizationId: input.organizationId,
      actorType: "admin",
      actorId: input.actorId ?? "system",
      action: "organization_member.upserted",
      targetType: "organization_member",
      targetId: member.id,
      details: { role: input.role },
    });
    return member;
  }

  async createProjectWithEnvironments(input: {
    organizationId: string;
    name: string;
    slug: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ project: Project; testEnvironment: Environment; liveEnvironment: Environment }> {
    const slug = normalizeSlug(input.slug);
    const name = input.name.trim();
    if (!name) {
      throw new BookingError("INVALID_INPUT", "Project name is required");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const projRes = await client.query(
        `INSERT INTO projects (organization_id, name, slug, metadata)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING *`,
        [input.organizationId, name, slug, JSON.stringify(input.metadata ?? {})],
      );
      const project = mapProjectRow(projRes.rows[0] as Record<string, unknown>);

      const testRes = await client.query(
        `INSERT INTO environments (organization_id, project_id, type, name)
         VALUES ($1, $2, 'test', 'Test')
         RETURNING *`,
        [input.organizationId, project.id],
      );
      const liveRes = await client.query(
        `INSERT INTO environments (organization_id, project_id, type, name)
         VALUES ($1, $2, 'live', 'Production')
         RETURNING *`,
        [input.organizationId, project.id],
      );
      const testEnvironment = mapEnvironmentRow(testRes.rows[0] as Record<string, unknown>);
      const liveEnvironment = mapEnvironmentRow(liveRes.rows[0] as Record<string, unknown>);

      await this.writeAuditLog(client, {
        organizationId: input.organizationId,
        projectId: project.id,
        actorType: "admin",
        actorId: input.actorId ?? "system",
        action: "project.created",
        targetType: "project",
        targetId: project.id,
        details: { slug, environments: [testEnvironment.id, liveEnvironment.id] },
      });

      await client.query("COMMIT");
      return { project, testEnvironment, liveEnvironment };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if ((err as { code?: string })?.code === "23505") {
        throw new BookingError("INVALID_INPUT", `Project slug '${slug}' already exists in organization`);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async createScopedTenant(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    name: string;
    metadata?: Record<string, unknown>;
    actorId?: string;
  }): Promise<PlatformTenant> {
    const name = input.name.trim();
    if (!name) {
      throw new BookingError("INVALID_INPUT", "Tenant name is required");
    }
    const envRes = await this.pool.query(
      `SELECT id, organization_id, project_id, type
       FROM environments
       WHERE id = $1 AND project_id = $2 AND organization_id = $3`,
      [input.environmentId, input.projectId, input.organizationId],
    );
    if (envRes.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "Environment does not belong to the specified project/organization");
    }
    const envRow = envRes.rows[0] as { id: string; organization_id: string; project_id: string; type: EnvironmentType };

    const tenantRes = await this.pool.query(
      `INSERT INTO tenants (
        name, metadata, organization_id, project_id, environment_id, environment_type
      ) VALUES ($1, $2::jsonb, $3, $4, $5, $6)
      RETURNING *`,
      [
        name,
        JSON.stringify(input.metadata ?? {}),
        envRow.organization_id,
        envRow.project_id,
        envRow.id,
        envRow.type,
      ],
    );
    const tenant = mapPlatformTenantRow(tenantRes.rows[0] as Record<string, unknown>);
    await this.writeAuditLog(this.pool, {
      organizationId: envRow.organization_id,
      projectId: envRow.project_id,
      environmentId: envRow.id,
      tenantId: tenant.id,
      actorType: "admin",
      actorId: input.actorId ?? "system",
      action: "tenant.created",
      targetType: "tenant",
      targetId: tenant.id,
      details: { name, environmentType: envRow.type },
    });
    return tenant;
  }

  async getScopedTenant(environmentId: string, tenantId: string): Promise<PlatformTenant | null> {
    const res = await this.pool.query(
      `SELECT * FROM tenants WHERE id = $1 AND environment_id = $2`,
      [tenantId, environmentId],
    );
    if (res.rowCount === 0) return null;
    return mapPlatformTenantRow(res.rows[0] as Record<string, unknown>);
  }

  async listScopedTenants(environmentId: string, limit = 50, cursorCreatedAt?: string): Promise<PlatformTenant[]> {
    const res = await this.pool.query(
      `SELECT *
       FROM tenants
       WHERE environment_id = $1
         AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [environmentId, cursorCreatedAt ?? null, Math.min(Math.max(1, limit), 100)],
    );
    return res.rows.map((row) => mapPlatformTenantRow(row as Record<string, unknown>));
  }

  async createLocation(input: {
    tenantId: string;
    name: string;
    timeZone: string;
    addressLine1?: string | undefined;
    city?: string | undefined;
    region?: string | undefined;
    postalCode?: string | undefined;
    country?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<Location> {
    if (!IANAZone.isValidZone(input.timeZone)) {
      throw new BookingError("INVALID_INPUT", `Invalid IANA time zone: ${input.timeZone}`);
    }
    const name = input.name.trim();
    if (!name) {
      throw new BookingError("INVALID_INPUT", "Location name is required");
    }
    const res = await this.pool.query(
      `INSERT INTO locations (
        tenant_id, name, address_line1, city, region, postal_code, country, time_zone, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING *`,
      [
        input.tenantId,
        name,
        input.addressLine1 ?? null,
        input.city ?? null,
        input.region ?? null,
        input.postalCode ?? null,
        input.country ?? null,
        input.timeZone,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapLocationRow(res.rows[0] as Record<string, unknown>);
  }

  async attachFacilityLocation(input: {
    tenantId: string;
    facilityId: string;
    locationId: string;
    resourceKind?: string | undefined;
  }): Promise<void> {
    const res = await this.pool.query(
      `UPDATE facilities
       SET location_id = $3,
           resource_kind = COALESCE($4, resource_kind),
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.facilityId, input.locationId, input.resourceKind ?? null],
    );
    if (res.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "Facility or location not found for tenant");
    }
  }

  async createApiKey(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    tenantId?: string | null | undefined;
    name: string;
    scopes: readonly PlatformScope[];
    expiresAt?: string | null | undefined;
    createdBy?: string | undefined;
  }): Promise<IssuedApiKey> {
    const name = input.name.trim();
    if (!name) {
      throw new BookingError("INVALID_INPUT", "API key name is required");
    }
    const scopes = validateScopes(input.scopes);

    const envRes = await this.pool.query(
      `SELECT id, organization_id, project_id, type
       FROM environments
       WHERE id = $1 AND project_id = $2 AND organization_id = $3`,
      [input.environmentId, input.projectId, input.organizationId],
    );
    if (envRes.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "Environment not found in project/organization");
    }
    const env = envRes.rows[0] as { id: string; organization_id: string; project_id: string; type: EnvironmentType };

    if (input.tenantId) {
      const tenantCheck = await this.pool.query(
        `SELECT 1 FROM tenants WHERE id = $1 AND environment_id = $2`,
        [input.tenantId, env.id],
      );
      if (tenantCheck.rowCount === 0) {
        throw new BookingError("FORBIDDEN", "Tenant does not belong to target environment");
      }
    }

    const { token, keyPrefix, keyHash } = generateRawApiKey(env.type);
    const res = await this.pool.query(
      `INSERT INTO api_keys (
        organization_id, project_id, environment_id, environment_type,
        tenant_id, name, key_prefix, key_hash, scopes, expires_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::timestamptz, $11)
      RETURNING *`,
      [
        env.organization_id,
        env.project_id,
        env.id,
        env.type,
        input.tenantId ?? null,
        name,
        keyPrefix,
        keyHash,
        scopes,
        input.expiresAt ?? null,
        input.createdBy ?? "system",
      ],
    );
    const apiKey = mapApiKeyRow(res.rows[0] as Record<string, unknown>);
    await this.writeAuditLog(this.pool, {
      organizationId: env.organization_id,
      projectId: env.project_id,
      environmentId: env.id,
      tenantId: input.tenantId ?? null,
      actorType: "admin",
      actorId: input.createdBy ?? "system",
      action: "api_key.created",
      targetType: "api_key",
      targetId: apiKey.id,
      details: { keyPrefix, scopes, environmentType: env.type },
    });

    return { apiKey, token };
  }

  async verifyApiKey(rawToken: string): Promise<AuthenticatedPrincipal | null> {
    const match = API_KEY_TOKEN_RE.exec(rawToken.trim());
    if (!match) {
      return null;
    }
    const envTypeFromToken = match[1] as EnvironmentType;
    const keyIdHex = match[2]!;
    const expectedPrefix = `olb_${envTypeFromToken}_${keyIdHex}`;
    const candidateHash = sha256Hex(rawToken.trim());

    const res = await this.pool.query(
      `SELECT k.*, o.status AS org_status
       FROM api_keys k
       JOIN organizations o ON o.id = k.organization_id
       WHERE k.key_prefix = $1`,
      [expectedPrefix],
    );
    if (res.rowCount === 0) {
      return null;
    }
    const row = res.rows[0] as Record<string, unknown>;
    const storedHashBuf = Buffer.from(String(row.key_hash), "hex");
    const candidateHashBuf = Buffer.from(candidateHash, "hex");
    if (storedHashBuf.length !== candidateHashBuf.length || !timingSafeEqual(storedHashBuf, candidateHashBuf)) {
      return null;
    }

    if (row.status !== "active") {
      return null;
    }
    if (row.org_status !== "active") {
      return null;
    }
    if (row.environment_type !== envTypeFromToken) {
      return null;
    }
    if (row.expires_at != null && new Date(String(row.expires_at)).getTime() <= Date.now()) {
      return null;
    }

    // Track last_used_at asynchronously throttled per 5s window to avoid hot-row write amplification
    await this.pool.query(
      `UPDATE api_keys
       SET last_used_at = now()
       WHERE id = $1
         AND (last_used_at IS NULL OR last_used_at < now() - interval '5 seconds')`,
      [row.id],
    );

    return {
      apiKeyId: String(row.id),
      keyPrefix: String(row.key_prefix),
      organizationId: String(row.organization_id),
      projectId: String(row.project_id),
      environmentId: String(row.environment_id),
      environmentType: row.environment_type as EnvironmentType,
      tenantId: row.tenant_id != null ? String(row.tenant_id) : null,
      scopes: ((row.scopes as string[]) ?? []) as PlatformScope[],
    };
  }

  async rotateApiKey(input: {
    organizationId: string;
    keyId: string;
    revokePrevious?: boolean | undefined;
    actorId?: string | undefined;
  }): Promise<IssuedApiKey> {
    const revokePrevious = input.revokePrevious ?? true;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingRes = await client.query(
        `SELECT * FROM api_keys WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [input.keyId, input.organizationId],
      );
      if (existingRes.rowCount === 0) {
        throw new BookingError("NOT_FOUND", "API key not found in organization");
      }
      const existing = existingRes.rows[0] as Record<string, unknown>;
      if (existing.status === "revoked") {
        throw new BookingError("INVALID_STATE_TRANSITION", "Cannot rotate an already revoked API key");
      }

      const envType = existing.environment_type as EnvironmentType;
      const { token, keyPrefix, keyHash } = generateRawApiKey(envType);

      if (revokePrevious) {
        await client.query(
          `UPDATE api_keys
           SET status = 'rotated', revoked_at = now()
           WHERE id = $1`,
          [existing.id],
        );
      }

      const newRes = await client.query(
        `INSERT INTO api_keys (
          organization_id, project_id, environment_id, environment_type,
          tenant_id, name, key_prefix, key_hash, scopes, rotated_from_key_id, expires_at, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12)
        RETURNING *`,
        [
          existing.organization_id,
          existing.project_id,
          existing.environment_id,
          envType,
          existing.tenant_id ?? null,
          String(existing.name),
          keyPrefix,
          keyHash,
          existing.scopes,
          existing.id,
          existing.expires_at ?? null,
          input.actorId ?? "system",
        ],
      );
      const apiKey = mapApiKeyRow(newRes.rows[0] as Record<string, unknown>);
      await this.writeAuditLog(client, {
        organizationId: String(existing.organization_id),
        projectId: String(existing.project_id),
        environmentId: String(existing.environment_id),
        tenantId: existing.tenant_id != null ? String(existing.tenant_id) : null,
        actorType: "admin",
        actorId: input.actorId ?? "system",
        action: "api_key.rotated",
        targetType: "api_key",
        targetId: apiKey.id,
        details: { previousKeyId: existing.id, revokePrevious, newPrefix: keyPrefix },
      });
      await client.query("COMMIT");
      return { apiKey, token };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async revokeApiKey(input: { organizationId: string; keyId: string; actorId?: string | undefined }): Promise<ApiKeySummary> {
    const res = await this.pool.query(
      `UPDATE api_keys
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      [input.keyId, input.organizationId],
    );
    if (res.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "API key not found in organization");
    }
    const apiKey = mapApiKeyRow(res.rows[0] as Record<string, unknown>);
    await this.writeAuditLog(this.pool, {
      organizationId: apiKey.organizationId,
      projectId: apiKey.projectId,
      environmentId: apiKey.environmentId,
      tenantId: apiKey.tenantId,
      actorType: "admin",
      actorId: input.actorId ?? "system",
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: apiKey.id,
    });
    return apiKey;
  }

  async listApiKeys(organizationId: string, environmentId?: string): Promise<ApiKeySummary[]> {
    const res = await this.pool.query(
      `SELECT * FROM api_keys
       WHERE organization_id = $1
         AND ($2::uuid IS NULL OR environment_id = $2::uuid)
       ORDER BY created_at DESC`,
      [organizationId, environmentId ?? null],
    );
    return res.rows.map((r) => mapApiKeyRow(r as Record<string, unknown>));
  }

  async createWebhookEndpoint(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    tenantId: string;
    url: string;
    description?: string | undefined;
    eventTypes?: readonly string[] | undefined;
    ssrfOptions?: SsrfValidationOptions | undefined;
  }): Promise<CreatedWebhookEndpoint> {
    const envRes = await this.pool.query<{ type: EnvironmentType }>(
      `SELECT type FROM environments WHERE id = $1 AND project_id = $2 AND organization_id = $3`,
      [input.environmentId, input.projectId, input.organizationId],
    );
    if (envRes.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "Environment not found");
    }
    const envType = envRes.rows[0]!.type;
    // Live environments strictly prohibit HTTP or local/private SSRF test overrides
    const rawSsrf = input.ssrfOptions ?? this.ssrfOptions;
    const effectiveSsrf: SsrfValidationOptions =
      envType === "live" ? { ...rawSsrf, allowLocalHttpForTesting: false } : rawSsrf;

    const validated = await validateWebhookUrlAndResolve(input.url, effectiveSsrf);

    const signingSecret = generateWebhookSecret();
    const { ciphertext: encryptedSecret, keyVersion } = encryptWithKeyring(signingSecret, this.keyring);
    const hint = maskWebhookSecret(signingSecret);

    const res = await this.pool.query(
      `INSERT INTO webhook_endpoints (
        organization_id, project_id, environment_id, tenant_id,
        url, description, event_types, signing_secret, signing_secret_encrypted, secret_hint, secret_key_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NULL, $8, $9, $10)
      RETURNING *`,
      [
        input.organizationId,
        input.projectId,
        input.environmentId,
        input.tenantId,
        validated.url.toString(),
        input.description ?? null,
        input.eventTypes ? [...input.eventTypes] : [],
        encryptedSecret,
        hint,
        keyVersion,
      ],
    );
    const endpoint = mapWebhookEndpointRow(res.rows[0] as Record<string, unknown>);
    await this.writeAuditLog(this.pool, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      tenantId: input.tenantId,
      actorType: "admin",
      actorId: "api",
      action: "webhook_endpoint.created",
      targetType: "webhook_endpoint",
      targetId: endpoint.id,
      details: { url: endpoint.url, eventTypes: endpoint.eventTypes, encrypted: true, keyVersion, secretHint: hint },
    });

    return { endpoint, signingSecret };
  }

  /**
   * Rotates a webhook endpoint's signing secret with an optional dual-signature grace period.
   */
  async rotateWebhookSecret(input: {
    environmentId: string;
    tenantId: string;
    endpointId: string;
    gracePeriodMinutes?: number | undefined;
    actorId?: string | undefined;
  }): Promise<{ endpoint: WebhookEndpointSummary; signingSecret: string; previousSecretValidUntil: string | null }> {
    const graceMinutes = Math.max(0, Math.min(24 * 60, input.gracePeriodMinutes ?? 60));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingRes = await client.query<Record<string, unknown>>(
        `SELECT * FROM webhook_endpoints WHERE id = $1 AND environment_id = $2 AND tenant_id = $3 FOR UPDATE`,
        [input.endpointId, input.environmentId, input.tenantId],
      );
      if (existingRes.rowCount === 0) {
        throw new BookingError("NOT_FOUND", "Webhook endpoint not found");
      }
      const existing = existingRes.rows[0]!;
      const prevEncrypted =
        (existing.signing_secret_encrypted as string | null) ??
        (existing.signing_secret
          ? encryptWithKeyring(String(existing.signing_secret), this.keyring).ciphertext
          : null);

      const newSecret = generateWebhookSecret();
      const { ciphertext: newEncrypted, keyVersion } = encryptWithKeyring(newSecret, this.keyring);
      const newHint = maskWebhookSecret(newSecret);
      const prevExpiresAt =
        graceMinutes > 0 && prevEncrypted
          ? new Date(Date.now() + graceMinutes * 60_000)
          : null;

      const updatedRes = await client.query<Record<string, unknown>>(
        `UPDATE webhook_endpoints
         SET signing_secret = NULL,
             signing_secret_encrypted = $4,
             previous_signing_secret_encrypted = $5,
             previous_secret_expires_at = $6,
             secret_key_version = $8,
             secret_hint = $7,
             updated_at = now()
         WHERE id = $1 AND environment_id = $2 AND tenant_id = $3
         RETURNING *`,
        [
          input.endpointId,
          input.environmentId,
          input.tenantId,
          newEncrypted,
          prevExpiresAt ? prevEncrypted : null,
          prevExpiresAt,
          newHint,
          keyVersion,
        ],
      );
      const endpoint = mapWebhookEndpointRow(updatedRes.rows[0]!);
      await this.writeAuditLog(client, {
        organizationId: endpoint.organizationId,
        projectId: endpoint.projectId,
        environmentId: endpoint.environmentId,
        tenantId: endpoint.tenantId,
        actorType: "admin",
        actorId: input.actorId ?? "api",
        action: "webhook_endpoint.secret_rotated",
        targetType: "webhook_endpoint",
        targetId: endpoint.id,
        details: { graceMinutes, keyVersion, secretHint: newHint },
      });
      await client.query("COMMIT");
      return {
        endpoint,
        signingSecret: newSecret,
        previousSecretValidUntil: prevExpiresAt ? prevExpiresAt.toISOString() : null,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Re-encrypts stored webhook secrets under a newer KMS keyring version (`secret_key_version`)
   * without changing the plaintext HMAC secrets shared with customer consumers.
   */
  async reEncryptWebhookSecrets(input: {
    targetKeyring?: KmsKeyring | undefined;
    organizationId?: string | undefined;
  }): Promise<{ rotatedCount: number; activeKeyVersion: number }> {
    const ring = input.targetKeyring ?? this.keyring;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<Record<string, unknown>>(
        `SELECT id, organization_id, signing_secret, signing_secret_encrypted,
                previous_signing_secret_encrypted, secret_key_version
         FROM webhook_endpoints
         WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)
           AND secret_key_version < $2
         FOR UPDATE`,
        [input.organizationId ?? null, ring.activeVersion],
      );

      let rotatedCount = 0;
      for (const row of res.rows) {
        const plainPrimary = row.signing_secret_encrypted
          ? decryptSecret(String(row.signing_secret_encrypted), ring)
          : row.signing_secret
            ? String(row.signing_secret)
            : null;
        if (!plainPrimary) continue;
        const nextPrimary = encryptWithKeyring(plainPrimary, ring);
        let nextPrev: string | null = null;
        if (row.previous_signing_secret_encrypted) {
          const plainPrev = decryptSecret(String(row.previous_signing_secret_encrypted), ring);
          nextPrev = encryptWithKeyring(plainPrev, ring).ciphertext;
        }
        await client.query(
          `UPDATE webhook_endpoints
           SET signing_secret = NULL,
               signing_secret_encrypted = $2,
               previous_signing_secret_encrypted = COALESCE($3, previous_signing_secret_encrypted),
               secret_key_version = $4,
               updated_at = now()
           WHERE id = $1`,
          [row.id, nextPrimary.ciphertext, nextPrev, ring.activeVersion],
        );
        rotatedCount += 1;
      }
      await client.query("COMMIT");
      return { rotatedCount, activeKeyVersion: ring.activeVersion };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Resolves decrypted active (+ in-grace-window previous) signing secrets for delivery signing. */
  resolveEndpointSecrets(row: {
    signing_secret?: string | null;
    signing_secret_encrypted?: string | null;
    previous_signing_secret_encrypted?: string | null;
    previous_secret_expires_at?: Date | string | null;
  }): { primary: string; previous?: string } {
    const primary = row.signing_secret_encrypted
      ? decryptSecret(row.signing_secret_encrypted, this.keyring)
      : row.signing_secret
        ? String(row.signing_secret)
        : (() => {
            throw new BookingError("INTERNAL_ERROR", "Webhook endpoint has no signing secret");
          })();

    let previous: string | undefined;
    if (row.previous_signing_secret_encrypted && row.previous_secret_expires_at) {
      if (new Date(row.previous_secret_expires_at).getTime() > Date.now()) {
        previous = decryptSecret(row.previous_signing_secret_encrypted, this.keyring);
      }
    }
    return previous ? { primary, previous } : { primary };
  }

  async listWebhookEndpoints(environmentId: string, tenantId: string): Promise<WebhookEndpointSummary[]> {
    const res = await this.pool.query(
      `SELECT * FROM webhook_endpoints
       WHERE environment_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC`,
      [environmentId, tenantId],
    );
    return res.rows.map((r) => mapWebhookEndpointRow(r as Record<string, unknown>));
  }

  async disableWebhookEndpoint(environmentId: string, tenantId: string, endpointId: string): Promise<WebhookEndpointSummary> {
    const res = await this.pool.query(
      `UPDATE webhook_endpoints
       SET active = false, disabled_at = COALESCE(disabled_at, now()), updated_at = now()
       WHERE id = $1 AND environment_id = $2 AND tenant_id = $3
       RETURNING *`,
      [endpointId, environmentId, tenantId],
    );
    if (res.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "Webhook endpoint not found");
    }
    return mapWebhookEndpointRow(res.rows[0] as Record<string, unknown>);
  }

  async listWebhookDeliveries(input: {
    environmentId: string;
    tenantId: string;
    endpointId?: string | undefined;
    status?: WebhookDeliveryStatus | undefined;
    limit?: number | undefined;
  }): Promise<WebhookDeliveryRecord[]> {
    const res = await this.pool.query(
      `SELECT *
       FROM webhook_deliveries
       WHERE environment_id = $1
         AND tenant_id = $2
         AND ($3::uuid IS NULL OR endpoint_id = $3::uuid)
         AND ($4::text IS NULL OR status = $4::text)
       ORDER BY created_at DESC
       LIMIT $5`,
      [
        input.environmentId,
        input.tenantId,
        input.endpointId ?? null,
        input.status ?? null,
        Math.min(Math.max(1, input.limit ?? 50), 100),
      ],
    );
    return res.rows.map((r) => mapWebhookDeliveryRow(r as Record<string, unknown>));
  }

  async replayWebhookDelivery(environmentId: string, tenantId: string, deliveryId: string): Promise<WebhookDeliveryRecord> {
    const res = await this.pool.query(
      `UPDATE webhook_deliveries
       SET status = 'pending',
           next_attempt_at = now(),
           dead_lettered_at = NULL,
           last_error = NULL,
           replayed_count = replayed_count + 1,
           max_attempts = GREATEST(max_attempts, attempts + 3),
           updated_at = now()
       WHERE id = $1 AND environment_id = $2 AND tenant_id = $3
       RETURNING *`,
      [deliveryId, environmentId, tenantId],
    );
    if (res.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "Webhook delivery record not found");
    }
    return mapWebhookDeliveryRow(res.rows[0] as Record<string, unknown>);
  }

  /**
   * Append-only, idempotent usage recording. Duplicate `(environmentId, scopeKey, metric, idempotencyKey)` rows
   * are ignored atomically via unique constraint without impacting request/booking correctness.
   * Independent tenants or customers using identical idempotency keys remain strictly isolated via `scopeKey`.
   */
  async recordUsage(input: RecordUsageInput & { scopeKey?: string | undefined }): Promise<{ recorded: boolean }> {
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BookingError("INVALID_INPUT", "Usage quantity must be an integer >= 1");
    }
    const scopeKey = input.scopeKey ?? input.tenantId ?? "__env__";
    const res = await this.pool.query(
      `INSERT INTO usage_records (
        organization_id, project_id, environment_id, tenant_id, scope_key,
        metric, quantity, idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (environment_id, scope_key, metric, idempotency_key) DO NOTHING
      RETURNING id`,
      [
        input.organizationId,
        input.projectId,
        input.environmentId,
        input.tenantId ?? null,
        scopeKey,
        input.metric,
        quantity,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return { recorded: (res.rowCount ?? 0) > 0 };
  }

  async listOrganizationsForUser(email: string): Promise<Array<Organization & { role: OrganizationRole }>> {
    const res = await this.pool.query(
      `SELECT o.*, om.role
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       WHERE om.email = $1 AND om.status = 'active'
       ORDER BY o.created_at ASC`,
      [email.trim().toLowerCase()],
    );
    return res.rows.map((r) => ({
      ...mapOrganizationRow(r as Record<string, unknown>),
      role: r.role as OrganizationRole,
    }));
  }

  async listOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
    const res = await this.pool.query(
      `SELECT * FROM organization_members WHERE organization_id = $1 ORDER BY created_at ASC`,
      [organizationId],
    );
    return res.rows.map((r) => mapMemberRow(r as Record<string, unknown>));
  }

  async listProjectsForOrganization(organizationId: string): Promise<Array<Project & { environments: Environment[] }>> {
    const projRes = await this.pool.query(
      `SELECT * FROM projects WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    const envRes = await this.pool.query(
      `SELECT * FROM environments WHERE organization_id = $1 ORDER BY type ASC`,
      [organizationId],
    );
    const envsByProj = new Map<string, Environment[]>();
    for (const r of envRes.rows) {
      const env = mapEnvironmentRow(r as Record<string, unknown>);
      const list = envsByProj.get(env.projectId) ?? [];
      list.push(env);
      envsByProj.set(env.projectId, list);
    }
    return projRes.rows.map((r) => {
      const proj = mapProjectRow(r as Record<string, unknown>);
      return { ...proj, environments: envsByProj.get(proj.id) ?? [] };
    });
  }

  async listLocations(tenantId: string): Promise<Location[]> {
    const res = await this.pool.query(
      `SELECT * FROM locations WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return res.rows.map((r) => mapLocationRow(r as Record<string, unknown>));
  }

  async listApiRequestLogs(environmentId: string, limit = 100) {
    const res = await this.pool.query(
      `SELECT id, organization_id, project_id, environment_id, tenant_id, api_key_id,
              correlation_id, trace_id, method, path_template, status_code, duration_ms,
              request_bytes, response_bytes, error_code, created_at
       FROM api_request_logs
       WHERE environment_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [environmentId, Math.min(200, Math.max(1, limit))],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      organizationId: String(r.organization_id),
      projectId: String(r.project_id),
      environmentId: String(r.environment_id),
      tenantId: r.tenant_id != null ? String(r.tenant_id) : null,
      apiKeyId: r.api_key_id != null ? String(r.api_key_id) : null,
      correlationId: String(r.correlation_id),
      traceId: r.trace_id != null ? String(r.trace_id) : null,
      method: String(r.method),
      pathTemplate: String(r.path_template),
      statusCode: Number(r.status_code),
      durationMs: Number(r.duration_ms),
      requestBytes: Number(r.request_bytes),
      responseBytes: Number(r.response_bytes),
      errorCode: r.error_code != null ? String(r.error_code) : null,
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
  }

  async listCustomersSummary(tenantId: string, limit = 100) {
    const res = await this.pool.query(
      `SELECT COALESCE(external_customer_id, 'anonymous') AS customer_id,
              count(*) FILTER (WHERE kind = 'booking')::int AS booking_count,
              count(*) FILTER (WHERE kind = 'hold')::int AS active_hold_count,
              max(activity_at) AS last_activity_at
       FROM (
         SELECT external_customer_id, 'booking'::text AS kind, created_at AS activity_at
         FROM bookings WHERE tenant_id = $1
         UNION ALL
         SELECT external_customer_id, 'hold'::text AS kind, created_at AS activity_at
         FROM holds WHERE tenant_id = $1 AND state = 'active'
       ) t
       GROUP BY COALESCE(external_customer_id, 'anonymous')
       ORDER BY last_activity_at DESC
       LIMIT $2`,
      [tenantId, Math.min(200, Math.max(1, limit))],
    );
    return res.rows.map((r) => ({
      customerId: String(r.customer_id),
      bookingCount: Number(r.booking_count),
      activeHoldCount: Number(r.active_hold_count),
      lastActivityAt: r.last_activity_at ? new Date(String(r.last_activity_at)).toISOString() : null,
    }));
  }

  async getUsageSummary(input: {
    environmentId: string;
    tenantId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  }): Promise<UsageSummaryRow[]> {
    const res = await this.pool.query(
      `SELECT metric,
              COALESCE(SUM(quantity), 0)::bigint AS total_quantity,
              COUNT(*)::bigint AS record_count
       FROM usage_records
       WHERE environment_id = $1
         AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
         AND ($3::timestamptz IS NULL OR recorded_at >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR recorded_at <= $4::timestamptz)
       GROUP BY metric
       ORDER BY metric ASC`,
      [input.environmentId, input.tenantId ?? null, input.from ?? null, input.to ?? null],
    );
    return res.rows.map((r) => ({
      metric: String(r.metric) as UsageMetric,
      totalQuantity: Number(r.total_quantity),
      recordCount: Number(r.record_count),
    }));
  }

  async listAuditLogs(organizationId: string, limit = 50): Promise<PlatformAuditLogEntry[]> {
    const res = await this.pool.query(
      `SELECT * FROM platform_audit_logs
       WHERE organization_id = $1
       ORDER BY recorded_at DESC
       LIMIT $2`,
      [organizationId, Math.min(Math.max(1, limit), 100)],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      organizationId: String(r.organization_id),
      projectId: r.project_id != null ? String(r.project_id) : null,
      environmentId: r.environment_id != null ? String(r.environment_id) : null,
      tenantId: r.tenant_id != null ? String(r.tenant_id) : null,
      actorType: String(r.actor_type),
      actorId: String(r.actor_id),
      action: String(r.action),
      targetType: String(r.target_type),
      targetId: String(r.target_id),
      details: (r.details as Record<string, unknown>) ?? {},
      correlationId: r.correlation_id != null ? String(r.correlation_id) : null,
      recordedAt: new Date(String(r.recorded_at)).toISOString(),
    }));
  }
}
