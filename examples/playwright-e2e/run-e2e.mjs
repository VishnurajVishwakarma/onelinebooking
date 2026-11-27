import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

async function waitForHttp(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const port = 3497;
  const baseUrl = `http://127.0.0.1:${port}`;
  const consoleDir = resolve(process.cwd(), "apps/console");
  const nextCli = resolve(consoleDir, "node_modules/next/dist/bin/next");

  const nextProc = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: consoleDir,
    env: {
      ...process.env,
      OLB_WEBHOOK_MASTER_KEY: randomBytes(32).toString("hex"),
      OLB_ALLOW_LOCAL_WEBHOOKS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let browser;
  try {
    await waitForHttp(`${baseUrl}/login`);
    browser = await chromium.launch({
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      headless: true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    const tag = randomUUID().slice(0, 8);
    const email = `pw-${tag}@example.com`;

    // 1. Register user via real UI controls in Chrome
    await page.goto(`${baseUrl}/login`);
    await page.getByRole("button", { name: "Register" }).click();
    await page.locator("#name-input").fill("Playwright Dev");
    await page.locator("#email-input").fill(email);
    await page.locator("#password-input").fill("PlaywrightPass123!");
    await page.getByRole("button", { name: "Create Account" }).click();

    await page.waitForURL(`${baseUrl}/`);
    await page.waitForSelector("#wiz-org");

    // 2. Complete One-Click Onboarding Wizard in browser UI
    await page.locator("#wiz-org").fill(`PW Studio ${tag}`);
    await page.locator("#wiz-proj").fill("PW Booking");
    await page.locator("#wiz-venue").fill("Main Arena");
    await page.locator("#wiz-fac").fill("RTX Bay 9");
    await page.getByRole("button", { name: "Provision Full Environment" }).click();
    await page.waitForSelector('text=/olb_test_/');

    // 3. Navigate across Facilities -> Live Availability Calendar
    await page.getByRole("link", { name: "Facilities & Availability" }).click();
    await page.waitForURL(`${baseUrl}/facilities`);
    await page.locator("td", { hasText: "RTX Bay 9" }).waitFor();
    await page.getByRole("button", { name: "Load Slots" }).click();
    await page.locator("text=/Open/").first().waitFor();

    // 4. Navigate to Playground: confirm works in TEST, disabled in LIVE
    await page.getByRole("link", { name: "Playground & SDK" }).click();
    await page.waitForURL(`${baseUrl}/playground`);
    await page.getByRole("button", { name: "Execute Test Request" }).click();
    await page.locator('pre:has-text("environmentType")').waitFor();

    // Switch header Env selector to Live
    const envSelect = page.getByLabel("Active Environment");
    const liveOption = await envSelect.locator("option", { hasText: "LIVE" }).getAttribute("value");
    assert.ok(liveOption);
    await envSelect.selectOption(liveOption);
    await page.locator("text=/Interactive playground is disabled in LIVE environments/").waitFor();

    // 5. Navigate to Billing & Quotas -> Create plan & verify rendered
    await page.getByRole("link", { name: "Billing & Quotas" }).click();
    await page.waitForURL(`${baseUrl}/billing`);
    await page.getByRole("button", { name: "Add Growth Plan" }).click();
    await page.locator("td", { hasText: "Growth Plan" }).first().waitFor();

    console.log(
      JSON.stringify(
        {
          playwrightBrowserE2EPassed: true,
          browser: "Google Chrome Headless",
          verifiedFlows: [
            "register_ui_and_cookie_auth",
            "onboarding_wizard_ui",
            "facilities_and_availability_calendar",
            "playground_test_vs_live_block",
            "billing_plan_creation_ui",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close();
    nextProc.kill("SIGTERM");
  }
}

void main();

