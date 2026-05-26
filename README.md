<p align="center">
  <img src="assets/banner.png" alt="Agents — the Agent Workforce" width="900">
</p>

**The agent workforce.**

Part of the AgentWorkforce suite alongside [`relayburn`](../burn) and [`relayfile`](../relayfile).

---

> The banner uses the real Agent Relay brand mark and the Sora display face
> (vendored under `assets/fonts/`). Regenerate it with:
>
> ```bash
> cd assets
> export FONTCONFIG_FILE="$PWD/fonts.conf"   # makes vendored Sora available, no system install
> python3 generate_banner.py
> rsvg-convert -w 2400 -h 1200 banner.svg -o banner.png
> ```
