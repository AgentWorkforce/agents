# agents

A compatibility map for **models × harnesses**.

This repo is intended to be the “models.dev for harnesses” layer:
- pull model metadata from models.dev
- track which harnesses support which models
- store known-good settings per harness/model

## Initial scope

- ingest model catalog from models.dev (or mirror export)
- define a normalized harness registry
- maintain compatibility matrix with confidence + notes

## Data layout

- `data/models.json` — cached model catalog (from models.dev)
- `data/harnesses.json` — harness metadata and capabilities
- `data/compatibility.json` — model↔harness support matrix

## Commands

- `npm run fetch:models` — fetch/refresh models catalog
- `npm run validate` — validate schemas and matrix consistency

## Status

Bootstrapped. Ready to start adding harness support mappings.
