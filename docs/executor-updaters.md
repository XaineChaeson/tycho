# Executor CLI Updaters (`~/.tycho/executor-updaters.json`)

Tycho supports remote, idle-safe upgrades of installed executor CLIs (such as `codex`, `claude`, `gemini`, `dsh`) across all connected machines from the **Machines › CLI Updates** tab, as well as optional scheduled auto-updates.

## How Built-in Auto-Detection Works

When a machine receives an `update_executor` command, the node client:

1. Checks that **no Worker runs or native sign-ins are active** on the machine (otherwise returns `busy` so the Host keeps it queued until idle).
2. Checks for a machine-local override in `~/.tycho/executor-updaters.json`.
3. Otherwise detects how the executor binary was installed:
   - **`codex`**: `brew upgrade codex`, `pnpm add -g @openai/codex@latest`, `bun add -g @openai/codex@latest`, or `npm install -g @openai/codex@latest`
   - **`claude`**: `brew`, `pnpm`, `bun`, `npm` (`@anthropic-ai/claude-code@latest`), or built-in `claude update` for standalone binaries
   - **`gemini`**: `npm`/`pnpm`/`bun` (`@google/gemini-cli@latest`), `brew`, or `agy update`
   - **`dsh`**: `npm` global if installed via npm; desktop/internal bundles should configure `~/.tycho/executor-updaters.json`
4. Re-probes executors immediately after upgrading so the Host receives the new CLI version and updated model catalog within seconds.

## Zero-Cache-Leakage Hygiene

- Every built-in `npm install -g` invocation runs with `--no-audit --no-fund --prefer-online --cache <ephemeral-tmp-dir>`, and the temporary cache directory is unconditionally deleted in a `finally` block. Repeated upgrades accumulate **0 bytes** of extra npm `_cacache` garbage and never contend with the user's own `~/.npm` cache.
- Homebrew upgrades run with `HOMEBREW_NO_INSTALL_CLEANUP=0` so old cellars are pruned automatically.
- Upgrade job history on the Host is kept in a bounded in-memory ring buffer (max 30 entries, output tail capped at 3 KiB) with no log files written to disk.

## Machine-Local Overrides (`~/.tycho/executor-updaters.json`)

To use an internal mirror/registry, a private installer script, or disable remote updates on a specific machine, create `~/.tycho/executor-updaters.json` on that machine:

```json
{
  "codex": {
    "argv": ["npm", "install", "-g", "@openai/codex@latest", "--no-audit", "--no-fund"],
    "env": {
      "NPM_CONFIG_REGISTRY": "https://registry.example.com"
    },
    "timeoutMs": 180000
  },
  "dsh": {
    "argv": ["/usr/local/bin/update-dsh"]
  },
  "gemini": {
    "disabled": true
  }
}
```

### Fields

- `argv` (`string[]`, required unless `disabled: true`): exact executable and arguments (executed directly without shell interpolation).
- `env` (`Record<string, string>`, optional): extra environment variables merged on top of the node's lookup environment.
- `timeoutMs` (`number`, optional): command timeout in milliseconds (clamped to `5000..600000`, default `180000`).
- `disabled` (`boolean`, optional): when `true`, refuses remote updates for that executor on this machine.
