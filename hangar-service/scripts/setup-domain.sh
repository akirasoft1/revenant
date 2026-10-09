#!/usr/bin/env bash
# hangar.aklabs.io -> global external HTTPS load balancer -> serverless NEG ->
# Cloud Run hangar-service (which serves both the API and the web editor).
#
# Idempotent: every resource is "create if missing", so re-running converges on
# the same infrastructure (the names below are the ones already live in
# revenant-discord-bot-2). Only when the Cloud DNS zone is newly created does it
# print the NS records and pause for the manual delegation at the aklabs.io DNS
# provider.
#
# Why not a GCS backend bucket for the SPA (like the owner's home-build app):
# this project sits under an org whose domain-restricted-sharing policy blocks
# allUsers on buckets as well as on Cloud Run, so the SPA is served by
# hangar-service itself and the URL map sends ALL paths to it.
#
# Why --no-invoker-iam-check (last step): the same policy forbids an allUsers
# invoker and browsers can't send Google invoker tokens. The app's own auth is
# then the only gate (Google ID tokens for the bot/sc-knowledge, Discord
# sessions for browsers); /v1 and /api/v1 stay authenticated.
#
# Usage: hangar-service/scripts/setup-domain.sh   (needs gcloud auth with
# owner/editor on the project). Override names via the env vars below.
set -euo pipefail

PROJECT="${PROJECT:-revenant-discord-bot-2}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-hangar-service}"
DOMAIN="${DOMAIN:-hangar.aklabs.io}"
ZONE="${ZONE:-zone-hangar-aklabs-io}"
IP_NAME="${IP_NAME:-hangar-editor-ip}"
CERT="${CERT:-hangar-editor-cert}"
NEG="${NEG:-hangar-editor-neg}"
BACKEND="${BACKEND:-hangar-editor-backend}"
URL_MAP="${URL_MAP:-hangar-editor-lb}"
HTTPS_PROXY_NAME="${HTTPS_PROXY_NAME:-hangar-editor-https-proxy}"
HTTPS_RULE="${HTTPS_RULE:-hangar-editor-https-rule}"
REDIRECT_MAP="${REDIRECT_MAP:-hangar-editor-http-redirect}"
HTTP_PROXY_NAME="${HTTP_PROXY_NAME:-hangar-editor-http-proxy}"
HTTP_RULE="${HTTP_RULE:-hangar-editor-http-rule}"

G=(gcloud --project "$PROJECT" --quiet)

say() { printf '\n==> %s\n' "$*"; }
have() { "${G[@]}" "$@" >/dev/null 2>&1; }   # "describe" succeeds -> resource exists

# ---- 1. Cloud DNS zone (+ manual NS delegation, only when newly created) ----
say "Cloud DNS zone $ZONE ($DOMAIN.)"
if have dns managed-zones describe "$ZONE"; then
  echo "exists"
else
  "${G[@]}" dns managed-zones create "$ZONE" --dns-name="$DOMAIN." \
    --description="Hangar web editor ($DOMAIN)" --visibility=public
  echo
  echo "Add these NS records for '${DOMAIN%%.*}' at the aklabs.io DNS provider:"
  "${G[@]}" dns managed-zones describe "$ZONE" --format='value(nameServers)' | tr ';' '\n' | sed 's/^/  NS  /'
  echo
  read -r -p "Press Enter once the NS records are in place (delegation can take a while to propagate)... " _ || true
fi

# ---- 2. Static IP ----
say "Global static IP $IP_NAME"
if have compute addresses describe "$IP_NAME" --global; then
  echo "exists"
else
  "${G[@]}" compute addresses create "$IP_NAME" --global --ip-version=IPV4
fi
IP=$("${G[@]}" compute addresses describe "$IP_NAME" --global --format='value(address)')
echo "IP: $IP"

# ---- 3. A record ----
say "A record $DOMAIN -> $IP"
CURRENT=$("${G[@]}" dns record-sets describe "$DOMAIN." --zone="$ZONE" --type=A \
  --format='value(rrdatas[0])' 2>/dev/null || true)
if [[ -z "$CURRENT" ]]; then
  "${G[@]}" dns record-sets create "$DOMAIN." --zone="$ZONE" --type=A --ttl=300 --rrdatas="$IP"
elif [[ "$CURRENT" != "$IP" ]]; then
  echo "points at $CURRENT -- updating"
  "${G[@]}" dns record-sets update "$DOMAIN." --zone="$ZONE" --type=A --ttl=300 --rrdatas="$IP"
else
  echo "exists"
fi

# ---- 4. Google-managed certificate ----
say "Managed certificate $CERT"
if have compute ssl-certificates describe "$CERT" --global; then
  echo "exists"
else
  "${G[@]}" compute ssl-certificates create "$CERT" --domains="$DOMAIN" --global
fi

# ---- 5. Serverless NEG -> Cloud Run ----
say "Serverless NEG $NEG -> Cloud Run $SERVICE"
if have compute network-endpoint-groups describe "$NEG" --region="$REGION"; then
  echo "exists"
else
  "${G[@]}" compute network-endpoint-groups create "$NEG" --region="$REGION" \
    --network-endpoint-type=serverless --cloud-run-service="$SERVICE"
fi

# ---- 6. Backend service (+ the NEG as its backend) ----
say "Backend service $BACKEND"
if have compute backend-services describe "$BACKEND" --global; then
  echo "exists"
else
  "${G[@]}" compute backend-services create "$BACKEND" --global \
    --load-balancing-scheme=EXTERNAL_MANAGED
fi
if "${G[@]}" compute backend-services describe "$BACKEND" --global \
     --format='value(backends[].group)' | grep -q "/networkEndpointGroups/$NEG\b"; then
  echo "NEG already attached"
else
  "${G[@]}" compute backend-services add-backend "$BACKEND" --global \
    --network-endpoint-group="$NEG" --network-endpoint-group-region="$REGION"
fi

# ---- 7. URL map: every path -> hangar-service ----
say "URL map $URL_MAP"
if have compute url-maps describe "$URL_MAP" --global; then
  echo "exists"
else
  "${G[@]}" compute url-maps create "$URL_MAP" --default-service="$BACKEND" --global
fi

# ---- 8. HTTPS proxy + forwarding rule (:443) ----
say "HTTPS proxy $HTTPS_PROXY_NAME"
if have compute target-https-proxies describe "$HTTPS_PROXY_NAME" --global; then
  echo "exists"
else
  "${G[@]}" compute target-https-proxies create "$HTTPS_PROXY_NAME" --global \
    --url-map="$URL_MAP" --ssl-certificates="$CERT"
fi
say "HTTPS forwarding rule $HTTPS_RULE (:443)"
if have compute forwarding-rules describe "$HTTPS_RULE" --global; then
  echo "exists"
else
  "${G[@]}" compute forwarding-rules create "$HTTPS_RULE" --global \
    --load-balancing-scheme=EXTERNAL_MANAGED --address="$IP_NAME" \
    --target-https-proxy="$HTTPS_PROXY_NAME" --ports=443
fi

# ---- 9. HTTP -> HTTPS redirect (:80) ----
say "HTTP->HTTPS redirect URL map $REDIRECT_MAP"
if have compute url-maps describe "$REDIRECT_MAP" --global; then
  echo "exists"
else
  YAML=$(mktemp)
  trap 'rm -f "$YAML"' EXIT
  # NOTE: no "kind:" line -- `gcloud compute url-maps import` rejects it.
  cat >"$YAML" <<EOF
name: $REDIRECT_MAP
defaultUrlRedirect:
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  httpsRedirect: true
EOF
  "${G[@]}" compute url-maps import "$REDIRECT_MAP" --global --source="$YAML"
fi
say "HTTP proxy $HTTP_PROXY_NAME"
if have compute target-http-proxies describe "$HTTP_PROXY_NAME" --global; then
  echo "exists"
else
  "${G[@]}" compute target-http-proxies create "$HTTP_PROXY_NAME" --global --url-map="$REDIRECT_MAP"
fi
say "HTTP forwarding rule $HTTP_RULE (:80)"
if have compute forwarding-rules describe "$HTTP_RULE" --global; then
  echo "exists"
else
  "${G[@]}" compute forwarding-rules create "$HTTP_RULE" --global \
    --load-balancing-scheme=EXTERNAL_MANAGED --address="$IP_NAME" \
    --target-http-proxy="$HTTP_PROXY_NAME" --ports=80
fi

# ---- 10. Let the LB's (token-less) browser traffic reach the app ----
say "Cloud Run $SERVICE: --no-invoker-iam-check (app auth is the only gate)"
"${G[@]}" run services update "$SERVICE" --region="$REGION" --no-invoker-iam-check

say "Done"
STATUS=$("${G[@]}" compute ssl-certificates describe "$CERT" --global --format='value(managed.status)')
echo "Certificate $CERT: $STATUS (PROVISIONING until $DOMAIN resolves to $IP; can take 15-60 min)"
echo "Check: curl -sI https://$DOMAIN/health  and  dig +short $DOMAIN"
