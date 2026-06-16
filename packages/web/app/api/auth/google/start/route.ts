import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import { buildGoogleAuthorizationUrl } from "@/lib/auth/google";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";
import { normalizeGoogleAuthNextPath } from "@/lib/auth/google-redirect";

const STATE_COOKIE_NAME = "agent_relay_google_state";
const NEXT_COOKIE_NAME = "agent_relay_post_auth_next";

function normalizeNextPath(nextPath: string | null): string {
  return normalizeGoogleAuthNextPath(nextPath, "/dashboard");
}

export async function GET(request: NextRequest) {
  const clientId = Resource.GoogleClientId.value;
  if (!clientId) {
    return NextResponse.json({ error: "Google auth is not configured" }, { status: 500 });
  }

  const url = new URL(request.url);
  const origin = getConfiguredAppOrigin();
  const nextPath = normalizeNextPath(url.searchParams.get("next"));
  const state = crypto.randomUUID();
  const redirectUri = toAbsoluteAppUrl(origin, "/api/auth/callback/google").toString();

  const response = NextResponse.redirect(
    buildGoogleAuthorizationUrl({ clientId, redirectUri, state }),
  );

  response.cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  });
  response.cookies.set(NEXT_COOKIE_NAME, nextPath, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  });

  return response;
}
