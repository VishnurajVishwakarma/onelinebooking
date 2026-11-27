import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

async function waitForHttpReady(url: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Console server at ${url} failed to start within ${timeoutMs}ms`);
}

describe("Phase 7B Developer Console End-to-End Acceptance Suite (Live Next.js App)", () => {
  const port = 3499;
  const baseUrl = `http://127.0.0.1:${port}`;
  let nextProc: ChildProcess;

  before(async () => {
    const consoleDir = resolve(process.cwd(), "apps/console");
    const nextCli = resolve(consoleDir, "node_modules/next/dist/bin/next");
    nextProc = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: consoleDir,
      env: {
        ...process.env,
        OLB_ALLOW_LOCAL_WEBHOOKS: "false",
        OLB_WEBHOOK_MASTER_KEY: randomBytes(32).toString("hex"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHttpReady(`${baseUrl}/login`);
  });

  after(() => {
    nextProc?.kill("SIGTERM");
  });

  it("enforces server-side auth, onboarding wizard, RBAC boundaries, and Test-only Playground restriction", async () => {
    // 1. Unauthenticated access to private console API rejects 401
    const unauthRes = await fetch(`${baseUrl}/api/console/context`);
    assert.equal(unauthRes.status, 401);

    // 2. Register Owner user -> receives HttpOnly session cookie
    const tag = randomUUID().slice(0, 8);
    const ownerEmail = `console-owner-${tag}@example.com`;
    const regRes = await fetch(`${baseUrl}/api/console/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "register",
        email: ownerEmail,
        name: "Console Owner",
        password: "ConsoleOwnerPass123!",
      }),
    });
    assert.equal(regRes.status, 200);
    const setCookie = regRes.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("olb_console_session="));
    const ownerCookie = setCookie.split(";")[0]!;

    // 3. Run Onboarding Wizard (provisions Org, Project, Test/Live Envs, Tenants, Facility, Test Key)
    const wizRes = await fetch(`${baseUrl}/api/console/onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        organizationName: `Wizard Studio ${tag}`,
        projectName: "Cyber Lounge",
        venueName: "Main Hall",
        facilityName: "PC-01",
        timeZone: "UTC",
      }),
    });
    assert.equal(wizRes.status, 201);
    const wizData = (await wizRes.json()) as {
      organization: { id: string };
      project: { id: string };
      facility: { id: string };
      testApiKeyToken: string;
    };
    assert.ok(wizData.testApiKeyToken.startsWith("olb_test_"));

    // 4. Playground succeeds in TEST environment
    const pgTestRes = await fetch(`${baseUrl}/api/console/playground`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ operation: "listBookings", params: { limit: 10 } }),
    });
    assert.equal(pgTestRes.status, 200);

    // 5. Switch to LIVE environment and confirm server blocks Playground with 403
    const ctxRes = await fetch(`${baseUrl}/api/console/context`, {
      headers: { Cookie: ownerCookie },
    });
    const ctxData = (await ctxRes.json()) as {
      activeOrg: { id: string };
      activeProject: { id: string; environments: Array<{ id: string; type: string }> };
    };
    const liveEnv = ctxData.activeProject.environments.find((e) => e.type === "live")!;
    const testEnv = ctxData.activeProject.environments.find((e) => e.type === "test")!;

    await fetch(`${baseUrl}/api/console/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        organizationId: ctxData.activeOrg.id,
        projectId: ctxData.activeProject.id,
        environmentId: liveEnv.id,
      }),
    });

    const pgLiveRes = await fetch(`${baseUrl}/api/console/playground`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ operation: "listBookings" }),
    });
    assert.equal(pgLiveRes.status, 403);

    // Switch back to Test
    await fetch(`${baseUrl}/api/console/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        organizationId: ctxData.activeOrg.id,
        projectId: ctxData.activeProject.id,
        environmentId: testEnv.id,
      }),
    });

    // 6. Invite Viewer -> Viewer registers + accepts invite -> Viewer gets 403 trying to create API key
    const viewerEmail = `console-viewer-${tag}@example.com`;
    const invRes = await fetch(`${baseUrl}/api/console/organizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        action: "invite_member",
        organizationId: wizData.organization.id,
        email: viewerEmail,
        role: "viewer",
      }),
    });
    assert.equal(invRes.status, 201);
    const invJson = (await invRes.json()) as { inviteToken: string };

    const regViewerRes = await fetch(`${baseUrl}/api/console/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "register",
        email: viewerEmail,
        name: "Viewer User",
        password: "ViewerUserPass123!",
      }),
    });
    const viewerCookie = (regViewerRes.headers.get("set-cookie") ?? "").split(";")[0]!;

    const accRes = await fetch(`${baseUrl}/api/console/organizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      body: JSON.stringify({ action: "accept_invite", inviteToken: invJson.inviteToken }),
    });
    assert.equal(accRes.status, 200);

    await fetch(`${baseUrl}/api/console/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      body: JSON.stringify({
        organizationId: wizData.organization.id,
        projectId: wizData.project.id,
        environmentId: testEnv.id,
      }),
    });

    const viewerKeyAttempt = await fetch(`${baseUrl}/api/console/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      body: JSON.stringify({ action: "create", name: "Unauthorized Key" }),
    });
    assert.equal(viewerKeyAttempt.status, 403);

    // 7. Render SSR HTML pages cleanly (no 500s, zero leaked API keys in HTML)
    for (const route of ["/login", "/", "/credentials", "/facilities", "/bookings", "/webhooks", "/observability", "/playground"]) {
      const pageRes = await fetch(`${baseUrl}${route}`);
      assert.equal(pageRes.status, 200);
      const html = await pageRes.text();
      assert.equal(html.includes(wizData.testApiKeyToken), false);
    }
  });
});

