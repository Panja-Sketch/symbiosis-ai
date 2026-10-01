#!/usr/bin/env bash
# S9: dedicated runtime identities and least-privilege IAM. Idempotent. Run as a project owner.
set -euo pipefail
P="${GCP_PROJECT_ID:-symbiosis-ai-2026}"
BUCKET="${EVIDENCE_BUCKET:-symbiosis-ai-2026-evidence}"
TOPIC=symbiosis-events
DLQ=symbiosis-events-dlq
PN=$(gcloud projects describe "$P" --format='value(projectNumber)')

for sa in symbiosis-web symbiosis-api symbiosis-worker symbiosis-pubsub-push symbiosis-scheduler; do
  gcloud iam service-accounts describe "$sa@$P.iam.gserviceaccount.com" --project "$P" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$sa" --project "$P" --display-name "$sa"
done
SA() { echo "serviceAccount:$1@$P.iam.gserviceaccount.com"; }
proj() { gcloud projects add-iam-policy-binding "$P" --member "$1" --role "$2" --condition=None --quiet >/dev/null; }

# API: Firestore data, Vertex AI (explanations), Firebase user lookup (token revocation check).
proj "$(SA symbiosis-api)" roles/datastore.user
proj "$(SA symbiosis-api)" roles/aiplatform.user
proj "$(SA symbiosis-api)" roles/firebaseauth.viewer
# Worker: Firestore data only at project level.
proj "$(SA symbiosis-worker)" roles/datastore.user

# Pub/Sub: both publish events; nobody else gets topic access.
for s in symbiosis-api symbiosis-worker; do
  gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project "$P" --member "$(SA $s)" --role roles/pubsub.publisher --quiet >/dev/null
done
# Dead lettering: the Pub/Sub service agent forwards to the DLQ topic and acks from the subscription.
AGENT="serviceAccount:service-$PN@gcp-sa-pubsub.iam.gserviceaccount.com"
gcloud pubsub topics add-iam-policy-binding "$DLQ" --project "$P" --member "$AGENT" --role roles/pubsub.publisher --quiet >/dev/null

# Evidence bucket (object-level roles only): worker writes packages, API reads them.
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "$(SA symbiosis-worker)" --role roles/storage.objectCreator --project "$P" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "$(SA symbiosis-worker)" --role roles/storage.objectViewer --project "$P" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "$(SA symbiosis-api)" --role roles/storage.objectViewer --project "$P" >/dev/null

# Pub/Sub service agent may mint OIDC tokens for the push identity.
gcloud iam service-accounts add-iam-policy-binding "symbiosis-pubsub-push@$P.iam.gserviceaccount.com" --project "$P" \
  --member "serviceAccount:service-$PN@gcp-sa-pubsub.iam.gserviceaccount.com" --role roles/iam.serviceAccountTokenCreator --quiet >/dev/null
echo "identities and IAM ready"
