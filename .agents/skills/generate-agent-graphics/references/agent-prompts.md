# Agent Graphic Prompts

Use these prompts as the baseline. Replace only the agent metaphor, accent
color, and asset type.

## Avatar Prompt Template

```text
Create a square 1024x1024 polished 3D editorial icon for an AI agent named <Agent Name>. Show <metaphor>. Dark graphite studio background, luminous glass and brushed-metal materials, <accent> accent, centered composition, high contrast, generous padding, recognizable at small size. No text, no letters, no logo, no watermark.
```

## Card Prompt Template

```text
Create a 16:9 README/social banner illustration for an AI agent named <Agent Name>. Show <metaphor> as the central subject with slightly more environmental detail than an icon, but keep the composition clean and readable. Dark graphite studio background, luminous glass and brushed-metal materials, <accent> accent, cinematic studio lighting, high contrast, generous negative space for surrounding README layout. No text, no letters, no logo, no watermark.
```

## Banner Crop Rule

Create `banner.png` from the selected `card.png` as a centered 1400x392 crop.
This matches the Agent Relay README banner format and keeps agent README images
full-width without being too tall.

## Agent Prompt Map

### granola

Metaphor: meeting transcript pages transforming into a bright feature spark and
a small pull-request branch symbol.

Accent: warm gold.

### hn-monitor

Metaphor: a compact radar dish scanning floating orange news/story cards and
signal dots.

Accent: orange.

### linear

Metaphor: a task ticket moving through a precise conveyor into a clean
pull-request branch symbol.

Accent: blue-violet.

### repo-hygiene

Metaphor: a microscope inspecting a codebase blueprint with highlighted
duplicate paths and a few cleanly pruned dead branches.

Accent: teal.

### review

Metaphor: a strong shield in front of a code diff checklist with small green CI
status lights.

Accent: emerald.

### spotify-releases

Metaphor: a glowing vinyl record emitting release pulse waves and small abstract
music-note shapes.

Accent: neon green.

### vendor-monitor

Metaphor: a package cube with orbiting dependency nodes being scanned by a radar
beam.

Accent: amber.

## Naming Display Map

Use these display names for alt text and prompt names:

| Folder | Display Name |
| --- | --- |
| `granola` | Granola Prospect Agent |
| `hn-monitor` | HN Monitor |
| `linear` | Linear Implementer |
| `repo-hygiene` | Repo Hygiene |
| `review` | PR Reviewer |
| `spotify-releases` | Spotify Releases |
| `vendor-monitor` | Vendor Monitor |
