import { BookingError } from "../../../../src/domain/errors.js";
import { requireConsoleSession, type PlatformScope, type ProjectRole } from "./engine";

export async function requireAuthorizedWorkspace(options: {
  minRole: ProjectRole;
  tenantId?: string | null;
  requireTestEnvironment?: boolean;
}) {
  const { backend, session } = await requireConsoleSession();
  const orgs = await backend.platform.listOrganizationsForUser(session.user.email);
  const org = orgs.find((o) => o.id === session.activeOrganizationId) ?? orgs[0];
  if (!org) {
    throw new BookingError("NOT_FOUND", "No organization found for user");
  }
  const projects = await backend.platform.listProjectsForOrganization(org.id);
  const project = projects.find((p) => p.id === session.activeProjectId) ?? projects[0];
  if (!project) {
    throw new BookingError("NOT_FOUND", "No project found in organization");
  }
  const environment =
    project.environments.find((e) => e.id === session.activeEnvironmentId) ??
    project.environments.find((e) => e.type === "test") ??
    project.environments[0];
  if (!environment) {
    throw new BookingError("NOT_FOUND", "No environment found in project");
  }
  if (options.requireTestEnvironment && environment.type !== "test") {
    throw new BookingError(
      "FORBIDDEN",
      "Interactive API playground is strictly restricted to test environments",
    );
  }

  await backend.auth.requireProjectRole(session.user.email, org.id, project.id, options.minRole);

  let resolvedTenantId = options.tenantId ?? null;
  if (resolvedTenantId) {
    const scoped = await backend.platform.getScopedTenant(environment.id, resolvedTenantId);
    if (!scoped) {
      throw new BookingError("FORBIDDEN", "Tenant does not belong to the active environment");
    }
  } else {
    const tenants = await backend.platform.listScopedTenants(environment.id, 1);
    resolvedTenantId = tenants[0]?.id ?? null;
  }

  return {
    backend,
    session,
    organization: org,
    project,
    environment,
    tenantId: resolvedTenantId,
  };
}

export const CONSOLE_ADMIN_ENGINE_CAPS = [
  "facility:read",
  "facility:write",
  "schedule:write",
  "blackout:write",
  "availability:read",
  "hold:create",
  "hold:read",
  "hold:release",
  "hold:convert",
  "booking:create_direct",
  "booking:read",
  "booking:cancel",
  "booking:complete",
  "booking:no_show",
  "booking:override_notice",
  "booking:override_cancellation",
  "audit:read",
] as const;

export const DEFAULT_PLAYGROUND_SCOPES: PlatformScope[] = [
  "facilities:read",
  "availability:read",
  "holds:read",
  "holds:write",
  "bookings:read",
  "bookings:write",
];
