param(
  [switch]$ApplyPending,
  [int]$WaitForPid = 0
)

$ErrorActionPreference = 'Stop'
$releaseDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$stageDir = Join-Path $releaseDir '.blockcraft-update'
$stagedRelease = Join-Path $stageDir 'BlockCraft-Windows-x64'
$markerPath = Join-Path $stageDir 'update-ready.json'
$logPath = Join-Path $releaseDir 'data\logs\hot-update.log'

function Write-UpdateLog([string]$Message) {
  $logDir = Split-Path -Parent $logPath
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
}

function Show-UpdateMessage([string]$Message, [int]$Icon = 64) {
  try { (New-Object -ComObject WScript.Shell).Popup($Message, 0, 'BlockCraft 热更新', $Icon) | Out-Null }
  catch { Write-Host $Message }
}

function Get-PanelPort {
  $configPath = Join-Path $releaseDir 'data\panel.json'
  if (-not (Test-Path -LiteralPath $configPath)) { return 8081 }
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $port = [int]$config.panel.port
  if ($port -lt 1) { return 8081 }
  return $port
}

function Test-PanelVersion([string]$ExpectedVersion, [int]$TimeoutSeconds = 90) {
  $uri = "http://127.0.0.1:$(Get-PanelPort)/api/ping"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 2
      if ($response.version -eq $ExpectedVersion) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

try {
  if ($ApplyPending) {
    if (-not (Test-Path -LiteralPath $markerPath)) { throw '没有找到已校验的更新包。请先运行本脚本下载更新。' }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($WaitForPid -gt 0) {
      Write-UpdateLog "等待旧启动器进程 $WaitForPid 退出后应用 $($marker.version)。"
      for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if (-not (Get-Process -Id $WaitForPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
      }
      if (Get-Process -Id $WaitForPid -ErrorAction SilentlyContinue) { throw "旧启动器进程 $WaitForPid 尚未退出。" }
    }

    $backupDir = Join-Path $stageDir 'backup'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $names = @('app', 'runtime', 'BlockCraft.exe', 'README.txt')
    $changed = New-Object System.Collections.Generic.List[object]
    try {
      foreach ($name in $names) {
        $source = Join-Path $stagedRelease $name
        $destination = Join-Path $releaseDir $name
        $backup = Join-Path $backupDir $name
        if (-not (Test-Path -LiteralPath $source)) { throw "更新包缺少 $name。" }
        $hadPrevious = Test-Path -LiteralPath $destination
        if ($hadPrevious) { Move-Item -LiteralPath $destination -Destination $backup }
        try {
          Move-Item -LiteralPath $source -Destination $destination
        } catch {
          if ($hadPrevious -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $destination }
          throw
        }
        $changed.Add([pscustomobject]@{ Name = $name; HadPrevious = $hadPrevious })
      }
    } catch {
      for ($index = $changed.Count - 1; $index -ge 0; $index--) {
        $item = $changed[$index]
        $destination = Join-Path $releaseDir $item.Name
        $backup = Join-Path $backupDir $item.Name
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        if ($item.HadPrevious -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $destination }
      }
      throw
    }

    Write-UpdateLog "已切换 BlockCraft 文件到 $($marker.version)，启动新面板。"
    Start-Process -FilePath (Join-Path $releaseDir 'BlockCraft.exe') -WorkingDirectory $releaseDir
    if (-not (Test-PanelVersion -ExpectedVersion $marker.version -TimeoutSeconds 120)) {
      throw "文件已更新到 $($marker.version)，但新面板未在 120 秒内响应。旧文件备份保存在 .blockcraft-update\backup。"
    }
    Remove-Item -LiteralPath $stageDir -Recurse -Force
    Write-UpdateLog "热更新完成：$($marker.version)。"
    Show-UpdateMessage "BlockCraft 已更新到 $($marker.version)。运行中的 Minecraft 世界没有停止。"
    exit 0
  }

  if (Test-Path -LiteralPath $stageDir) {
    if (Test-Path -LiteralPath (Join-Path $stageDir 'backup')) {
      throw '发现上一次更新的备份目录。请先检查 data\logs\hot-update.log，再手动处理 .blockcraft-update 后重试。'
    }
    if (Test-Path -LiteralPath $markerPath) {
      $pending = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
      throw "版本 $($pending.version) 已暂存。请在托盘菜单中选择“仅重启面板”应用更新。"
    }
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/yumo666666/blockcraft/releases/latest' -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'BlockCraft-Hot-Update' } -TimeoutSec 30
  $version = ([string]$release.tag_name).TrimStart('v')
  if (-not $version) { throw 'GitHub 没有返回最新版本号。' }

  $manifestPath = Join-Path $releaseDir 'app\server-runtime\package.json'
  if (Test-Path -LiteralPath $manifestPath) {
    $installed = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$installed.version -eq $version) {
      Write-Host "当前已经是最新版本 $version。"
      exit 0
    }
  }

  $zipAsset = $release.assets | Where-Object { $_.name -eq 'BlockCraft-Windows-x64.zip' } | Select-Object -First 1
  $hashAsset = $release.assets | Where-Object { $_.name -eq 'BlockCraft-Windows-x64.zip.sha256' } | Select-Object -First 1
  if (-not $zipAsset -or -not $hashAsset) { throw "GitHub Release $($release.tag_name) 缺少 Windows 包或 SHA-256 文件。" }

  New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
  $zipPath = Join-Path $stageDir 'BlockCraft-Windows-x64.zip'
  $hashPath = Join-Path $stageDir 'BlockCraft-Windows-x64.zip.sha256'
  Invoke-WebRequest -UseBasicParsing -Uri $zipAsset.browser_download_url -OutFile $zipPath -TimeoutSec 1800
  Invoke-WebRequest -UseBasicParsing -Uri $hashAsset.browser_download_url -OutFile $hashPath -TimeoutSec 60
  $expectedHash = ((Get-Content -LiteralPath $hashPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw 'Windows 更新包的 SHA-256 校验失败。' }

  Expand-Archive -LiteralPath $zipPath -DestinationPath $stageDir -Force
  $stagedManifestPath = Join-Path $stagedRelease 'app\server-runtime\package.json'
  $stagedExe = Join-Path $stagedRelease 'BlockCraft.exe'
  if (-not (Test-Path -LiteralPath $stagedManifestPath) -or -not (Test-Path -LiteralPath $stagedExe)) {
    throw 'Windows 更新包目录结构不完整。'
  }
  $stagedManifest = Get-Content -LiteralPath $stagedManifestPath -Raw | ConvertFrom-Json
  if ([string]$stagedManifest.version -ne $version) { throw '更新包内部版本和 GitHub Release 版本不一致。' }
  Set-Content -LiteralPath $markerPath -Value (@{ version = $version; tag = $release.tag_name; stagedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress) -Encoding UTF8
  Write-UpdateLog "已下载 $($release.tag_name)，SHA-256 校验通过，等待托盘“仅重启面板”操作。"
  Write-Host "已从 GitHub 下载并校验 $version。请在系统托盘中右键 BlockCraft，选择“仅重启面板”应用更新；运行中的世界会继续运行。"
} catch {
  $message = "热更新失败：$($_.Exception.Message)"
  Write-UpdateLog $message
  Show-UpdateMessage $message 16
  exit 1
}
