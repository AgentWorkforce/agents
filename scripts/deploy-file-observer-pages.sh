#!/usr/bin/env bash
set -euo pipefail

package_spec="${FILE_OBSERVER_PACKAGE_SPEC:-@relayfile/file-observer@latest}"
base_path="${FILE_OBSERVER_BASE_PATH:-/observer/file}"
pages_project="${FILE_OBSERVER_PAGES_PROJECT:-relayfile-file-observer}"
pages_branch="${FILE_OBSERVER_PAGES_BRANCH:-main}"
wrangler_version="${WRANGLER_VERSION:-4.77.0}"
skip_deploy="${FILE_OBSERVER_SKIP_DEPLOY:-}"

if [[ -z "$skip_deploy" ]]; then
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "CLOUDFLARE_API_TOKEN is required to deploy the RelayFile observer." >&2
    exit 1
  fi

  if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_DEFAULT_ACCOUNT_ID:-}" ]]; then
    export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_DEFAULT_ACCOUNT_ID}"
  fi

  if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    echo "CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_DEFAULT_ACCOUNT_ID is required." >&2
    exit 1
  fi
fi

workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

npm_userconfig="$workdir/npmrc"
npm_globalconfig="$workdir/global-npmrc"

package_dir="$workdir/package"
mkdir -p "$package_dir"

echo "Packing ${package_spec} for Cloudflare Pages deployment..."
NPM_CONFIG_USERCONFIG="$npm_userconfig" \
  NPM_CONFIG_GLOBALCONFIG="$npm_globalconfig" \
  NPM_CONFIG_JSON=false \
  npm pack "$package_spec" \
  --pack-destination "$workdir" \
  --silent
tarball="$(find "$workdir" -maxdepth 1 -type f -name "*.tgz" -print -quit)"
if [[ -z "$tarball" ]]; then
  echo "npm pack did not return a package tarball for ${package_spec}." >&2
  exit 1
fi

if [[ "$tarball" != /* ]]; then
  tarball="$workdir/$tarball"
fi

tar -xzf "$tarball" -C "$package_dir" --strip-components=1

pushd "$package_dir" >/dev/null

if [[ -f package-lock.json ]]; then
  NPM_CONFIG_USERCONFIG="$npm_userconfig" \
    NPM_CONFIG_GLOBALCONFIG="$npm_globalconfig" \
    npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
else
  NPM_CONFIG_USERCONFIG="$npm_userconfig" \
    NPM_CONFIG_GLOBALCONFIG="$npm_globalconfig" \
    npm install --ignore-scripts --prefer-offline --no-audit --no-fund
fi

export FILE_OBSERVER_BASE_PATH="$base_path"
export NEXT_PUBLIC_FILE_OBSERVER_BASE_PATH="$base_path"

if node -e 'process.exit(require("./package.json").scripts?.["pages:build"] ? 0 : 1)'; then
  NPM_CONFIG_USERCONFIG="$npm_userconfig" \
    NPM_CONFIG_GLOBALCONFIG="$npm_globalconfig" \
    npm run pages:build
elif node -e 'process.exit(require("./package.json").scripts?.build ? 0 : 1)'; then
  NPM_CONFIG_USERCONFIG="$npm_userconfig" \
    NPM_CONFIG_GLOBALCONFIG="$npm_globalconfig" \
    npm run build
else
  echo "${package_spec} must provide a pages:build or build script." >&2
  exit 1
fi

output_dir=""
if [[ -n "${FILE_OBSERVER_OUTPUT_DIR:-}" ]]; then
  if [[ -d "${FILE_OBSERVER_OUTPUT_DIR}" ]]; then
    output_dir="${FILE_OBSERVER_OUTPUT_DIR}"
  fi
else
  for candidate in ".vercel/output/static" "out" "dist" "build"; do
    if [[ -d "$candidate" ]]; then
      output_dir="$candidate"
      break
    fi
  done
fi

if [[ -z "$output_dir" ]]; then
  cat >&2 <<EOF
Could not find a Cloudflare Pages output directory.
Expected one of: .vercel/output/static, out, dist, build.
Set FILE_OBSERVER_OUTPUT_DIR if @relayfile/file-observer writes somewhere else.
EOF
  exit 1
fi

if [[ -n "$skip_deploy" ]]; then
  echo "Built ${package_spec} for Cloudflare Pages at ${output_dir}; skipping deploy."
  popd >/dev/null
  exit 0
fi

ensure_pages_project() {
  local create_output
  local create_status

  echo "Ensuring Cloudflare Pages project ${pages_project} exists..."
  set +e
  create_output="$(npx --yes "wrangler@${wrangler_version}" pages project create "$pages_project" \
    --production-branch "$pages_branch" 2>&1)"
  create_status=$?
  set -e

  if [[ $create_status -eq 0 ]]; then
    printf '%s\n' "$create_output"
    return 0
  fi

  if grep -Eiq "already exists|project .* exists" <<<"$create_output"; then
    echo "Cloudflare Pages project ${pages_project} already exists."
    return 0
  fi

  printf '%s\n' "$create_output" >&2
  return "$create_status"
}

ensure_pages_project

echo "Deploying ${package_spec} from ${output_dir} to Cloudflare Pages project ${pages_project}..."
npx --yes "wrangler@${wrangler_version}" pages deploy "$output_dir" \
  --project-name "$pages_project" \
  --branch "$pages_branch"

popd >/dev/null
