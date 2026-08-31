$ErrorActionPreference = 'Stop'

Write-Host 'Node.js:' -ForegroundColor Cyan
node --version

Write-Host '設定檔:' -ForegroundColor Cyan
$config = Get-Content -Raw -LiteralPath "$PSScriptRoot\..\config\config.json" | ConvertFrom-Json
$config.agents | ForEach-Object {
    $healthUrl = "http://$($_.address):$($_.port)/health"
    try {
        $result = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
        Write-Host "  $($_.name) $healthUrl OK ($($result.time))" -ForegroundColor Green
    }
    catch {
        Write-Host "  $($_.name) $healthUrl 無法連線: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host 'iperf3:' -ForegroundColor Cyan
if (Get-Command iperf3 -ErrorAction SilentlyContinue) {
    iperf3 --version | Select-Object -First 1
}
else {
    Write-Host '  找不到 iperf3；連線監測仍可使用，但 PC 到 Pi 的測速會失敗。' -ForegroundColor Yellow
}
