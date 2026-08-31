# Network Test System

針對一台 Windows PC 與兩台 Raspberry Pi 的內網／公網持續監測工具。Windows 負責排程、SQLite、即時儀表板與報告；兩台 Pi 執行無第三方 Python 套件的輕量 Agent。

## 可以量到什麼

- 三台設備各自每秒執行公網 Ping、TCP 443、DNS、HTTPS 探測
- PC → Pi 1、PC → Pi 2 每秒 ICMP 延遲；Agent 每秒 HTTP 回應驗證 Pi → PC 回程
- Pi 1 ↔ Pi 2 彼此執行每秒內網存活與延遲
- 三組鏈路輪流執行雙向 TCP `iperf3`
- 定期執行雙向 UDP，取得 jitter 與 packet loss
- 連續三次失敗才建立斷線事件，避免單次偶發逾時誤報
- SQLite 原始資料、即時圖表、可用率／P95／P99 摘要及 CSV 匯出

## 需求

### Windows PC

- Node.js 22.5 或以上（專案不需要 `npm install`）
- `iperf3` 並加入 PATH；沒有它時其他探測仍可用，但 PC 發起的吞吐測試會顯示失敗

Windows 11 可使用 PowerShell 安裝 `iperf3`：

```powershell
winget install --id ar51an.iPerf3 --exact --accept-package-agreements --accept-source-agreements
```

安裝後請關閉並重新開啟 PowerShell，再執行 `iperf3 --version` 確認 PATH 已生效。

### Raspberry Pi

- Raspberry Pi OS / Debian 類系統
- Python 3
- `iperf3`
- PC 與兩台 Pi 必須能互相連線

## Raspberry Pi 一行安裝

在兩台 Raspberry Pi 上分別執行以下指令；先把 `REPLACE_WITH_A_LONG_TOKEN` 換成你自行設定的長權杖：

```bash
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Network-Test-system/main/scripts/bootstrap-pi.sh | sudo bash -s -- 'REPLACE_WITH_A_LONG_TOKEN'
```

這條指令會安裝 Python 3、`iperf3` 與 Ping，從 GitHub 下載 Agent，建立服務帳號，然後啟動兩個 systemd 服務。相同指令可以再次執行來更新 Agent。遠端腳本會以 root 權限執行，正式環境可先下載並檢查腳本內容再執行。

Windows 的 `config/config.json` 內，兩台 Pi 的 `token` 必須填入相同權杖。

## 1. 設定固定 IP

先在路由器中為三台設備設定 DHCP 保留位址。在 Windows 執行 `ipconfig`，在 Pi 執行 `hostname -I` 查詢目前位址。

第一次啟動控制器時會由範例自動建立不受 Git 追蹤的 `config/config.json`。正式測試前編輯它：

```json
{
  "controller": {
    "localNode": { "id": "windows-pc", "name": "Windows PC", "address": "192.168.1.10" }
  },
  "agents": [
    { "id": "pi-1", "name": "Raspberry Pi 1", "address": "192.168.1.21", "port": 8765, "token": "自行設定的長權杖" },
    { "id": "pi-2", "name": "Raspberry Pi 2", "address": "192.168.1.22", "port": 8765, "token": "自行設定的長權杖" }
  ]
}
```

IP 必須換成你的實際位址。兩台 Pi 可以使用相同權杖，且必須和安裝 Agent 時傳入的權杖一致。不要將真實權杖提交到公開版本庫。

## 2. 安裝兩台 Raspberry Pi

將整個專案複製到每台 Pi，進入專案目錄後執行：

```bash
sudo bash scripts/install-pi.sh '自行設定的長權杖'
```

這會安裝 `iperf3`，並啟用以下服務：

```bash
systemctl status network-system-agent
systemctl status network-system-iperf3
curl http://127.0.0.1:8765/health
```

如果 Agent 顯示 `status=1/FAILURE` 且安裝時間早於權限修正版，可直接修復：

```bash
sudo chown root:network-monitor /etc/network-system/agent-config.json
sudo chmod 640 /etc/network-system/agent-config.json
sudo systemctl restart network-system-agent
```

需要查看完整錯誤時執行：

```bash
sudo journalctl -u network-system-agent -n 30 --no-pager
```

如果 Pi 有啟用防火牆，只允許內網存取 TCP `8765`、TCP/UDP `5201`。Agent 沒有 TLS，不能把這些連接埠轉發到公網。

## 3. 啟動 Windows 控制器

PowerShell 執行：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\check-controller.ps1
node src\server.js
```

或使用：

```powershell
npm.cmd start
```

打開 <http://localhost:8080>，輸入 `60` 分鐘並按「開始測試」。若要讓內網其他設備開啟儀表板，Windows 防火牆需允許私人網路的 TCP `8080`。

## 測試排程

- 連線與延遲：每 1 秒
- 吞吐：每 60 秒選擇一組鏈路，依序跑正向／反向各 5 秒
- 三組鏈路循環，因此每組大約每 3 分鐘測一次
- UDP：每 5 個吞吐週期額外執行，預設 10 Mbps
- 斷線：連續 3 個樣本失敗才成立
- 預設總時間：3600 秒

可以在 `config/config.json` 調整週期、逾時、UDP 速率及公網目標。不要每秒執行滿速 `iperf3`，否則測試流量本身會塞滿網路。

## 資料與 API

資料預設儲存在 `data/network-monitor.db`。主要 API：

- `POST /api/session/start`：body 為 `{ "durationSeconds": 3600 }`
- `POST /api/session/stop`
- `GET /api/session/current`
- `GET /api/sessions`
- `GET /api/sessions/{id}/summary`
- `GET /api/sessions/{id}/samples`
- `GET /api/sessions/{id}/iperf`
- `GET /api/sessions/{id}/export.csv`
- `GET /api/events`：SSE 即時串流

## 驗證

```powershell
npm.cmd test
```

第一次正式跑一小時前，建議先在頁面執行 2 分鐘測試，確認三張設備卡都能持續更新，且測速表有資料。

## 判讀原則

- 三台同時公網失敗：較可能是路由器、數據機或 ISP
- 只有一台失敗：較可能是該設備、網路線或 Wi-Fi
- DNS 失敗但 TCP／HTTPS 正常：DNS 問題，不算完整斷網
- Ping 失敗但 HTTPS 正常：可能是 ICMP 被封鎖
- 吞吐降低且 TCP 重傳上升：可能是干擾、線材、交換器或 Wi-Fi 品質

此工具提供網路層面的證據與初步歸因，不會單憑一個失敗訊號直接判定 ISP 斷線。

Windows 不需要開放 ICMP Echo Request。控制器主動連到 Pi Agent，而 Agent 的 HTTP 回應本身就是雙向心跳；因此不會因 Windows 預設封鎖 Ping 而把 Pi → PC 誤判為斷線。

## 從 Raspberry Pi 移除

執行以下一行即可停止服務並移除 Agent、設定檔、systemd 服務及 `network-monitor` 專用帳號：

```bash
curl -fsSL https://raw.githubusercontent.com/Jay-Huang-0130/Network-Test-system/main/scripts/uninstall-pi.sh | sudo bash
```

移除程式預設保留 `iperf3`、Python、curl 與 ping，因為其他程式可能也會使用它們。如果確定 `iperf3` 不再需要，可另外執行 `sudo apt remove --purge iperf3`。
