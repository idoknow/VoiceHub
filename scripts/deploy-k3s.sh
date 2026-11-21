#!/usr/bin/env bash
# 部署 voicehub 到 k3s：按 digest 更新 Deployment，校验 rollout 与站点可达性。
set -euo pipefail
: "${KUBECONFIG_DATA:?}" "${IMAGE:?}" "${GITHUB_SHA:?}"

umask 077
export KUBECONFIG="$(mktemp)"
trap 'rm -f "$KUBECONFIG"' EXIT
printf '%s' "$KUBECONFIG_DATA" > "$KUBECONFIG"

[[ "$IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "镜像必须是 digest 形式" >&2; exit 1; }

# 节点直连 ghcr.io 偶发 EOF，可用镜像站拉取；digest 不变
if [[ -n "${IMAGE_PULL_HOST:-}" ]]; then
  IMAGE="${IMAGE_PULL_HOST}/${IMAGE#*/}"
  echo "拉取地址: $IMAGE"
fi

kubectl_retry() {
  local attempt=1 max=5 delay=2
  while true; do
    if kubectl --request-timeout=60s "$@"; then return 0; fi
    if (( attempt >= max )); then
      echo "kubectl 连续失败 ${max} 次: $*" >&2
      return 1
    fi
    echo "kubectl 第 ${attempt}/${max} 次失败，${delay}s 后重试: $*" >&2
    sleep "$delay"; attempt=$((attempt + 1)); delay=$((delay * 2))
  done
}

NS=idoknow
NAME=voicehub

kubectl_retry -n "$NS" patch deployment "$NAME" --type merge \
  -p '{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxSurge":1,"maxUnavailable":0}}}}' >/dev/null

payload="$(jq -nc --arg name "$NAME" --arg image "$IMAGE" --arg sha "$GITHUB_SHA" \
  '{metadata:{annotations:{"voicehub/source-sha":$sha}},spec:{template:{metadata:{annotations:{"voicehub/source-sha":$sha}},spec:{containers:[{name:$name,image:$image}]}}}}')"
kubectl_retry -n "$NS" patch deployment "$NAME" --type strategic -p "$payload"

kubectl_retry -n "$NS" rollout status "deployment/$NAME" --timeout=600s

kubectl_retry -n "$NS" get deployment "$NAME" -o json | jq -e \
  --arg image "$IMAGE" --arg sha "$GITHUB_SHA" \
  '.spec.template.spec.containers[0].image == $image
   and .metadata.annotations["voicehub/source-sha"] == $sha
   and .status.observedGeneration == .metadata.generation
   and .status.updatedReplicas == .spec.replicas
   and .status.availableReplicas == .spec.replicas'

curl -fsS --retry 12 --retry-delay 5 --retry-all-errors https://music.idoknow.top/ > /dev/null

echo "部署完成: $NAME @ ${GITHUB_SHA:0:7}"
