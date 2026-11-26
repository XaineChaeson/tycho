# Synthetic fixture: dsh agent-instructions behavior notes

Minimal synthetic test fixture capturing the documented user-global instruction behavior of `dsh` (`0.2.2-rc.1`) asserted by `tests/global-entry.test.ts`.

- Resolution order for the user-global chain: `$DSH_HOME/AGENTS.md`, then `<agentsHome>/AGENTS.md` (where `<agentsHome>` resolves from `$DSH_AGENTS_HOME` or `~/.agents`).
- Default per-chain byte budget in `dsh-base`:
  ```yaml
  maxBytes: 65536
  ```
- Truncation/omission priority: when over budget, broader files are dropped first, with the harness-home file omitted before the shared-root file.
