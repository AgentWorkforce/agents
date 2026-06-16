import test from "node:test";
import assert from "node:assert/strict";

const {
  APP_BASE_PATH,
} = await import(new URL("../packages/web/lib/app-path.ts", import.meta.url).href);

const {
  buildGoogleAuthHref,
  normalizeGoogleAuthNextPath,
} = await import(new URL("../packages/web/lib/auth/google-redirect.ts", import.meta.url).href);

test("normalizeGoogleAuthNextPath accepts plain app routes and strips a prefixed route", () => {
  assert.equal(normalizeGoogleAuthNextPath("/dashboard", "/fallback"), "/dashboard");
  assert.equal(
    normalizeGoogleAuthNextPath(`${APP_BASE_PATH}/dashboard`, "/fallback"),
    "/dashboard",
  );
  assert.equal(
    normalizeGoogleAuthNextPath(`${APP_BASE_PATH}?tab=runs`, "/fallback"),
    "/?tab=runs",
  );
  assert.equal(normalizeGoogleAuthNextPath("dashboard", "/fallback"), "/fallback");
});

test("buildGoogleAuthHref prefixes the auth route and keeps next app-relative", () => {
  assert.equal(
    buildGoogleAuthHref("/dashboard"),
    `${APP_BASE_PATH}/api/auth/google/start?next=%2Fdashboard`,
  );
  assert.equal(
    buildGoogleAuthHref(`${APP_BASE_PATH}/invite/token-123`),
    `${APP_BASE_PATH}/api/auth/google/start?next=%2Finvite%2Ftoken-123`,
  );
});
