import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startS7Backend } from "./s7-backend";

/**
 * S7 smoke test: the persona web experience over the real local backend (simulated clock).
 * Starts the backend and the production build of the Next.js app, then drives a browser through
 * the facility and insurer personas and a phone-width case page. Exits non-zero on any failure.
 * Run through `pnpm smoke:s7`, which builds the web app first.
 */
let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passes += 1;
  else failures += 1;
}

const MGR = "USR-FACILITY-MGR-001";
const OPERATOR = "USR-OPERATOR-001";
const RE = "USR-RISK-ENGINEER-001";
const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";
const WEB_PORT = 3101;
const web = `http://127.0.0.1:${WEB_PORT}`;

const backend = await startS7Backend({ apiPort: 8793, controlPort: 8794 });
const nextBin = join(
  import.meta.dirname,
  "..",
  "apps",
  "web",
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);
const server = spawn(process.execPath, [nextBin, "start", "-p", String(WEB_PORT)], {
  cwd: join(import.meta.dirname, "..", "apps", "web"),
  env: { ...process.env, SYMBIOSIS_API_URL: backend.apiUrl },
  stdio: "ignore",
});

async function waitForWeb(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${web}/trust`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("web app did not start");
}

const api = async (path: string, actor: string, body: unknown = {}) => {
  const res = await fetch(`${backend.apiUrl}${path}`, {
    method: "POST",
    headers: { "X-Demo-Actor-Id": actor, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const switchTo = async (page: Page, actor: string) => {
  await page.goto(`${web}/`);
  await page.locator("#actorId").selectOption(actor);
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  await page.waitForURL(/\/(operations|risk-evidence)$/);
};
/** The rendered main text, once the route has finished loading. */
const text = async (page: Page) => {
  await page.waitForFunction("!document.querySelector('.loading')");
  return (await page.locator("main").innerText()).replace(/\s+/g, " ");
};

try {
  await waitForWeb();
  console.log(`web ${web}  api ${backend.apiUrl} (simulated time, development identity)\n`);
  check(
    "1. web app started and serves the trust page",
    (await fetch(`${web}/trust`)).status === 200,
  );

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });

  console.log("-- facility persona --");
  const caseId = await backend.detect();
  await switchTo(page, MGR);
  check("2. facility persona lands on Operations", page.url().endsWith("/operations"));
  const ops = await text(page);
  check(
    "3. Operations lists the real backend case with its state",
    ops.includes(caseId) && ops.includes("Risk detected") && ops.includes("Open cases"),
  );

  await page.getByRole("link", { name: "Cooling / electrical deterioration" }).first().click();
  await page.getByRole("button", { name: "Acknowledge this risk" }).click();
  await page.locator("#feedback").waitFor();
  const a = await api(`/api/v1/cases/${caseId}/assignments`, MGR, {
    actionLibraryId: INSPECT,
    assigneeId: OPERATOR,
  });
  check("4a. approved action assigned through the API", a.status === 201, String(a.status));
  const actionId = a.body.actionId as string;
  await api(`/api/v1/cases/${caseId}/actions/${actionId}/acknowledge`, OPERATOR);
  await api(`/api/v1/cases/${caseId}/actions`, OPERATOR, { actionLibraryId: INSPECT, actionId });
  await page.reload();
  check(
    "4. a reported action shows VERIFICATION PENDING, not a result",
    (await text(page)).includes("VERIFICATION PENDING") &&
      !(await text(page)).includes("Yes, by sensors"),
  );

  await backend.verify("normal");
  await page.reload();
  const verified = await text(page);
  check(
    "5. case detail shows VERIFIED IMPROVED with policy, before/after and confidence",
    verified.includes("VERIFIED IMPROVED") &&
      verified.includes("VPOL-COOLING-ELECTRICAL") &&
      verified.includes("Before mitigation") &&
      verified.includes("Telemetry confidence"),
  );
  check(
    "6. the evidence package appears with a passing hash check and a synthetic label",
    verified.includes("EVP-") &&
      verified.includes("Hash check passed") &&
      verified.includes("Synthetic demo data"),
  );
  check(
    "7. raw telemetry is not offered or defaulted to this role",
    (await page.locator('input[value="RAW_TELEMETRY"]').count()) === 0,
  );

  await page.getByRole("button", { name: "Share selected evidence" }).click();
  await page.getByText("Sharing granted").waitFor();
  check(
    "8. sharing controls work: the case is SHARED with the insurer",
    (await page.getByTestId("sharing-panel").getAttribute("data-sharing-state")) === "SHARED",
  );

  console.log("\n-- insurer persona --");
  await switchTo(page, RE);
  const risk = await text(page);
  check(
    "9. insurer persona sees the consented site and verified outcome",
    page.url().endsWith("/risk-evidence") &&
      risk.includes("FAC-SIM-001") &&
      risk.includes("Verified improved"),
  );
  await page.goto(`${web}/risk-evidence/cases/${caseId}`);
  const detail = await text(page);
  check(
    "10. insurer case shows scoped evidence, the recommendation and no dispatch wording",
    detail.includes("VERIFIED IMPROVED") &&
      detail.includes("Hash verified before release") &&
      detail.includes("Remote Monitoring") &&
      !/dispatched|has been scheduled/i.test(detail),
  );
  await page.goto(`${web}/operations`);
  check(
    "11. the insurer persona is refused the operations workspace (API 403, shown in words)",
    (await text(page)).includes("Not available to this identity"),
  );

  console.log("\n-- revoke --");
  await switchTo(page, MGR);
  await page.goto(`${web}/operations/cases/${caseId}`);
  await page.getByRole("button", { name: /Revoke access for/ }).click();
  await page.getByText("Sharing revoked").waitFor();
  await switchTo(page, RE);
  await page.goto(`${web}/risk-evidence/cases/${caseId}`);
  check(
    "12. revoke removes insurer access at once",
    (await text(page)).includes("Sharing was revoked"),
  );
  await page.goto(`${web}/risk-evidence`);
  check(
    "13. the insurer sees no shared sites after revocation",
    (await text(page)).includes("No sites are shared"),
  );

  console.log("\n-- phone width --");
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await switchTo(phone, MGR);
  await phone.goto(`${web}/operations/cases/${caseId}`);
  const width = (await phone.evaluate(
    "({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })",
  )) as { scroll: number; inner: number };
  check(
    "14. the case page loads at phone width without horizontal overflow",
    width.scroll <= width.inner && (await text(phone)).includes("Did it work?"),
    `${width.scroll} <= ${width.inner}`,
  );
  await browser.close();
} catch (e) {
  check("smoke run completed", false, e instanceof Error ? e.message : String(e));
} finally {
  server.kill();
  await backend.close();
}

console.log(`\n${passes} PASS, ${failures} FAIL`);
console.log(failures === 0 ? "SMOKE TEST S7 PASSED" : `SMOKE TEST S7 FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
