# @agentworkforce/agents

A tiny package for one thing:

**Which harnesses support which models.**

No inference. If we don't have evidence, it is marked unknown.

## Install

```bash
npm i @agentworkforce/agents
```

## Usage

```ts
import {
  getHarnesses,
  getModelsByHarness,
  getHarnessesByModel,
  getMatrix,
} from '@agentworkforce/agents';

getHarnesses();
getModelsByHarness('codex-cli');
getHarnessesByModel('gpt-5.4');
getMatrix();
```

## Data model (minimal)

- `data/harness-capabilities.json` → canonical known/unknown harness capability set
- `dist/matrix.json` → generated output for package consumers

## Commands

```bash
npm run validate       # validate known/unknown capability shape
npm run build          # regenerate dist/matrix.json from capabilities
```

## Policy

- Known means observed/proven (manual probe, docs, or automated test evidence).
- Unknown means we do not claim support.
- We do not infer support from provider catalogs.
