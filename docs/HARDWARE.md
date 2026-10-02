# Hardware (removed from active scope)

**Physical hardware prototype: REMOVED FROM ACTIVE SCOPE BY PRODUCT DECISION** (D-085, 2026-10-02).

The ESP32 bench prototype was never accepted on hardware (gates H0 to H8 were not run and are not
claimed). Its firmware and bench tooling were deleted from the working tree; Git history keeps them
(last at commit `c55ecec`).

Symbiosis does not require proprietary sensors. Building-automation systems, IoT gateways, equipment
APIs and sensor platforms integrate through source adapters into the canonical observation contract
(`docs/ADAPTERS.md`). The signed edge boundary (`POST /edge/v1/telemetry`, `/edge/v1/heartbeat`,
`/edge/v1/source`) and the known-answer signing vectors in `firmware-contracts/` are what any such
integration implements. **No real BMS or vendor integration exists yet**; the facility simulation
(`/operations/simulation`) uses clearly labelled synthetic vendor profiles to prove the abstraction.
