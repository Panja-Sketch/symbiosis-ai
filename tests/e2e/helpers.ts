import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export const CONTROL = "http://127.0.0.1:8792";
export const MGR = "USR-FACILITY-MGR-001";
export const OPERATOR = "USR-OPERATOR-001";
export const ENGINEER = "USR-RISK-ENGINEER-001";
export const OTHER_INSURER = "USR-OTHER-INSURER-RE-001";
export const OTHER_ORG_MGR = "USR-OTHER-ORG-MGR-001";

/** Drives only what a person cannot do in a browser: simulated time and simulator telemetry. */
export async function control(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL}/control/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

export const resetWorld = () => control("reset");

/** Uses the visible development identity switcher, like a person would. */
const ROLE_OF: Record<string, string> = {
  "USR-FACILITY-MGR-001": "Facility Manager",
  "USR-OPERATOR-001": "Operator",
  "USR-ORG-ADMIN-001": "Organization Admin",
  "USR-AUDITOR-001": "Auditor",
  "USR-RISK-ENGINEER-001": "Risk Engineer",
  "USR-UNDERWRITER-001": "Underwriter",
  "USR-OTHER-INSURER-RE-001": "Risk Engineer",
  "USR-OTHER-ORG-MGR-001": "Facility Manager",
};

/** Uses the visible development identity switcher, like a person would, and waits for it to take effect. */
export async function switchTo(page: Page, actorId: string): Promise<void> {
  await page.locator("#actorId").selectOption(actorId);
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  await expect(page.getByTestId("context")).toContainText(ROLE_OF[actorId] ?? actorId);
  await expect(page.locator("#actorId")).toHaveValue(actorId);
}

/** Open the site as a persona via the entry page. */
export async function startAs(page: Page, actorId: string): Promise<void> {
  await page.goto("/");
  await switchTo(page, actorId);
  await expect(page).toHaveURL(/\/(operations|risk-evidence)$/);
}

export async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = (await page.evaluate(
    "({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })",
  )) as { scroll: number; inner: number };
  expect(
    overflow.scroll,
    `page scrolls horizontally (${overflow.scroll} > ${overflow.inner})`,
  ).toBeLessThanOrEqual(overflow.inner);
}
