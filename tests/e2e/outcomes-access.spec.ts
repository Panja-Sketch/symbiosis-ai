import { expect, test } from "@playwright/test";
import {
  ENGINEER,
  MGR,
  OPERATOR,
  OTHER_INSURER,
  OTHER_ORG_MGR,
  control,
  resetWorld,
  startAs,
} from "./helpers";

const API = "http://127.0.0.1:8791";
const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";

async function api(path: string, actor: string, body: unknown = {}) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "X-Demo-Actor-Id": actor, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, `${path}: ${await res.clone().text()}`).toBeLessThan(300);
  return (await res.json()) as Record<string, unknown>;
}

/** Detect a hazard and have the people report an action, through the application API. */
async function reported(): Promise<string> {
  const { caseId } = (await control("detect")) as { caseId: string };
  await api(`/api/v1/cases/${caseId}/acknowledge`, MGR);
  const a = await api(`/api/v1/cases/${caseId}/assignments`, MGR, {
    actionLibraryId: INSPECT,
    assigneeId: OPERATOR,
  });
  const actionId = a.actionId as string;
  await api(`/api/v1/cases/${caseId}/actions/${actionId}/acknowledge`, OPERATOR);
  await api(`/api/v1/cases/${caseId}/actions`, OPERATOR, {
    actionLibraryId: INSPECT,
    actionId,
    notes: "Inspected.",
  });
  return caseId;
}

test.beforeEach(async () => {
  await resetWorld();
});

test.describe("every verification outcome is shown as itself", () => {
  const cases = [
    {
      scenario: "normal",
      label: "VERIFIED IMPROVED",
      status: "VERIFIED_IMPROVED",
      pkg: "Verified improved",
    },
    {
      scenario: "partial-improvement",
      label: "PARTIALLY VERIFIED",
      status: "PARTIALLY_VERIFIED",
      pkg: "Partially verified",
    },
    {
      scenario: "compound-outdoor-heat",
      label: "NOT IMPROVING",
      status: "NOT_IMPROVING",
      pkg: "Not improving",
    },
  ] as const;
  for (const c of cases) {
    test(`${c.label}`, async ({ page }) => {
      const caseId = await reported();
      await startAs(page, MGR);
      await page.goto(`/operations/cases/${caseId}`);
      await expect(page.locator("#did-it-work .verdict")).toContainText("VERIFICATION PENDING");
      await control("verify", { scenario: c.scenario });
      await page.reload();
      const verdict = page.locator("#did-it-work .verdict");
      await expect(verdict).toHaveAttribute("data-did-it-work", c.status);
      await expect(verdict).toContainText(c.label);
      // a package is created whatever the result, and it records that result faithfully
      await expect(page.getByTestId("evidence-panel")).toContainText(c.pkg);
    });
  }

  test("INCONCLUSIVE when no trusted readings arrive", async ({ page }) => {
    const caseId = await reported();
    await startAs(page, MGR);
    await control("expire");
    await page.goto(`/operations/cases/${caseId}`);
    await expect(page.locator("#did-it-work .verdict")).toHaveAttribute(
      "data-did-it-work",
      "INCONCLUSIVE",
    );
    await expect(page.locator("#did-it-work .verdict")).toContainText("INCONCLUSIVE");
    await expect(
      page.locator('li[data-action-library-id="ACT-COOLING-INSPECT-MECHANICAL"]'),
    ).toBeVisible();
  });

  test("REOPENED: the same case, history kept", async ({ page }) => {
    const caseId = await reported();
    await control("verify", { scenario: "normal" });
    await control("recur");
    await startAs(page, MGR);
    await page.goto(`/operations/cases/${caseId}`);
    await expect(page.getByTestId("recurrence-count")).toHaveText("1");
    await expect(page.getByTestId("reopened-history")).toContainText("This case was reopened");
    await expect(page.getByTestId("reopened-history")).toContainText("Verified improved");
    await expect(page.getByTestId("next-step")).toContainText("returned");
    await expect(page.locator(".page-header .badge").first()).toContainText("Reopened");
    // the intervention recommendation escalated to a risk engineer review (a recommendation only)
    await expect(page.locator("#why-it-matters")).toContainText("Risk Engineer Review");
    await expect(page.locator("#why-it-matters")).not.toContainText(/dispatched|scheduled/i);
    await page.goto("/operations");
    await expect(page.locator('[data-stat="recurrence"] .stat-value')).toHaveText("1");
    await expect(page.locator(`tr[data-case-id="${caseId}"]`)).toContainText("Reopened");
  });
});

test.describe("authorization is the API's, and the UI reports it", () => {
  test("a facility identity cannot open the insurer workspace, and vice versa", async ({
    page,
  }) => {
    await control("detect");
    await startAs(page, MGR);
    await page.goto("/risk-evidence");
    await expect(
      page.getByRole("heading", { name: "Not available to this identity" }),
    ).toBeVisible();
    await startAs(page, ENGINEER);
    await page.goto("/operations");
    await expect(
      page.getByRole("heading", { name: "Not available to this identity" }),
    ).toBeVisible();
    await expect(page.locator(".empty-denied")).not.toContainText(/stack|TypeError|at Object/);
  });

  test("another organization cannot see the case; an insurer sees nothing until consent", async ({
    page,
  }) => {
    const caseId = await reported();
    await control("verify", { scenario: "normal" });
    await startAs(page, OTHER_ORG_MGR);
    await expect(page.getByText("No risk-improvement cases yet")).toBeVisible();
    await page.goto(`/operations/cases/${caseId}`);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();

    await startAs(page, ENGINEER);
    await expect(page.getByText("No sites are shared with you")).toBeVisible();
    await page.goto(`/risk-evidence/cases/${caseId}`);
    await expect(page.getByRole("heading", { name: "Not shared with you" })).toBeVisible();
    await page.goto("/risk-evidence/sites/FAC-SIM-001");
    await expect(
      page.getByRole("heading", { name: "This site is not shared with you" }),
    ).toBeVisible();
  });

  test("consent filtering: the insurer sees only the granted scopes; another insurer sees nothing", async ({
    page,
  }) => {
    const caseId = await reported();
    await control("verify", { scenario: "normal" });
    // the customer shares only the verification outcome and the evidence package details
    await api("/api/v1/sharing-agreements", MGR, {
      recipientOrganizationId: "ORG-INS-001",
      facilityIds: ["FAC-SIM-001"],
      scopes: ["VERIFICATION_RESULT", "EVIDENCE_ARTIFACTS"],
    });
    await startAs(page, ENGINEER);
    await page.goto(`/risk-evidence/cases/${caseId}`);
    await expect(page.locator("#verification .verdict")).toContainText("VERIFIED IMPROVED");
    await expect(page.getByTestId("evidence-panel")).toContainText("EVP-");
    await expect(page.locator('[data-not-shared="BEFORE_AFTER_METRICS"]')).toBeVisible();
    await expect(page.locator('[data-not-shared="ACTION_SUMMARY"]')).toBeVisible();
    await expect(page.locator('[data-not-shared="RECURRENCE_STATUS"]')).toBeVisible();
    await expect(page.getByTestId("not-shared-list")).toContainText("Before / after measurements");
    await expect(page.locator("#before-after")).not.toContainText("Before mitigation");
    // raw telemetry is never part of this view
    await expect(page.locator("main")).not.toContainText("RAW_TELEMETRY");

    await startAs(page, OTHER_INSURER);
    await expect(page.getByText("No sites are shared with you")).toBeVisible();
    await page.goto(`/risk-evidence/cases/${caseId}`);
    await expect(page.getByRole("heading", { name: "Not shared with you" })).toBeVisible();
  });
});

test.describe("intervention wording never implies dispatch", () => {
  test("a recurrence yields a recommendation, not a scheduled engineer", async ({ page }) => {
    const caseId = await reported();
    await control("verify", { scenario: "normal" });
    await api("/api/v1/sharing-agreements", MGR, {
      recipientOrganizationId: "ORG-INS-001",
      facilityIds: ["FAC-SIM-001"],
      scopes: [
        "RECOMMENDATION",
        "INTERVENTION_RECOMMENDATION",
        "VERIFICATION_RESULT",
        "RECURRENCE_STATUS",
        "EVIDENCE_ARTIFACTS",
      ],
    });
    await control("recur");
    await startAs(page, ENGINEER);
    await page.goto("/risk-evidence/interventions");
    const card = page.locator(`li[data-case-id="${caseId}"]`);
    await expect(card).toContainText("Risk Engineer Review");
    await expect(card).toContainText("Decision support only");
    await expect(card).toContainText("Evidence sufficiency");
    await expect(card).toContainText("The hazard returned after a verified improvement");
    await expect(page.locator("main")).not.toContainText(
      /dispatched|has been scheduled|engineer is on the way/i,
    );
  });
});
