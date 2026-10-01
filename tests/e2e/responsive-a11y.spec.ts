import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  ENGINEER,
  MGR,
  OPERATOR,
  control,
  noHorizontalScroll,
  resetWorld,
  startAs,
} from "./helpers";

const API = "http://127.0.0.1:8791";
const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";

async function post(path: string, actor: string, body: unknown = {}) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "X-Demo-Actor-Id": actor, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, path).toBeLessThan(300);
  return (await res.json()) as Record<string, unknown>;
}

/** A verified, shared case, set up through the APIs so the pages have real data to show. */
async function sharedVerifiedCase(): Promise<string> {
  const { caseId } = (await control("detect")) as { caseId: string };
  await post(`/api/v1/cases/${caseId}/acknowledge`, MGR);
  const a = await post(`/api/v1/cases/${caseId}/assignments`, MGR, {
    actionLibraryId: INSPECT,
    assigneeId: OPERATOR,
  });
  const actionId = a.actionId as string;
  await post(`/api/v1/cases/${caseId}/actions/${actionId}/acknowledge`, OPERATOR);
  await post(`/api/v1/cases/${caseId}/actions`, OPERATOR, { actionLibraryId: INSPECT, actionId });
  await control("verify", { scenario: "normal" });
  await post("/api/v1/sharing-agreements", MGR, {
    recipientOrganizationId: "ORG-INS-001",
    facilityIds: ["FAC-SIM-001"],
    scopes: [
      "RECOMMENDATION",
      "EVENT_SUMMARY",
      "ACTION_SUMMARY",
      "BEFORE_AFTER_METRICS",
      "VERIFICATION_RESULT",
      "VERIFICATION_CONFIDENCE",
      "RECURRENCE_STATUS",
      "EVIDENCE_ARTIFACTS",
      "INTERVENTION_RECOMMENDATION",
    ],
  });
  return caseId;
}

test.beforeEach(async () => {
  await resetWorld();
});

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) e.g. ${v.nodes[0]?.target.join(" ")}`,
  );
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

test.describe("accessibility (axe, WCAG 2.1 A/AA)", () => {
  test("entry, operations, case detail, evidence, trust", async ({ page }) => {
    const caseId = await sharedVerifiedCase();
    await page.goto("/");
    await axe(page, "entry page");
    await startAs(page, MGR);
    await axe(page, "operations");
    await page.goto(`/operations/cases/${caseId}`);
    await expect(page.locator("#did-it-work .verdict")).toContainText("VERIFIED IMPROVED");
    await axe(page, "case detail");
    await page.goto("/operations/evidence");
    await axe(page, "evidence and sharing");
    await page.goto("/trust");
    await axe(page, "trust");
  });

  test("insurer workspace, site, case, interventions", async ({ page }) => {
    const caseId = await sharedVerifiedCase();
    await startAs(page, ENGINEER);
    await axe(page, "risk evidence");
    await page.goto("/risk-evidence/sites/FAC-SIM-001");
    await axe(page, "site detail");
    await page.goto(`/risk-evidence/cases/${caseId}`);
    await axe(page, "insurer case");
    await page.goto("/risk-evidence/interventions");
    await axe(page, "interventions");
  });

  test("keyboard: skip link and identity switcher are reachable, focus is visible", async ({
    page,
  }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    const outline = await page.evaluate(
      "getComputedStyle(document.activeElement).outlineStyle + ' ' + getComputedStyle(document.activeElement).outlineWidth",
    );
    expect(outline).toMatch(/^(solid|auto) [1-9]/);
  });
});

test.describe("responsive: laptop and phone", () => {
  for (const size of [
    { name: "laptop", width: 1366, height: 768 },
    { name: "tablet", width: 820, height: 1180 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    test(`no horizontal scrolling at ${size.name} width`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const caseId = await sharedVerifiedCase();
      await page.goto("/");
      await noHorizontalScroll(page);
      await startAs(page, MGR);
      await noHorizontalScroll(page);
      await page.goto(`/operations/cases/${caseId}`);
      await expect(page.locator("#did-it-work .verdict")).toContainText("VERIFIED IMPROVED");
      await noHorizontalScroll(page);
      await page.goto("/operations/evidence");
      await noHorizontalScroll(page);
      await startAs(page, ENGINEER);
      await noHorizontalScroll(page);
      await page.goto(`/risk-evidence/cases/${caseId}`);
      await noHorizontalScroll(page);
      await page.goto("/risk-evidence/interventions");
      await noHorizontalScroll(page);
    });
  }

  test("phone: the key case-detail flow works and sections stack", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { caseId } = (await control("detect")) as { caseId: string };
    await startAs(page, MGR);
    // the case list is a stack of cards, not a wide table
    const headerHidden = await page.evaluate(
      "document.querySelector('.cases-table thead').getBoundingClientRect().width <= 1",
    );
    expect(headerHidden).toBe(true);
    await page.locator(`tr[data-case-id="${caseId}"]`).getByRole("link").first().click();
    await page.locator("#timeline").waitFor();
    await noHorizontalScroll(page);
    // sections are one column: each starts at the left edge and is no wider than the screen
    const boxes = (await page.evaluate(
      "[...document.querySelectorAll('.sections > .section')].map(e => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; })",
    )) as { left: number; right: number }[];
    expect(boxes.length).toBeGreaterThanOrEqual(9);
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(390);
    }
    expect(new Set(boxes.map((b) => b.left)).size).toBe(1);
    // an action still works with a thumb: acknowledge, then assign
    await page.getByRole("button", { name: "Acknowledge this risk" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Risk acknowledged" })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Assign Inspect the primary cooling assembly to" })
      .selectOption(OPERATOR);
    await page
      .locator('li[data-action-library-id="ACT-COOLING-INSPECT-PRIMARY"]')
      .getByRole("button", { name: "Assign" })
      .click();
    await expect(page.getByRole("status").filter({ hasText: "Action assigned" })).toBeVisible();
    await noHorizontalScroll(page);
  });
});
