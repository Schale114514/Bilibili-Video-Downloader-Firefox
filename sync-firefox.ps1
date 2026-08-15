# sync-firefox.ps1 — 把 Chrome 版的共享文件同步到 Firefox 版
# 用法：在 PowerShell 中运行  .\sync-firefox.ps1
# 作用：从上级目录的 bilibili-downloader（Chrome 版）复制共享文件，
#       manifest.json 保持 Firefox 版不变。
$ErrorActionPreference = 'Stop'

$chrome = Join-Path $PSScriptRoot '..\bilibili-downloader'
$firefox = $PSScriptRoot

if (-not (Test-Path (Join-Path $chrome 'manifest.json'))) {
    Write-Host "未找到 Chrome 版目录：$chrome" -ForegroundColor Red
    exit 1
}

foreach ($f in @('content.js', 'content.css', 'background.js')) {
    Copy-Item (Join-Path $chrome $f) (Join-Path $firefox $f) -Force
    Write-Host "已同步 $f"
}
foreach ($d in @('lib', 'icons')) {
    Copy-Item (Join-Path $chrome $d) (Join-Path $firefox $d) -Recurse -Force
    Write-Host "已同步 $d/"
}

Write-Host '同步完成（manifest.json 未改动，保持 Firefox 版配置）。' -ForegroundColor Green
