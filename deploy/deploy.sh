#!/usr/bin/env bash
# The forced command behind the letsmeet-deploy SSH key on the box (installed at
# ~/letsmeet/deploy.sh; see docs/deploy.md §2). The key can do exactly one thing: ask for
# a commit that CI has already tested and pushed to GHCR to be pulled and started. The
# original command line is never executed — only parsed.
set -euo pipefail

cmd="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$cmd" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo "refused: expected 'deploy <40-hex commit>'" >&2
  exit 2
fi
sha="${BASH_REMATCH[1]}"

cd "$HOME/letsmeet"
umask 077

# compose.yaml interpolates IMAGE_TAG from .env, so recording the commit here makes every
# later `docker compose up` on this box mean "the tested commit", never ":latest".
grep -v '^IMAGE_TAG=' .env > .env.next || true
echo "IMAGE_TAG=$sha" >> .env.next
mv .env.next .env

docker compose pull --quiet
docker compose up -d --remove-orphans

# A build that boots and then dies must fail the deploy job, not sit there restarting.
status=unknown
for _ in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' letsmeet-letsmeet-1 2>/dev/null || echo unknown)
  [[ "$status" == healthy ]] && break
  sleep 2
done
if [[ "$status" != healthy ]]; then
  echo "container is '$status' after deploying $sha" >&2
  docker compose logs --tail=50 >&2
  exit 1
fi

# Drop every letsmeet image but the one now running. Nothing else on the box is touched.
running=$(docker inspect --format '{{.Image}}' letsmeet-letsmeet-1)
docker images ghcr.io/kenalba/letsmeet --format '{{.ID}}' | sort -u | while read -r id; do
  full=$(docker inspect --format '{{.Id}}' "$id" 2>/dev/null || true)
  [[ "$full" == "$running" ]] || docker rmi -f "$id" >/dev/null 2>&1 || true
done

echo "deployed $sha"
