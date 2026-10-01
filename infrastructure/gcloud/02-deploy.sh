#!/usr/bin/env bash
# S9: deploy worker, API and web to Cloud Run by IMAGE DIGEST, then wire Pub/Sub and Scheduler.
# Usage: infrastructure/gcloud/02-deploy.sh <image-tag-sha>      (images must already be built)
# Idempotent. Order matters: worker first (the push subscription needs its URL), then API, then web.
set -euo pipefail
TAG="${1:?usage: 02-deploy.sh <image-tag>}"
P="${GCP_PROJECT_ID:-symbiosis-ai-2026}"
R=us-central1
REPO="$R-docker.pkg.dev/$P/symbiosis"
PN=$(gcloud projects describe "$P" --format='value(projectNumber)')
SA() { echo "symbiosis-$1@$P.iam.gserviceaccount.com"; }
# Cloud Run's deterministic service URL form; used as the OIDC audience.
WORKER_URL="https://symbiosis-worker-$PN.$R.run.app"
API_URL="https://symbiosis-api-$PN.$R.run.app"

digest() { gcloud artifacts docker images describe "$REPO/$1:$TAG" --project "$P" --format='value(image_summary.digest)'; }
W_IMG="$REPO/worker@$(digest worker)"; A_IMG="$REPO/api@$(digest api)"; WEB_IMG="$REPO/web@$(digest web)"
echo "worker=$W_IMG"; echo "api=$A_IMG"; echo "web=$WEB_IMG"

COMMON="SYMBIOSIS_RUNTIME=gcp,GCP_PROJECT_ID=$P,GCP_REGION=$R,SYMBIOSIS_EVENTS_TOPIC=symbiosis-events,SYMBIOSIS_EVIDENCE_BUCKET=$P-evidence,FIREBASE_PROJECT_ID=$P,SYMBIOSIS_VERSION=$TAG"

# --- worker: PRIVATE (no allUsers). One instance, one request at a time. ---
gcloud run deploy symbiosis-worker --project "$P" --region "$R" --image "$W_IMG" \
  --service-account "$(SA worker)" --no-allow-unauthenticated \
  --concurrency 1 --max-instances 1 --min-instances 0 --cpu 1 --memory 512Mi --timeout 300 \
  --set-env-vars "$COMMON,SYMBIOSIS_WORKER_AUDIENCE=$WORKER_URL,SYMBIOSIS_PUSH_SERVICE_ACCOUNT=$(SA pubsub-push),SYMBIOSIS_SCHEDULER_SERVICE_ACCOUNT=$(SA scheduler)" --quiet
for s in pubsub-push scheduler; do
  gcloud run services add-iam-policy-binding symbiosis-worker --project "$P" --region "$R" \
    --member "serviceAccount:$(SA $s)" --role roles/run.invoker --quiet >/dev/null
done

# --- Pub/Sub: push subscription with retry + dead-letter policy, and a pull subscription on the DLQ ---
if ! gcloud pubsub subscriptions describe symbiosis-events-worker --project "$P" >/dev/null 2>&1; then
  gcloud pubsub subscriptions create symbiosis-events-worker --project "$P" --topic symbiosis-events \
    --push-endpoint "$WORKER_URL/pubsub/push" --push-auth-service-account "$(SA pubsub-push)" \
    --push-auth-token-audience "$WORKER_URL" --ack-deadline 60 \
    --min-retry-delay 10s --max-retry-delay 300s \
    --dead-letter-topic symbiosis-events-dlq --max-delivery-attempts 5 --expiration-period never
fi
gcloud pubsub subscriptions add-iam-policy-binding symbiosis-events-worker --project "$P" \
  --member "serviceAccount:service-$PN@gcp-sa-pubsub.iam.gserviceaccount.com" --role roles/pubsub.subscriber --quiet >/dev/null
gcloud pubsub subscriptions describe symbiosis-events-dlq-pull --project "$P" >/dev/null 2>&1 \
  || gcloud pubsub subscriptions create symbiosis-events-dlq-pull --project "$P" --topic symbiosis-events-dlq \
       --ack-deadline 60 --message-retention-duration 7d --expiration-period never

# --- Cloud Scheduler: the same tick local mode runs on a timer (alerts, escalation, verification, evidence) ---
if gcloud scheduler jobs describe symbiosis-tick --project "$P" --location "$R" >/dev/null 2>&1; then
  VERB=update
else
  VERB=create
fi
gcloud scheduler jobs "$VERB" http symbiosis-tick --project "$P" --location "$R" --schedule "* * * * *" \
  --uri "$WORKER_URL/tick" --http-method POST \
  --oidc-service-account-email "$(SA scheduler)" --oidc-token-audience "$WORKER_URL" --attempt-deadline 180s

# --- API: public ingress (signed devices and signed-in people); every route authenticates in-app ---
gcloud run deploy symbiosis-api --project "$P" --region "$R" --image "$A_IMG" \
  --service-account "$(SA api)" --allow-unauthenticated \
  --concurrency 40 --max-instances 3 --min-instances 0 --cpu 1 --memory 512Mi --timeout 60 \
  --set-env-vars "$COMMON,SYMBIOSIS_AI_PROVIDER=gemini" --quiet

# --- web: public; talks to the API server-side with the person's own ID token ---
gcloud run deploy symbiosis-web --project "$P" --region "$R" --image "$WEB_IMG" \
  --service-account "$(SA web)" --allow-unauthenticated \
  --concurrency 40 --max-instances 3 --min-instances 0 --cpu 1 --memory 512Mi --timeout 60 \
  --set-env-vars "SYMBIOSIS_API_URL=$API_URL,SYMBIOSIS_AUTH_MODE=token,SYMBIOSIS_VERSION=$TAG" --quiet

gcloud run services list --project "$P" --region "$R" --format='table(metadata.name,status.url,status.latestReadyRevisionName)'
