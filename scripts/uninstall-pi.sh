#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "請用 sudo 執行此移除程式。" >&2
  exit 1
fi

echo "[1/4] 停止並停用 Network System 服務"
systemctl disable --now network-system-agent.service network-system-iperf3.service 2>/dev/null || true

echo "[2/4] 移除服務、Agent 與設定"
rm -f -- \
  /etc/systemd/system/network-system-agent.service \
  /etc/systemd/system/network-system-iperf3.service \
  /opt/network-system/network_agent.py \
  /etc/network-system/agent-config.json

# Only remove directories when empty; never recursively delete these locations.
rmdir -- /opt/network-system 2>/dev/null || true
rmdir -- /etc/network-system 2>/dev/null || true

echo "[3/4] 移除專用服務帳號"
if id network-monitor >/dev/null 2>&1; then
  userdel network-monitor
fi

echo "[4/4] 重新載入 systemd"
systemctl daemon-reload
systemctl reset-failed network-system-agent.service network-system-iperf3.service 2>/dev/null || true

echo
echo "Network System Agent 已完全移除。"
echo "iperf3、Python、curl 與 ping 套件已保留。"
