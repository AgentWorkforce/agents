import { stripAppBasePath, toAppPath } from "../app-path";

const DEFAULT_POST_AUTH_PATH = "/dashboard";

export function normalizeGoogleAuthNextPath(
  path: string | null | undefined,
  fallback = DEFAULT_POST_AUTH_PATH,
): string {
  const stripped = stripAppBasePath(path);
  if (stripped.startsWith("?") || stripped.startsWith("#")) {
    return `/${stripped}`;
  }
  return stripped.startsWith("/") ? stripped : fallback;
}

export function buildGoogleAuthHref(nextPath = DEFAULT_POST_AUTH_PATH): string {
  const normalizedNextPath = normalizeGoogleAuthNextPath(nextPath, DEFAULT_POST_AUTH_PATH);
  return `${toAppPath("/api/auth/google/start")}?next=${encodeURIComponent(normalizedNextPath)}`;
}
