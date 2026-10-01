import { describe, expectTypeOf, it } from "vitest";
import type { CaseView } from "@symbiosis/action-orchestration";
import type { InsurerCaseView, InsurerInterventionView } from "@symbiosis/consent";
import type { CaseDto, InsurerCaseDto, InsurerInterventionDto } from "../../apps/web/src/lib/types";

/**
 * The web app declares its own DTOs (it may not import domain packages). These compile-time checks
 * keep them honest: whatever the backend's read models promise must be assignable to what the web
 * app expects, so a backend change that breaks a screen fails `pnpm typecheck`.
 */
describe("web DTOs match the backend read models", () => {
  it("CaseView -> CaseDto", () => {
    expectTypeOf<CaseView>().toExtend<Omit<CaseDto, "evidencePackages" | "sharingAgreements">>();
  });
  it("InsurerCaseView -> InsurerCaseDto", () => {
    expectTypeOf<InsurerCaseView>().toExtend<
      Omit<InsurerCaseDto, "rawTelemetry" | "packageHistory">
    >();
  });
  it("InsurerInterventionView -> InsurerInterventionDto", () => {
    expectTypeOf<InsurerInterventionView>().toExtend<InsurerInterventionDto>();
  });
});
