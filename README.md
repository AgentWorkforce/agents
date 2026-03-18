# @agentworkforce/agents

A tiny package for one thing:

**Which harnesses support which models.**

Model catalog is sourced from models.dev (fetched into `data/models.json`), and harness support rules are defined in `data/harness-models.json`.

## Install

```bash
npm i @agentworkforce/agents
```

## Usage

```js
import {
  getHarnesses,
  getModelsByHarness,
  getHarnessesByModel,
  getMatrix,
} from '@agentworkforce/agents';

getHarnesses();
getModelsByHarness('codex-cli');
getHarnessesByModel('openai/gpt-5');
getMatrix();
```

## Data model (minimal)

- `data/models.json` → models catalog (fetched from models.dev)
- `data/harness-models.json` → simple include/exclude rules by harness
- `dist/matrix.json` → generated final harness→models map

## Commands

```bash
npm run fetch:models   # refresh data/models.json from models.dev
npm run build          # regenerate dist/matrix.json
npm run validate       # validate harness rule file shape
```

## Notes

- This repo intentionally avoids complex scoring/metadata.
- “Less is more”: keep support mapping clear and maintainable.
- Harness overrides are preferred over inference when available (UI/probe truth beats wildcard rules).
