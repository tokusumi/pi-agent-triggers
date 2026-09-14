# pi-agent-triggers

Event-driven external script triggers for [Pi](https://github.com/earendil-works/pi).

`pi-agent-triggers` runs a named executable script and wakes the Pi agent when the
script writes a JSON object as one line to stdout. Scripts are intentionally
external and reusable: install or write them in the configured trigger directories.

## Install

Use the package from a local checkout while developing:

```sh
pi -e ./index.ts
```

For a Pi package installation, add this repository to Pi's `packages` setting.

## Trigger protocol

- stdout: one JSON object per line; each line is an agent event
- stderr: diagnostic output shown as a warning
- exit: trigger process ended

Polling output does not wake the agent. A valid stdout event sends a follow-up
session message and triggers an agent turn.

## Discovery and settings

Default locations are:

- global: `~/.pi/agent/triggers/`
- project: `.pi/triggers/`
- project: `scripts/pi-agent-triggers/`

Project triggers override global triggers with the same filename. The effective
`piAgentTriggers` setting is the shallow merge of global and project Pi settings:

```json
{
  "piAgentTriggers": {
    "execution": "sandbox",
    "globalDir": "~/.pi/agent/triggers",
    "projectDirs": [".pi/triggers", "scripts/pi-agent-triggers"],
    "sandboxCommand": ["pi-sandbox", "exec", "--"]
  }
}
```

`host` execution is allowed for global triggers. Project-local triggers require
an explicit UI confirmation before host execution. `sandbox` delegates to the
configured command; this package does not implement its own sandbox.

Commands are `/trigger`, `/triggers`, `/trigger-stop`, and `/trigger-which`.
The corresponding tools are `trigger_start`, `trigger_list`, and `trigger_stop`.

## Development

```sh
npm test
```
