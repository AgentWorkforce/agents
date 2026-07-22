# Composable Runtime Final Integration

Status: **BLOCKED** on the required green staging deployment proof.

This note records the exact release tuple prepared for the final Agents acceptance of cloud issue #2619. Final acceptance must not run, be committed, or be reported READY without a fully successful staging-only two-phase deployment on the exact selector commit.

## Release tuple

- Workforce `4.1.24`: release commit `78124b5b3be7442d2bf6f3b2c9ebd859768941fb`; PR #273 merge `393dcb21800447cb7aeb946cff88a9f6a7347512`.
- `@relayfile/relay-helpers` `0.4.7`: release commit `317952190590687f47de25bf5c3a002f0d455a8f`; PR #245 merge `2c53b826ca1758344e6fa7f384bd1f07e920cdf5`.
- Cloud implementation: PR #2645 merge `0458056e4ff0f71fe84b1ac6d6a47a88a02a27ca`.
- Cloud selector: `7a63ecc1411a46fad609ab97be43e7099e16f170`.
- Cloud first domain repair: PR #2646 merge `76f4cefea11fccfc2aa9afe45d1704b52cbb9c18`.
- Cloud final domain repair: PR #2647 merge `e6ed1fc18d06b774c509cf711b831013018d9e24`.
- Cloud snapshot run `29472337790`: success.
- Cloud production selector deploy `29472745986`: success.
- Cloud staging run `29473290174`: failure (transient D1 timeout).
- Cloud staging run `29473781479`: failure (three stale custom-domain zones).
- Cloud staging run `29475705448`: failure (remaining Sage custom-domain zone).
- Cloud staging run `29477911123` on exact merge `e6ed1fc18d06b774c509cf711b831013018d9e24`: failure (legacy AWS VPC teardown).
- Agents acceptance base: `9463aa4f2c2f23d8fb7e48ab93cca07ba403c738`.

## Blocker

Run `29473290174` failed in `Run Cloudflare D1 migrations`. RelayCron migration `0001_operational_alert_occurrences.sql` failed because the D1 storage operation exceeded its timeout (`code: 7429`). Run `29473781479` cleared D1 but failed on three stale Cloudflare custom-domain zones. After PR #2646, run `29475705448` cleared those domains but exposed the remaining Sage hostname/zone mismatch.

PR #2647 repaired Sage. Run `29477911123` then proved D1 and all previously failing Cloudflare domains, including Sage and AgentRelayRouter, but failed later in SST while deleting legacy AWS `CloudVpc` resources. `CloudVpcCloudmapNamespace` (`ns-uzpgx6iq4yr3w6kq`) was `ResourceInUse` because associated services remain. `CloudVpcPrivateSubnet1` (`subnet-02473b528d218bdfe`) then timed out after 45 minutes waiting for Lambda ENIs `eni-0d73f728e1993ae5e` and `eni-07e61a1906ad14af5` to detach. SST unlocked and the Persona Compile Worker cutover redeploy succeeded, but the post-deploy verifier was skipped. This run is not staging proof.

An independent live probe after the failure found valid Cloudflare TLS for all five repaired hostnames (`ssl_verify_result=0`): `catalog-linear.staging.agentrelay.com`, `catalog-github.staging.agentrelay.com`, `specialist.staging.agentrelay.com`, and `staging.sage.agentrelay.com` returned `404`, while `staging.agentrelay.com` returned `200`. This supports that the feature/domain apply succeeded and the red step is intentional AWS decommission cleanup, but it does not replace a green deployment and post-deploy verifier.

The package pins, lockfile, CLI baseline, acceptance provenance, and registry-backed published-package proof repair are prepared but intentionally uncommitted. The proof validates the full installed Workforce `4.1.24` graph plus `@relayfile/relay-helpers` `0.4.7` from integrity-protected npm registry artifacts, rejects symlinked packages and environment overlays, and no longer derives release expectations from a sibling Workforce checkout. Its focused harness is `29/29` green and an early full Agents regression is `235/235` green on Node `26.5.0`. Acceptance count remains `0/14` for the final published-installed run because the required staging prerequisite failed before acceptance began.

## Required continuation

1. Remove the dependent Cloud Map services and release the Lambda ENIs, or repair the legacy `CloudVpc` teardown ordering.
2. Merge the Cloud repair and run staging-only two-phase deployment on its exact merge SHA.
3. Confirm the replacement staging run, Persona Compile Worker cutover, and post-deploy verifier succeed in full.
4. Perform a fresh lockfile-frozen install with Node `26.5.0` and no local package overlays.
5. Run strict published-installed acceptance with `AGENTWORKFORCE_CLI_PATH`, `NODE_PATH`, and `NODE_OPTIONS` unset, then full `npm test` and `npm run typecheck`.
6. Update current `results.json` and `FINAL_ACCEPTANCE.md`, commit the final integration, and report the exact final SHA and gate counts.
