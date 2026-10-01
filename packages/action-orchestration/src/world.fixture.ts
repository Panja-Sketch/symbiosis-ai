import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RiskDetection } from "@symbiosis/contracts";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import { InMemoryBus, SequentialIdGenerator } from "@symbiosis/event-bus";
import {
  InMemoryActionRepository,
  InMemoryAlertRepository,
  InMemoryCaseRepository,
  InMemoryRiskEventRepository,
} from "@symbiosis/repositories";
import { applyRiskEventCommand, openCaseFromDetection } from "@symbiosis/risk-lifecycle";
import type { RiskEventCommand } from "@symbiosis/risk-lifecycle";
import { createSyntheticActorDirectory } from "@symbiosis/tenancy";
import { createOperations } from "./operations";
import { parseActionLibrary } from "./library";

export const ORG = "ORG-SIM-001";
export const FAC = "FAC-SIM-001";
export const MGR = "USR-FACILITY-MGR-001";
export const OPERATOR = "USR-OPERATOR-001";
export const ADMIN = "USR-ORG-ADMIN-001";
export const AUDITOR = "USR-AUDITOR-001";
export const OTHER_ORG_MGR = "USR-OTHER-ORG-MGR-001";

export const library = parseActionLibrary(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "config",
        "action-library",
        "cooling-actions.v1.json",
      ),
      "utf8",
    ),
  ),
);

export const detection: RiskDetection = {
  detectionId: "DET-1",
  organizationId: ORG,
  facilityId: FAC,
  ruleId: "R",
  ruleVersion: "1",
  hazardType: "COOLING_ELECTRICAL_DETERIORATION",
  primaryAssetId: "AST-SIM-FAN-A",
  contextAssetIds: ["AST-SIM-OUTDOOR"],
  severity: "MODERATE",
  confidence: 1,
  detectedAt: "2026-10-01T00:00:00.000Z",
  reasonCodes: ["VIBRATION_Z_AT_OR_ABOVE_THRESHOLD", "OUTDOOR_HEAT_CONTEXT"],
  supportingObservationIds: [],
  baselineIds: [],
  persistence: { qualifyingEvaluations: 3, required: 3 },
  metrics: {},
};

/** A self-contained world: one detected case whose event is ALERTED unless told otherwise. */
export async function makeWorld(eventCommands: RiskEventCommand[] | "ALERTED" = "ALERTED") {
  const clock = new ManualClock(Date.parse("2026-10-01T00:10:00Z"));
  const bus = new InMemoryBus();
  const ids = new SequentialIdGenerator();
  const cases = new InMemoryCaseRepository();
  const riskEvents = new InMemoryRiskEventRepository();
  const actions = new InMemoryActionRepository();
  const alerts = new InMemoryAlertRepository();
  const audit = new InMemoryAuditLog();
  const directory = createSyntheticActorDirectory();
  const operations = createOperations({
    cases,
    riskEvents,
    actions,
    alerts,
    audit,
    bus,
    ids,
    clock,
    library,
    directory,
  });

  const opened = openCaseFromDetection({
    detection,
    caseId: "CASE-1",
    eventId: "RE-1",
    baselineSnapshotId: "BSNAP-1",
  });
  if (!opened.ok) throw new Error("fixture");
  let event = opened.value.event;
  const commands: RiskEventCommand[] =
    eventCommands === "ALERTED"
      ? [{ type: "ALERT", at: "2026-10-01T00:05:00.000Z" }]
      : eventCommands;
  for (const c of commands) {
    const r = applyRiskEventCommand(event, c);
    if (!r.ok) throw new Error(`fixture transition failed: ${r.error.code}`);
    event = r.value.value;
  }
  await cases.save(opened.value.case);
  await riskEvents.save(event);
  return { clock, bus, ids, cases, riskEvents, actions, alerts, audit, directory, operations };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

export async function actor(world: World, id: string) {
  const a = await world.directory.get(id);
  if (a === undefined) throw new Error(`no actor ${id}`);
  return a;
}
