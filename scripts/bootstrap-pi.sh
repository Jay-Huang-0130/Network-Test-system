#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_RAW_URL="https://raw.githubusercontent.com/Jay-Huang-0130/Network-Test-system/main"

if [[ "${EUID}" -ne 0 ]]; then
  echo "請用 sudo 執行此安裝程式。" >&2
  exit 1
fi

if [[ $# -ne 1 || -z "$1" || "$1" == "REPLACE_WITH_A_LONG_TOKEN" ]]; then
  echo "請把 REPLACE_WITH_A_LONG_TOKEN 換成自行設定的長權杖。" >&2
  echo "此權杖必須與 Windows config/config.json 中的 token 相同。" >&2
  exit 1
fi

AGENT_TOKEN="$1"

echo "[1/4] 安裝系統套件"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl iperf3 python3 iputils-ping

echo "[2/4] 建立服務帳號與目錄"
if ! id network-monitor >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin network-monitor
fi
install -d -m 0755 /opt/network-system /etc/network-system

echo "[3/4] 從 GitHub 下載 Agent 與 systemd 服務"
curl --fail --silent --show-error --location \
  "${REPOSITORY_RAW_URL}/agent/network_agent.py" \
  --output /opt/network-system/network_agent.py
curl --fail --silent --show-error --location \
  "${REPOSITORY_RAW_URL}/systemd/network-system-agent.service" \
  --output /etc/systemd/system/network-system-agent.service
curl --fail --silent --show-error --location \
  "${REPOSITORY_RAW_URL}/systemd/network-system-iperf3.service" \
  --output /etc/systemd/system/network-system-iperf3.service
chmod 0755 /opt/network-system/network_agent.py
chmod 0644 /etc/systemd/system/network-system-agent.service /etc/systemd/system/network-system-iperf3.service

AGENT_TOKEN="${AGENT_TOKEN}" python3 -c 'import json, os; json.dump({"host":"0.0.0.0","port":8765,"token":os.environ["AGENT_TOKEN"]}, open("/etc/network-system/agent-config.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)'
chown root:network-monitor /etc/network-system/agent-config.json
chmod 0640 /etc/network-system/agent-config.json

echo "[4/4] 啟用服務"
systemctl daemon-reload
systemctl enable network-system-agent.service network-system-iperf3.service
systemctl restart network-system-agent.service network-system-iperf3.service

echo
echo "Network System Agent 安裝完成"
echo "Agent 健康檢查：http://$(hostname -I | awk '{print $1}'):8765/health"
echo "服務狀態：systemctl status network-system-agent network-system-iperf3"
