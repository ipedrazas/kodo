#!/usr/bin/env bash
# Creates, once, the two scoped Tigris access keys the k3s environment uses,
# so that a fleet's credentials cannot read what the Gatekeeper stores:
#
#   fleet       read and write on the fleet bucket (kodo-dev) only
#   gatekeeper  read and write on the Gatekeeper bucket (kodo-dev-gatekeeper)
#               only: vault/, approvals/ and audit/
#
# Uses the admin key in .env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# AWS_ENDPOINT_URL_IAM) through Tigris's IAM API, creates the Gatekeeper
# bucket if missing, and writes the new keys to .buckets.env (git-ignored).
# Delete .buckets.env to create fresh keys; the old ones stay until removed
# with `aws iam delete-access-key`.
set -euo pipefail
cd "$(dirname "$0")/../.."
FLEET_BUCKET=${FLEET_BUCKET:-kodo-dev}
GATEKEEPER_BUCKET=${GATEKEEPER_BUCKET:-kodo-dev-gatekeeper}
[[ -f .buckets.env ]] && { echo ".buckets.env exists; keeping its keys"; exit 0; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${AWS_ENDPOINT_URL_IAM:?the Tigris IAM endpoint, https://iam.storage.dev}"
export AWS_REGION=${AWS_REGION:-auto}

aws s3api head-bucket --bucket "$GATEKEEPER_BUCKET" 2>/dev/null || aws s3 mb "s3://$GATEKEEPER_BUCKET" >/dev/null

# policy NAME BUCKET: read and write on BUCKET and nothing else.
policy() {
  local doc arn
  doc=$(cat <<JSON
{"Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Action": ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
  "Resource": ["arn:aws:s3:::$2", "arn:aws:s3:::$2/*"]
}]}
JSON
)
  arn=$(aws iam list-policies --query "Policies[?PolicyName=='$1'].Arn | [0]" --output text)
  if [[ -z $arn || $arn == None ]]; then
    arn=$(aws iam create-policy --policy-name "$1" --policy-document "$doc" --query Policy.Arn --output text)
  fi
  echo "$arn"
}

# key NAME POLICY_ARN PREFIX: a new access key with only that policy, written
# as PREFIX_ACCESS_KEY_ID and PREFIX_SECRET_ACCESS_KEY.
key() {
  local out id secret
  out=$(aws iam create-access-key --user-name "$1" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
  read -r id secret <<<"$out"
  aws iam attach-user-policy --user-name "$id" --policy-arn "$2"
  printf '%s_ACCESS_KEY_ID=%s\n%s_SECRET_ACCESS_KEY=%s\n' "$3" "$id" "$3" "$secret"
}

umask 077
{
  echo "# Scoped bucket keys created by deploy/k3s/bucket-keys.sh"
  echo "FLEET_BUCKET=$FLEET_BUCKET"
  echo "GATEKEEPER_BUCKET=$GATEKEEPER_BUCKET"
  key kodo-fleet "$(policy kodo-fleet-bucket "$FLEET_BUCKET")" FLEET
  key kodo-gatekeeper "$(policy kodo-gatekeeper-bucket "$GATEKEEPER_BUCKET")" GATEKEEPER
} > .buckets.env.tmp
mv .buckets.env.tmp .buckets.env
echo "wrote .buckets.env"
