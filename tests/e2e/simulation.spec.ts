import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  ENGINEER,
  MGR,
  OTHER_ORG_MGR,
  control,
  noHorizontalScroll,
  resetWorld,
  startAs,
  switchTo,
} from "./helpers";

/**
 * S10 Facility Simulation in a real browser, against the production web build and the real local
 * backend on a simulated clock. People click; simulated time passes through the control port; the
 * deterministic platform decides everything else.
 */
const SIM = "/operations/simulation";
const steps = (count: number, tick = true) => control("sim-steps", { count, tick });

async function open(page: Page, actor = MGR) {
  await startAs(page, actor);
  await page.goto(SIM);
  await expect(page.getByTestId("sim-workspace")).toBeVisible();
}
async function reload(page: Page) {
  await page.reload();
  await expect(page.getByTestId("sim-workspace")).toBeVisible();
  // the workspace fetches its read models after load; wait for them before looking at any panel
  await expect(page.getByTestId("rule-panel")).toBeVisible();
  await expect(page.getByTestId("sensor-table")).toBeVisible();
  await page.waitForLoadState("networkidle");
}
async function scenario(page: Page, id: string) {
  await page.getByTestId(`scenario-${id}`).click();
  await expect(page.getByTestId(`scenario-${id}`)).toHaveAttribute("aria-pressed", "true");
}
async function warmUp(page: Page) {
  await page.getByTestId("sim-start").click();
  await expect(page.getByTestId("sim-status")).toContainText(/running/i);
  await scenario(page, "NORMAL");
  await steps(16, false);
  await reload(page);
  await expect(page.getByTestId("baseline-learning")).toHaveCount(0); // baselines are READY
}
async function detect(page: Page) {
  await warmUp(page);
  await scenario(page, "COMPOUND_COOLING_RISK");
  for (let i = 0; i < 12; i++) {
    await steps(3, false);
    await reload(page);
    if ((await page.getByTestId("case-panel").count()) > 0) return;
  }
  throw new Error("the compound scenario did not open a case");
}
async function acknowledgeAndReport(page: Page, action?: string) {
  const ack = page.getByTestId("ack-button");
  if (await ack.isVisible().catch(() => false)) {
    await ack.click();
    await expect(page.getByTestId("case-message")).toBeVisible();
  }
  if (action !== undefined) await page.getByTestId("action-select").selectOption(action);
  await page.getByTestId("report-button").click();
  await expect(page.getByTestId("case-message")).toBeVisible();
}
async function untilVerification(page: Page, text: RegExp) {
  for (let i = 0; i < 14; i++) {
    await steps(4);
    await reload(page);
    const r = page.getByTestId("verification-result");
    if ((await r.count()) > 0 && text.test((await r.first().innerText()).trim())) return;
  }
  throw new Error(`verification did not reach ${String(text)}`);
}

test.beforeEach(async () => {
  await resetWorld();
});

test.describe("S10 Facility Simulation", () => {
  test("NORMAL and EMERGING: no case, no premature outcome", async ({ page }) => {
    await open(page);
    await warmUp(page);
    await steps(8);
    await reload(page);
    await expect(page.getByTestId("case-empty")).toBeVisible();
    await scenario(page, "EMERGING_DETERIORATION");
    await steps(14);
    await reload(page);
    await expect(page.getByTestId("case-empty")).toBeVisible();
    await expect(page.getByTestId("verification-empty")).toBeVisible();
    await expect(page.getByTestId("sim-data-badge")).toContainText(/simulation data/i);
    await expect(page.getByText(/DEMO \/ SIMULATION POLICY/).first()).toBeVisible();
  });

  test("COMPOUND -> case -> alert; ineffective action is never verified; NOT_IMPROVING; one follow-up", async ({
    page,
  }) => {
    await open(page);
    await detect(page);
    await expect(page.getByTestId("case-state")).toBeVisible();
    await expect(page.getByTestId("delivery-row")).toHaveCount(1);
    await page.getByTestId("ack-button").click();
    await expect(page.getByTestId("case-message")).toBeVisible();
    await page.getByTestId("report-button").click();
    await expect(page.getByTestId("case-message")).toBeVisible();
    await expect(page.getByTestId("reported-vs-verified")).toBeVisible();
    await expect(page.getByTestId("did-it-work")).not.toContainText(/verified improved/i);
    await scenario(page, "INEFFECTIVE_MITIGATION");
    await untilVerification(page, /not improving/i);
    await expect(page.getByTestId("did-it-work")).toContainText(/not improving/i);
    await expect(page.getByTestId("delivery-row")).toHaveCount(2);
    await steps(8);
    await reload(page);
    await expect(page.getByTestId("delivery-row")).toHaveCount(2);
  });

  test("SUCCESSFUL mitigation -> VERIFIED; RECURRENCE -> same case REOPENED, evidence kept", async ({
    page,
  }) => {
    await open(page);
    await detect(page);
    await acknowledgeAndReport(page);
    await scenario(page, "SUCCESSFUL_MITIGATION");
    await untilVerification(page, /verified/i);
    await expect(page.getByTestId("did-it-work")).toContainText(/verified improved/i);
    await expect(page.getByTestId("evidence-row").first()).toBeVisible();
    await expect(page.getByTestId("evidence-source")).toContainText(/simulat|synthetic/i);
    const before = await page.getByTestId("evidence-row").count();
    await scenario(page, "RECURRENCE");
    for (let i = 0; i < 12; i++) {
      await steps(3, false);
      await reload(page);
      if (/reopened/i.test(await page.getByTestId("case-state").innerText())) break;
    }
    await expect(page.getByTestId("case-state")).toContainText(/reopened/i);
    await expect(page.getByTestId("case-recurrences")).toContainText("1");
    expect(await page.getByTestId("evidence-row").count()).toBeGreaterThanOrEqual(before);
  });

  test("SENSOR FAILURE after an action is inconclusive, never verified", async ({ page }) => {
    await open(page);
    await detect(page);
    await acknowledgeAndReport(page);
    await scenario(page, "SENSOR_QUALITY_FAILURE");
    await untilVerification(page, /inconclusive/i);
    await expect(page.getByTestId("did-it-work")).not.toContainText(/verified improved/i);
  });

  test("WEATHER unavailable is shown as such and never as live weather", async ({ page }) => {
    await open(page);
    await page.getByTestId("sim-start").click();
    await expect(page.getByTestId("sim-status")).toContainText(/running/i);
    await page.getByTestId("weather-mode-live").check();
    await reload(page);
    await expect(page.getByTestId("sim-weather-chip")).toContainText(
      /WEATHER UNAVAILABLE|NOT CONFIGURED/i,
    );
    await page.getByTestId("weather-mode-simulated").click();
    await reload(page);
    await expect(page.getByTestId("sim-weather-chip")).toContainText(/SIMULATED WEATHER/);
  });

  test("CONSENT and REVOCATION: the insurer sees simulation evidence only while sharing is active", async ({
    page,
  }) => {
    await open(page);
    await detect(page);
    await acknowledgeAndReport(page);
    await scenario(page, "INEFFECTIVE_MITIGATION");
    await untilVerification(page, /not improving/i);
    await page.getByTestId("share-recipient").fill("ORG-INS-001");
    await page.getByTestId("share-grant").click();
    await expect(page.getByTestId("share-message")).toBeVisible();
    await page.goto("/");
    await switchTo(page, ENGINEER);
    await page.goto("/risk-evidence/sites");
    await expect(page.locator("main")).toContainText(/Northgate|FAC-SIM-PHX-01/);
    await page.goto("/");
    await switchTo(page, MGR);
    await page.goto(SIM);
    await page.getByTestId("share-revoke").first().click();
    await expect(page.getByTestId("share-message")).toBeVisible();
    await page.goto("/");
    await switchTo(page, ENGINEER);
    await page.goto("/risk-evidence/sites");
    await expect(page.locator("main")).not.toContainText(/Northgate|FAC-SIM-PHX-01/);
  });

  test("CROSS TENANT: another organization and an insurer cannot use the workspace or the proxy", async ({
    page,
  }) => {
    await startAs(page, OTHER_ORG_MGR);
    await page.goto(SIM);
    await expect(page.getByTestId("sim-workspace")).toHaveCount(0);
    for (const [method, path] of [
      ["GET", "/sim-api/simulation"],
      ["POST", "/sim-api/simulation/reset"],
      ["POST", "/sim-api/simulation/scenario"],
    ] as const) {
      const status = await page.evaluate(
        async ([m, p]) =>
          (
            await fetch(p as string, {
              method: m as string,
              headers: { "Content-Type": "application/json", "X-Symbiosis-Sim": "1" },
              ...(m === "POST" && {
                body: JSON.stringify({ confirm: "RESET", scenarioId: "NORMAL" }),
              }),
            })
          ).status,
        [method, path],
      );
      expect([401, 403, 404], `${method} ${path}`).toContain(status);
    }
    await page.goto("/");
    await switchTo(page, ENGINEER);
    const insurer = await page.evaluate(async () => (await fetch("/sim-api/simulation")).status);
    expect([401, 403, 404]).toContain(insurer);
    const outside = await page.evaluate(async () => (await fetch("/sim-api/me")).status);
    expect(outside).toBe(404);
  });

  test("RESET returns the demo facility to a clean state", async ({ page }) => {
    await open(page);
    await detect(page);
    await page.getByTestId("sim-reset-open").click();
    await page.getByTestId("sim-reset-confirm").fill("RESET");
    await page.getByTestId("sim-reset-go").click();
    await expect(page.getByTestId("sim-status")).toContainText(/stopped/i);
    await reload(page);
    await expect(page.getByTestId("case-empty")).toBeVisible();
  });

  test("INTEGRATION LAB: source payload -> mapping -> canonical -> ingested, and adapter equivalence", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("sim-start").click();
    await scenario(page, "NORMAL");
    await steps(3, false);
    await reload(page);
    const lab = page.getByTestId("integration-lab");
    await expect(lab).toBeVisible();
    await expect(page.getByTestId("adapter-flow")).toBeVisible();
    await expect(page.getByTestId("lab-payload")).toBeVisible();
    await expect(page.getByTestId("mapping-list")).toBeVisible();
    await page.getByTestId("lab-compare").click();
    await expect(page.getByTestId("compare-equivalent")).toContainText(/equivalent/i);
    await expect(lab).toContainText(/synthetic/i);
  });

  test("keyboard: a sensor node is reachable and selectable without a mouse", async ({ page }) => {
    await open(page);
    await page.getByTestId("sim-start").click();
    await scenario(page, "NORMAL");
    await steps(2, false);
    await reload(page);
    const node = page.getByTestId("node-SNS-ZONE-TEMP");
    await node.focus();
    await expect(node).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sensor-detail")).toBeVisible();
    await expect(page.getByTestId("sensor-status")).toBeVisible();
  });
});

test.describe("S10 responsive and accessibility", () => {
  const viewports = {
    desktop: { width: 1440, height: 900 },
    tablet: { width: 820, height: 1180 },
    mobile: { width: 390, height: 844 },
  };
  for (const [name, size] of Object.entries(viewports)) {
    test(`${name}: no overflow, no console errors, axe clean (with a case)`, async ({ page }) => {
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(e.message));
      page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
      await page.setViewportSize(size);
      await open(page);
      await detect(page);
      await noHorizontalScroll(page);
      await page.getByTestId("ack-button").click();
      await expect(page.getByTestId("case-message")).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(
        results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(" ")}`),
        `${name} axe`,
      ).toEqual([]);
      const wide = (await page.evaluate(
        `[...document.querySelectorAll("body *")]
          .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && e.closest(".table-wrap") === null)
          .slice(0, 8)
          .map((e) => e.tagName + "." + String(e.className).slice(0, 40) + " " + (e.getAttribute("data-testid") ?? ""))`,
      )) as string[];
      expect(wide, `${name}: elements wider than the viewport`).toEqual([]);
      await noHorizontalScroll(page);
      expect(problems).toEqual([]);
    });
  }
});
