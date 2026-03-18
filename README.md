# @agentworkforce/agents

A list of harnesses + models they support. Pull Requests appreciated!

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
