import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { BookingError } from "../domain/errors.js";
import { redactSecrets, sha256Hex } from "./control-plane.js";
import type { OrganizationRole } from "./model.js";
import { hashPassword, verifyPassword } from "./security/crypto.js";
import type { EmailTransport } from "./security/mailer.js";

export type ProjectRole = "admin" | "developer" | "viewer";

export interface ConsoleUser {
  id: string;
  email: string;
  name: string;
  status: "active" | "disabled";
  createdAt: string;
}

export interface ConsoleSessionContext {
  sessionId: string;
  user: ConsoleUser;
  activeOrganizationId: string | null;
  activeProjectId: string | null;
  activeEnvironmentId: string | null;
  expiresAt: string;
}

const ORG_ROLE_RANK: Record<OrganizationRole, number> = {
  viewer: 1,
  developer: 2,
  admin: 3,
  owner: 4,
};

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  developer: 2,
  admin: 3,
};

export interface ConsoleAuthServiceOptions {
  emailTransport?: EmailTransport | undefined;
  fromEmail?: string | undefined;
}

/**
 * Server-side Developer Console authentication, email verification, password reset,
 * invitation delivery, session switching, and RBAC service.
 */
export class ConsoleAuthService {
  private readonly emailTransport: EmailTransport | undefined;
  private readonly fromEmail: string;

  constructor(
    private readonly pool: Pool,
    options?: ConsoleAuthServiceOptions,
  ) {
    this.emailTransport = options?.emailTransport;
    this.fromEmail = options?.fromEmail ?? "noreply@onelinebooking.local";
  }

  async registerUser(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<ConsoleUser> {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (!email.includes("@") || !name) {
      throw new BookingError("INVALID_INPUT", "Valid email and name are required");
    }
    const passwordHash = hashPassword(input.password);
    try {
      const res = await this.pool.query(
        `INSERT INTO console_users (email, name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, name, status, created_at`,
        [email, name, passwordHash],
      );
      const row = res.rows[0] as Record<string, unknown>;
      // Attach user_id to any pending organization_members / project_members rows by email
      await this.pool.query(
        `UPDATE organization_members SET user_id = $1 WHERE email = $2 AND user_id IS NULL`,
        [row.id, email],
      );
      await this.pool.query(
        `UPDATE project_members SET user_id = $1 WHERE email = $2 AND user_id IS NULL`,
        [row.id, email],
      );
      return {
        id: String(row.id),
        email: String(row.email),
        name: String(row.name),
        status: row.status as "active" | "disabled",
        createdAt: new Date(String(row.created_at)).toISOString(),
      };
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw new BookingError("INVALID_INPUT", "An account with that email already exists");
      }
      throw err;
    }
  }

  async loginUser(input: {
    email: string;
    password: string;
    sessionTtlHours?: number;
  }): Promise<{ user: ConsoleUser; sessionToken: string; expiresAt: string }> {
    const email = input.email.trim().toLowerCase();
    const res = await this.pool.query(
      `SELECT id, email, name, password_hash, status, created_at
       FROM console_users WHERE email = $1`,
      [email],
    );
    if (res.rowCount === 0) {
      throw new BookingError("FORBIDDEN", "Invalid email or password");
    }
    const row = res.rows[0] as Record<string, unknown>;
    if (row.status !== "active") {
      throw new BookingError("FORBIDDEN", "Account is disabled");
    }
    if (!verifyPassword(input.password, String(row.password_hash))) {
      throw new BookingError("FORBIDDEN", "Invalid email or password");
    }

    const sessionToken = `olbsess_${randomBytes(32).toString("hex")}`;
    const tokenHash = sha256Hex(sessionToken);
    const ttlHours = input.sessionTtlHours ?? 24 * 7;
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);

    // Pre-select first accessible organization/project/test environment if any exists
    const defaultMembership = await this.pool.query<{
      org_id: string;
      project_id: string | null;
      env_id: string | null;
    }>(
      `SELECT om.organization_id AS org_id,
              p.id AS project_id,
              e.id AS env_id
       FROM organization_members om
       LEFT JOIN projects p ON p.organization_id = om.organization_id
       LEFT JOIN environments e ON e.project_id = p.id AND e.type = 'test'
       WHERE om.email = $1 AND om.status = 'active'
       ORDER BY om.created_at ASC, p.created_at ASC
       LIMIT 1`,
      [email],
    );

    const def = defaultMembership.rows[0];
    await this.pool.query(
      `INSERT INTO console_sessions (
        user_id, token_hash, active_organization_id, active_project_id, active_environment_id, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.id,
        tokenHash,
        def?.org_id ?? null,
        def?.project_id ?? null,
        def?.env_id ?? null,
        expiresAt,
      ],
    );

    return {
      user: {
        id: String(row.id),
        email: String(row.email),
        name: String(row.name),
        status: "active",
        createdAt: new Date(String(row.created_at)).toISOString(),
      },
      sessionToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verifySession(rawSessionToken: string): Promise<ConsoleSessionContext | null> {
    if (!rawSessionToken || !rawSessionToken.startsWith("olbsess_")) return null;
    const tokenHash = sha256Hex(rawSessionToken.trim());
    const res = await this.pool.query(
      `SELECT s.id AS session_id,
              s.active_organization_id,
              s.active_project_id,
              s.active_environment_id,
              s.expires_at,
              u.id AS user_id,
              u.email,
              u.name,
              u.status AS user_status,
              u.created_at AS user_created_at
       FROM console_sessions s
       JOIN console_users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()`,
      [tokenHash],
    );
    if (res.rowCount === 0) return null;
    const r = res.rows[0] as Record<string, unknown>;
    if (r.user_status !== "active") return null;
    return {
      sessionId: String(r.session_id),
      user: {
        id: String(r.user_id),
        email: String(r.email),
        name: String(r.name),
        status: "active",
        createdAt: new Date(String(r.user_created_at)).toISOString(),
      },
      activeOrganizationId: r.active_organization_id != null ? String(r.active_organization_id) : null,
      activeProjectId: r.active_project_id != null ? String(r.active_project_id) : null,
      activeEnvironmentId: r.active_environment_id != null ? String(r.active_environment_id) : null,
      expiresAt: new Date(String(r.expires_at)).toISOString(),
    };
  }

  async revokeSession(rawSessionToken: string): Promise<void> {
    if (!rawSessionToken) return;
    await this.pool.query(
      `UPDATE console_sessions SET revoked_at = now() WHERE token_hash = $1`,
      [sha256Hex(rawSessionToken.trim())],
    );
  }

  async switchActiveContext(input: {
    sessionId: string;
    userEmail: string;
    organizationId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  }): Promise<void> {
    if (input.organizationId) {
      await this.requireOrganizationRole(input.userEmail, input.organizationId, "viewer");
    }
    if (input.projectId && input.organizationId) {
      const pRes = await this.pool.query(
        `SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2`,
        [input.projectId, input.organizationId],
      );
      if (pRes.rowCount === 0) {
        throw new BookingError("FORBIDDEN", "Project does not belong to selected organization");
      }
    }
    if (input.environmentId && input.projectId) {
      const eRes = await this.pool.query(
        `SELECT 1 FROM environments WHERE id = $1 AND project_id = $2`,
        [input.environmentId, input.projectId],
      );
      if (eRes.rowCount === 0) {
        throw new BookingError("FORBIDDEN", "Environment does not belong to selected project");
      }
    }
    await this.pool.query(
      `UPDATE console_sessions
       SET active_organization_id = $2,
           active_project_id = $3,
           active_environment_id = $4
       WHERE id = $1`,
      [
        input.sessionId,
        input.organizationId ?? null,
        input.projectId ?? null,
        input.environmentId ?? null,
      ],
    );
  }

  async getOrganizationRole(userEmail: string, organizationId: string): Promise<OrganizationRole | null> {
    const res = await this.pool.query<{ role: OrganizationRole }>(
      `SELECT role FROM organization_members
       WHERE organization_id = $1 AND email = $2 AND status = 'active'`,
      [organizationId, userEmail.toLowerCase()],
    );
    return res.rows[0]?.role ?? null;
  }

  async requireOrganizationRole(
    userEmail: string,
    organizationId: string,
    minRole: OrganizationRole,
  ): Promise<OrganizationRole> {
    const role = await this.getOrganizationRole(userEmail, organizationId);
    if (!role || ORG_ROLE_RANK[role] < ORG_ROLE_RANK[minRole]) {
      throw new BookingError(
        "FORBIDDEN",
        `Requires ${minRole} role or higher in organization`,
      );
    }
    return role;
  }

  async assignProjectRole(input: {
    organizationId: string;
    projectId: string;
    actorEmail: string;
    targetEmail: string;
    role: ProjectRole;
  }): Promise<void> {
    await this.requireOrganizationRole(input.actorEmail, input.organizationId, "admin");
    const projRes = await this.pool.query(
      `SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2`,
      [input.projectId, input.organizationId],
    );
    if (projRes.rowCount === 0) {
      throw new BookingError("FORBIDDEN", "Project does not belong to the specified organization");
    }
    const email = input.targetEmail.trim().toLowerCase();
    const userRes = await this.pool.query<{ id: string }>(
      `SELECT id FROM console_users WHERE email = $1`,
      [email],
    );
    await this.pool.query(
      `INSERT INTO project_members (project_id, email, user_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, email)
       DO UPDATE SET role = EXCLUDED.role, user_id = COALESCE(EXCLUDED.user_id, project_members.user_id), updated_at = now()`,
      [input.projectId, email, userRes.rows[0]?.id ?? null, input.role],
    );
  }

  async requireProjectRole(
    userEmail: string,
    organizationId: string,
    projectId: string,
    minRole: ProjectRole,
  ): Promise<ProjectRole | OrganizationRole> {
    const orgRole = await this.getOrganizationRole(userEmail, organizationId);
    if (!orgRole) {
      throw new BookingError("FORBIDDEN", "User is not a member of this organization");
    }
    if (orgRole === "owner" || orgRole === "admin") {
      return orgRole;
    }
    const pmRes = await this.pool.query<{ role: ProjectRole }>(
      `SELECT role FROM project_members WHERE project_id = $1 AND email = $2`,
      [projectId, userEmail.toLowerCase()],
    );
    const effectiveRole: ProjectRole =
      pmRes.rows[0]?.role ?? (orgRole === "developer" ? "developer" : "viewer");
    if (PROJECT_ROLE_RANK[effectiveRole] < PROJECT_ROLE_RANK[minRole]) {
      throw new BookingError(
        "FORBIDDEN",
        `Requires project ${minRole} role or higher`,
      );
    }
    return effectiveRole;
  }

  async createOrganizationInvitation(input: {
    organizationId: string;
    email: string;
    role: OrganizationRole;
    invitedByUserId: string;
    invitedByEmail: string;
  }): Promise<{ invitationId: string; inviteToken: string; expiresAt: string }> {
    await this.requireOrganizationRole(input.invitedByEmail, input.organizationId, "admin");
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) {
      throw new BookingError("INVALID_INPUT", "Valid invitee email is required");
    }
    const inviteToken = `olbinv_${randomBytes(24).toString("hex")}`;
    const tokenHash = sha256Hex(inviteToken);
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO organization_invitations (
        organization_id, email, role, token_hash, invited_by, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id`,
      [input.organizationId, email, input.role, tokenHash, input.invitedByUserId, expiresAt],
    );
    if (this.emailTransport) {
      await this.emailTransport.send({
        from: this.fromEmail,
        to: email,
        subject: "OneLineBooking Organization Invitation",
        text: `You have been invited as ${input.role}. Accept with invite token: ${inviteToken}`,
      });
    }
    return {
      invitationId: res.rows[0]!.id,
      inviteToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async acceptOrganizationInvitation(input: {
    inviteToken: string;
    userId: string;
    userEmail: string;
  }): Promise<{ organizationId: string; role: OrganizationRole }> {
    const tokenHash = sha256Hex(input.inviteToken.trim());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invRes = await client.query<{
        id: string;
        organization_id: string;
        email: string;
        role: OrganizationRole;
        accepted_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT * FROM organization_invitations WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      if (invRes.rowCount === 0) {
        throw new BookingError("NOT_FOUND", "Invitation not found");
      }
      const inv = invRes.rows[0]!;
      if (inv.accepted_at !== null) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Invitation already accepted");
      }
      if (new Date(inv.expires_at).getTime() <= Date.now()) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Invitation has expired");
      }
      if (inv.email.toLowerCase() !== input.userEmail.toLowerCase()) {
        throw new BookingError("FORBIDDEN", "Invitation was issued for a different email address");
      }

      await client.query(
        `UPDATE organization_invitations SET accepted_at = now() WHERE id = $1`,
        [inv.id],
      );
      await client.query(
        `INSERT INTO organization_members (organization_id, email, user_id, role, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (organization_id, email)
         DO UPDATE SET role = EXCLUDED.role, user_id = EXCLUDED.user_id, status = 'active', updated_at = now()`,
        [inv.organization_id, inv.email.toLowerCase(), input.userId, inv.role],
      );
      await client.query("COMMIT");
      return { organizationId: inv.organization_id, role: inv.role };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async requestEmailVerification(emailInput: string): Promise<{ sent: boolean; verificationToken: string }> {
    const email = emailInput.trim().toLowerCase();
    const userRes = await this.pool.query<{ id: string; email: string }>(
      `SELECT id, email FROM console_users WHERE email = $1`,
      [email],
    );
    if (userRes.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "User account not found");
    }
    const user = userRes.rows[0]!;
    await this.pool.query(
      `DELETE FROM console_email_verifications WHERE user_id = $1 AND verified_at IS NULL`,
      [user.id],
    );
    const verificationToken = `olbver_${randomBytes(24).toString("hex")}`;
    const tokenHash = sha256Hex(verificationToken);
    const expiresAt = new Date(Date.now() + 24 * 3600_000);
    await this.pool.query(
      `INSERT INTO console_email_verifications (user_id, email, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, user.email, tokenHash, expiresAt],
    );
    if (this.emailTransport) {
      await this.emailTransport.send({
        from: this.fromEmail,
        to: user.email,
        subject: "Verify your OneLineBooking Developer email",
        text: `Verify your email with token: ${verificationToken}`,
      });
    }
    return { sent: true, verificationToken };
  }

  async verifyEmail(verificationToken: string): Promise<{ verified: boolean; email: string }> {
    const tokenHash = sha256Hex(verificationToken.trim());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{
        id: string;
        user_id: string;
        email: string;
        verified_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT * FROM console_email_verifications WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      if (res.rowCount === 0) {
        throw new BookingError("NOT_FOUND", "Verification token not found");
      }
      const row = res.rows[0]!;
      if (row.verified_at !== null) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Verification token already used");
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Verification token expired");
      }
      await client.query(`UPDATE console_email_verifications SET verified_at = now() WHERE id = $1`, [row.id]);
      await client.query(`UPDATE console_users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`, [row.user_id]);
      await client.query("COMMIT");
      return { verified: true, email: row.email };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async requestPasswordReset(emailInput: string): Promise<{ sent: boolean; resetToken?: string }> {
    const email = emailInput.trim().toLowerCase();
    const userRes = await this.pool.query<{ id: string; email: string; status: string }>(
      `SELECT id, email, status FROM console_users WHERE email = $1`,
      [email],
    );
    if (userRes.rowCount === 0 || userRes.rows[0]!.status !== "active") {
      // Do not enumerate whether an email exists to external callers
      return { sent: true };
    }
    const user = userRes.rows[0]!;
    await this.pool.query(
      `DELETE FROM console_password_resets WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    const resetToken = `olbrst_${randomBytes(24).toString("hex")}`;
    const tokenHash = sha256Hex(resetToken);
    const expiresAt = new Date(Date.now() + 3600_000);
    await this.pool.query(
      `INSERT INTO console_password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt],
    );
    if (this.emailTransport) {
      await this.emailTransport.send({
        from: this.fromEmail,
        to: user.email,
        subject: "OneLineBooking Password Reset",
        text: `Reset your password with token: ${resetToken}`,
      });
    }
    return { sent: true, resetToken };
  }

  async resetPassword(input: { resetToken: string; newPassword: string }): Promise<{ reset: boolean }> {
    const newHash = hashPassword(input.newPassword);
    const tokenHash = sha256Hex(input.resetToken.trim());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{ id: string; user_id: string; used_at: Date | null; expires_at: Date }>(
        `SELECT * FROM console_password_resets WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      if (res.rowCount === 0) {
        throw new BookingError("NOT_FOUND", "Password reset token not found");
      }
      const row = res.rows[0]!;
      if (row.used_at !== null) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Password reset token already used");
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Password reset token expired");
      }
      await client.query(`UPDATE console_password_resets SET used_at = now() WHERE id = $1`, [row.id]);
      await client.query(`UPDATE console_users SET password_hash = $2, updated_at = now() WHERE id = $1`, [row.user_id, newHash]);
      // Invalidate all prior sessions on password reset
      await client.query(`UPDATE console_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1`, [row.user_id]);
      await client.query("COMMIT");
      return { reset: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  sanitizeLogMessage(msg: string): string {
    return redactSecrets(msg);
  }
}

