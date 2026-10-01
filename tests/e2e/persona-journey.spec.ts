import { expect, test } from "@playwright/test";
import {
  ENGINEER,
  MGR,
  OPERATOR,
  control,
  noHorizontalScroll,
  resetWorld,
  startAs,
  switchTo,
} from "./helpers";

/**
 * The hero journey of S7, in a real browser against the real local backend: a facility manager
 * works a detected case to VERIFIED IMPROVED, shares the evidence, an insurer sees exactly that,
 * and revoking removes the insurer's access.
 */
test.describe("hero journey", () => {
  test.beforeEach(async () => {
    await resetWorld();
  });

  test("detect, act, verify, prove, share, insurer view, revoke", async ({ page }) => {
    // 1. the facility manager opens Operations (nothing detected yet: an honest empty state)
    await startAs(page, MGR);
    await expect(page).toHaveURL(/\/operations$/);
    await expect(page.getByRole("heading", { name: "Operations", level: 1 })).toBeVisible();
    await expect(page.getByText("No risk-improvement cases yet")).toBeVisible();
    await expect(page.getByText("Demo identity")).toBeVisible();

    // the backend detects a persistent hazard from simulator telemetry
    const { caseId } = (await control("detect")) as { caseId: string };
    await page.reload();
    const row = page.locator(`tr[data-case-id="${caseId}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByText("Risk detected")).toBeVisible();
    await expect(page.locator('[data-stat="open"] .stat-value')).toHaveText("1");

    // 2. opens the detected case
    await row.getByRole("link", { name: "Cooling / electrical deterioration" }).click();
    await expect(page).toHaveURL(new RegExp(`/operations/cases/${caseId}$`));
    await expect(page.getByRole("heading", { name: "What happened", level: 2 })).toBeVisible();
    await expect(page.getByText("Vibration is well above its learned baseline")).toBeVisible();
    await expect(page.locator('[data-did-it-work="NOT_APPLICABLE_YET"]')).toBeVisible();

    // 3. acknowledges
    await page.getByRole("button", { name: "Acknowledge this risk" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Risk acknowledged" })).toBeVisible();

    // assigns an approved action to the operator (a recommendation; a person acts)
    await page
      .getByRole("combobox", { name: "Assign Inspect the primary cooling assembly to" })
      .selectOption(OPERATOR);
    await page
      .locator('li[data-action-library-id="ACT-COOLING-INSPECT-PRIMARY"]')
      .getByRole("button", { name: "Assign" })
      .click();
    await expect(page.getByRole("status").filter({ hasText: "Action assigned" })).toBeVisible();

    // 4. the operator takes over on the same case: acknowledge, then report
    await switchTo(page, OPERATOR);
    await expect(page).toHaveURL(new RegExp(`/operations/cases/${caseId}$`));
    await page.getByRole("button", { name: "Acknowledge assignment" }).click();
    await page.getByLabel("Notes (optional)").fill("Inspected the primary cooling assembly.");
    await page.getByRole("button", { name: "Report this action complete" }).click();

    // 5. VERIFICATION PENDING: reported is not verified
    const verdict = page.locator("#did-it-work .verdict");
    await expect(verdict).toContainText("VERIFICATION PENDING");
    await expect(page.locator(".two-states")).toContainText("Reported complete");
    await expect(page.locator(".two-states")).toContainText("Not verified");
    await expect(page.getByText("A report is not evidence that the risk improved")).toBeVisible();
    await expect(page.getByTestId("evidence-restricted")).toBeVisible();

    // 6. the backend completes the verification window with trusted, healthy readings
    await control("verify", { scenario: "normal" });
    await page.reload();
    await expect(verdict).toContainText("VERIFIED IMPROVED");
    await expect(page.locator(".two-states")).toContainText("Yes, by sensors");
    await expect(page.getByTestId("before-after")).toContainText("Before mitigation");
    await expect(page.getByTestId("before-after")).toContainText("After mitigation");
    await expect(page.locator("#did-it-work")).toContainText("VPOL-COOLING-ELECTRICAL");

    // the operator may act on the case but is not allowed to read evidence packages
    await expect(page.getByTestId("evidence-restricted")).toBeVisible();

    // 7. the facility manager sees the evidence package, with a live hash check and a synthetic label
    await switchTo(page, MGR);
    const evidence = page.getByTestId("evidence-panel");
    await expect(evidence).toContainText("Hash check passed");
    await expect(evidence).toContainText("Synthetic demo data");
    await expect(evidence).toContainText("EVP-");

    // 8. the facility manager grants scoped sharing; raw telemetry is not defaulted
    const sharing = page.getByTestId("sharing-panel");
    await expect(sharing).toHaveAttribute("data-sharing-state", "SHAREABLE");
    await expect(sharing.getByRole("checkbox", { name: /Verification outcome/ })).toBeChecked();
    await expect(sharing.locator('input[value="RAW_TELEMETRY"]')).toHaveCount(0);
    await sharing.getByRole("button", { name: "Share selected evidence" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sharing granted" })).toBeVisible();
    await expect(page.getByTestId("sharing-panel")).toHaveAttribute("data-sharing-state", "SHARED");
    await expect(page.locator('li.agreement[data-status="ACTIVE"]')).toContainText(
      "Synthetic Insurer One",
    );

    // 9-10. the insurer persona sees the consented evidence
    await switchTo(page, ENGINEER);
    await expect(page).toHaveURL(/\/risk-evidence$/);
    await expect(page.getByRole("heading", { name: "Risk Evidence", level: 1 })).toBeVisible();
    await expect(page.locator('[data-stat="sites"] .stat-value')).toHaveText("1");
    await expect(page.locator('[data-stat="verified"] .stat-value')).toHaveText("1");
    await page
      .locator(`tr[data-case-id="${caseId}"]`)
      .getByRole("link", { name: /Cooling/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "Verification outcome", level: 2 }),
    ).toBeVisible();
    await expect(page.locator("#verification .verdict")).toContainText("VERIFIED IMPROVED");
    await expect(page.getByTestId("evidence-panel")).toContainText("Hash verified before release");
    await expect(page.locator("#before-after")).toContainText("Before mitigation");
    await expect(page.locator("#intervention")).toContainText("Remote Monitoring");
    // no operations surface for the insurer persona
    await page.goto("/operations");
    await expect(
      page.getByRole("heading", { name: "Not available to this identity" }),
    ).toBeVisible();

    // 11. back as the customer: revoke
    await switchTo(page, MGR);
    await page.goto(`/operations/cases/${caseId}`);
    await page.getByRole("button", { name: /Revoke access for Synthetic Insurer One/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sharing revoked" })).toBeVisible();
    await expect(page.getByTestId("sharing-panel")).toHaveAttribute(
      "data-sharing-state",
      "REVOKED",
    );
    await expect(page.locator('li.agreement[data-status="REVOKED"]')).toBeVisible();

    // 12. the insurer's access disappears at once
    await switchTo(page, ENGINEER);
    await page.goto(`/risk-evidence/cases/${caseId}`);
    await expect(page.getByRole("heading", { name: "Sharing was revoked" })).toBeVisible();
    await page.goto("/risk-evidence");
    await expect(page.getByText("No sites are shared with you")).toBeVisible();
    await noHorizontalScroll(page);
  });
});
