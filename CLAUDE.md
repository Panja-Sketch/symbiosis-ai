# CLAUDE.md — Symbiosis AI

`PROJECT_SPEC.md` is the locked architecture source of truth. This file does not duplicate it.

## Start of every session

1. Read `PROJECT_SPEC.md`, `docs/SESSION_HANDOFF.md`, `docs/IMPLEMENTATION_STATE.md`, `docs/DECISIONS.md`.
2. Run `git status` and `git log --oneline -10`.
3. Confirm the exact next task from `docs/SESSION_HANDOFF.md`.

## Rules

- Implement only the explicitly requested phase; never start the next phase unprompted.
- Never silently change the locked architecture; record any decision in `docs/DECISIONS.md`.
- Never bypass, skip, or delete failing tests to get green.
- Preserve deterministic lifecycle and verification boundaries: AI advises, deterministic code decides state, humans act, sensors verify. No LLM in verification, lifecycle, or intervention-level selection.
- No hardware/vendor names in domain logic; thresholds live versioned in `config/`.
- Never commit secrets; reference them by NAME only.
- No `Co-Authored-By` trailer on commits (see D-009).
- Phase gate: `pnpm lint`, `pnpm typecheck`, `pnpm test` must pass.

## End of every session

Update `docs/SESSION_HANDOFF.md` and `docs/IMPLEMENTATION_STATE.md` (and `docs/DECISIONS.md` if needed). No important state may exist only in chat.
