#!/bin/bash
# 确保 Cloudflare 边缘网段走真实物理网卡，绕开 Clash Verge TUN 劫持。
# cloudflared 隧道必须直连边缘；经代理节点会被 Cloudflare 拒绝(530)。
#
# 幂等：路由已正确则跳过；网关变了（换网络）则自动更新。
# 用法（守护）: 由 com.eagleye.cloudflared-route LaunchDaemon 每分钟调用。
# 用法（手动）: sudo bash scripts/cloudflared-route-ensure.sh
#
# 撤销: sudo route -n delete -net 198.41.0.0/16

set -u
LOG=/Users/user/.cloudflared/logs/route-ensure.log
mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

EDGE_NET="198.41.0.0/16"
PROBE_IP="198.41.192.47"

# 探测真实物理网关：限定 en0 范围的默认路由，最稳（不受 TUN 影响）
GW=$(route -n get -ifscope en0 default 2>/dev/null | awk '/gateway:/ {print $2; exit}')
IF=$(route -n get -ifscope en0 default 2>/dev/null | awk '/interface:/ {print $2; exit}')

if [ -z "$GW" ]; then
    # 回退：不限网卡（部分环境 ifscope 无默认路由）
    GW=$(route -n get default 2>/dev/null | awk '/gateway:/ {print $2; exit}')
    IF=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2; exit}')
fi

if [ -z "$GW" ] || [ -z "$IF" ]; then
    log "ERR 探测不到物理网关/网卡（GW='$GW' IF='$IF'），本次跳过"
    exit 0  # 守护场景：下次再试，不报错终止
fi

# 网关是 TUN 接口(198.18.x)则不可用
case "$GW" in
    198.18.*) log "ERR 物理网关异常='$GW'（疑似 TUN 地址），跳过"; exit 0 ;;
esac

# 检查目标路由当前是否已正确指向物理网卡
CUR_IF=$(route -n get "$PROBE_IP" 2>/dev/null | awk '/interface:/ {print $2; exit}')
if [ "$CUR_IF" = "$IF" ]; then
    # 已正确，静默（守护每分钟跑，避免刷屏）
    exit 0
fi

# 添加/更新路由（delete 忽略错误 -> add，处理网关变更）
route -n delete -net "$EDGE_NET" "$GW" >/dev/null 2>&1
if route -n add -net "$EDGE_NET" "$GW" >/dev/null 2>&1; then
    log "OK 已设 $EDGE_NET -> $GW ($IF)"
else
    log "ERR add $EDGE_NET -> $GW 失败"
    exit 0
fi
