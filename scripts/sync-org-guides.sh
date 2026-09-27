#!/usr/bin/env bash
#
# scripts/sync-org-guides.sh
#
# Syncs the gaming org's PRIVATE Star Citizen guide PDFs (repo-root OrgGuides/,
# git-ignored) into a Kubernetes ConfigMap (`sc-org-guides`) that the
# sc-knowledge service mounts read-only at /guides for the sc_org_guides tool.
#
# The PDFs under OrgGuides/ are PRIVATE (written by gaming-org teammates), but
# the GitHub repo and the Docker Hub images built from it are PUBLIC. NEVER
# commit anything under OrgGuides/, never commit any file this script writes,
# and never bake OrgGuides/ content into a Docker image.
#
# Usage: scripts/sync-org-guides.sh [org_guides_dir] [namespace]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUIDES_DIR="${1:-$ROOT_DIR/OrgGuides}"
NAMESPACE="${2:-discord-article-bot}"
CONFIGMAP_NAME="sc-org-guides"
# Guard against the ConfigMap object limit (1 MiB for the whole object in
# etcd), leaving headroom for metadata/managedFields. This IS the effective
# limit because the apply below is SERVER-SIDE: a client-side `kubectl apply`
# would also copy the entire ConfigMap into the
# kubectl.kubernetes.io/last-applied-configuration annotation, and
# annotations are capped at 256 KiB total -- so client-side apply failed at
# ~256 KiB, well below this guard.
MAX_BYTES=$((900 * 1024))

if [[ ! -d "$GUIDES_DIR" ]]; then
  echo "org guides directory not found: $GUIDES_DIR" >&2
  exit 1
fi

shopt -s nullglob
pdfs=("$GUIDES_DIR"/*.pdf)
shopt -u nullglob

if [[ ${#pdfs[@]} -eq 0 ]]; then
  echo "no PDFs found in $GUIDES_DIR" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for f in "${pdfs[@]}"; do
  base="$(basename "$f" .pdf)"
  slug="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  pdftotext -layout "$f" "$tmp/${slug}.txt"
done

guide_count=$(find "$tmp" -maxdepth 1 -name '*.txt' | wc -l | tr -d ' ')
total_bytes=$(du -cb "$tmp"/*.txt 2>/dev/null | tail -1 | cut -f1)
total_bytes=${total_bytes:-0}

echo "guides: ${guide_count}, total bytes: ${total_bytes}"

if (( total_bytes > MAX_BYTES )); then
  echo "refusing to sync: ConfigMap would be ${total_bytes} bytes, exceeding the ${MAX_BYTES}-byte (900 KB) limit" >&2
  exit 1
fi

# Server-side apply: no last-applied annotation (see MAX_BYTES above).
# --force-conflicts lets this script take ownership of the data keys even if
# a previous client-side apply (or a manual edit) last managed them.
kubectl create configmap "$CONFIGMAP_NAME" --from-file="$tmp" -n "$NAMESPACE" --dry-run=client -o yaml \
  | kubectl apply --server-side --force-conflicts --field-manager=sync-org-guides -f -
