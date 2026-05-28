---
name: generate-agent-graphics
description: Create consistent, memorable visual graphics for AgentWorkforce agents in the agents repo. Use when asked to generate, design, refresh, or wire README graphics, avatars, badges, cards, banners, or visual identity assets for folders such as granola, hn-monitor, linear, repo-hygiene, review, spotify-releases, and vendor-monitor.
---

# Generate Agent Graphics

## Goal

Create a recognizable family of bitmap graphics for each deployable agent while
keeping every agent visually distinct. Prefer generated PNG assets over Canva
or SVG unless the user explicitly asks for Canva or vector output.

## Output Contract

For each target agent folder, create:

- `avatar.png` — square 1024x1024 hero icon, recognizable at small size.
- `card.png` — 16:9 README/social card using the same metaphor.
- `banner.png` — 1400x392 README banner crop, matching the relay README
  image format: full width, not too tall.

Do not put text, agent names, logos, watermarks, or fake UI copy inside the
generated image. Add labels in Markdown, not in pixels.

## Visual System

Use one shared style for all agents:

> Polished 3D editorial icon, dark graphite studio background, luminous glass
> and brushed-metal object, one distinctive accent color, clean studio lighting,
> centered composition, high contrast, generous padding, no text, no logo, no
> watermark.

Use distinct metaphors and accent colors:

| Agent | Metaphor | Accent |
| --- | --- | --- |
| `granola` | meeting transcript pages becoming a feature spark and PR branch | warm gold |
| `hn-monitor` | radar dish scanning floating news/story cards | orange |
| `linear` | task ticket moving through a conveyor into a PR branch | blue-violet |
| `repo-hygiene` | microscope over codebase blueprint, duplicate paths, pruned dead branches | teal |
| `review` | shield, code diff checklist, green CI lights | emerald |
| `spotify-releases` | glowing vinyl record emitting release pulse waves | neon green |
| `vendor-monitor` | package cube with orbiting dependency nodes and radar beam | amber |

Read `references/agent-prompts.md` for ready-to-use prompts and prompt rewrite
rules.

## Workflow

1. Identify target agent folders from the user request. If none are specified,
   use every top-level folder with both `persona.ts` and `agent.ts`.
2. Generate `avatar.png` first for each agent using the built-in image
   generation tool. Use one image-generation call per agent so the metaphor can
   be specific.
3. Generate `card.png` for each agent using the same metaphor and accent color,
   but request a 16:9 README/social banner composition.
4. Create `banner.png` from `card.png` as a centered 1400x392 crop so README
   images fill the content width without becoming too tall.
5. Save final selected files into the agent folders. Never leave project assets
   only in `$CODEX_HOME/generated_images`.
6. Update READMEs to display the banner near the top using the same pattern as
   the relay README. Use:

   ```md
   <img src="./banner.png" alt="<Agent Name>">
   ```

7. Run the README helper if useful:

   ```bash
   python .agents/skills/generate-agent-graphics/scripts/apply_readme_images.py .
   ```

8. Check `git status --short`, then report changed paths and any assets that
   still need regeneration.

## Quality Bar

Reject and regenerate any image that:

- contains readable or pseudo-readable text
- looks like a generic robot instead of the agent metaphor
- lacks a clear focal object at small size
- uses a different global style from the rest of the set
- has watermarking, brand logos, UI screenshots, distorted hands/faces, or
  busy collage composition

## Canva

Use Canva only as an optional polish layer after repo-native assets exist. If
the user asks for Canva, create/export designs from a reusable template, but
keep the final PNG files committed in each agent folder as the source consumed
by READMEs.
