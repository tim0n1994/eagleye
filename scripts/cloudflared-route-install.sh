#!/bin/bash
# 安装 cloudflared 边缘路由守护 LaunchDaemon（root 级，每分钟巡检）。
# 路由放行需要 root（route 命令），故用 LaunchDaemon 而非 LaunchAgent。
#
# 用法: sudo bash scripts/cloudflared-route-install.sh
# 卸载: sudo bash scripts/cloudflared-route-install.sh uninstall
set -e

PLIST=/Library/LaunchDaemons/com.eagleye.cloudflared-route.plist
LABEL=com.eagleye.cloudflared-route
SCRIPT=/Users/chillbit/Proj/eagleye/scripts/cloudflared-route-ensure.sh

if [ "$1" = "uninstall" ]; then
    launchctl bootout system/"$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    route -n delete -net 198.41.0.0/16 2>/dev/null || true
    echo "✅ 已卸载路由守护（路由已删除）"
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "✗ 需要 sudo。请用: sudo bash $0"
    exit 1
fi

chmod +x "$SCRIPT"

# 先立即跑一次，确保当前路由就位
echo "→ 立即执行一次路由放行..."
bash "$SCRIPT"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT</string>
    </array>
    <!-- 每分钟巡检：路由丢失（切网络/Clash重启）后自动补回 -->
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

launchctl bootstrap system "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null
echo "✅ 路由守护已安装并启动（每 60s 巡检）"
echo "   plist: $PLIST"
echo "   日志:  ~/.cloudflared/logs/route-ensure.log"
echo "   卸载:  sudo bash $0 uninstall"
