#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "請使用 sudo 執行：sudo bash scripts/install-pi.sh <共享權杖>"
  exit 1
fi

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "用法：sudo bash scripts/install-pi.sh <與 Windows config.json 相同的權杖>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
AGENT_TOKEN="$1"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y iperf3 python3 iputils-ping

if ! id network-monitor >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin network-monitor
fi

install -d -m 0755 /opt/network-system /etc/network-system
install -m 0755 "${PROJECT_DIR}/agent/network_agent.py" /opt/network-system/network_agent.py
install -m 0644 "${PROJECT_DIR}/systemd/network-system-agent.service" /etc/systemd/system/network-system-agent.service
install -m 0644 "${PROJECT_DIR}/systemd/network-system-iperf3.service" /etc/systemd/system/network-system-iperf3.service

AGENT_TOKEN="${AGENT_TOKEN}" python3 -c 'import json, os; json.dump({"host":"0.0.0.0","port":8765,"token":os.environ["AGENT_TOKEN"]}, open("/etc/network-system/agent-config.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)'
chown root:network-monitor /etc/network-system/agent-config.json
chmod 0640 /etc/network-system/agent-config.json

systemctl daemon-reload
systemctl enable network-system-agent.service network-system-iperf3.service
systemctl restart network-system-agent.service network-system-iperf3.service

echo "安裝完成。Agent: TCP 8765，iperf3: TCP/UDP 5201"
echo "狀態檢查：systemctl status network-system-agent network-system-iperf3"
