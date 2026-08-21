# sync-firefox.ps1 — Sync shared files from the Chrome version into this Firefox folder.
# Usage:  .\sync-firefox.ps1
# Copies content.js / content.css / background.js / lib / icons from ../bilibili-downloader.
# manifest.json is NOT touched (keeps Firefox-specific config).
$ErrorActionPreference = 'Stop'

$chrome = Join-Path $PSScriptRoot '..\bilibili-downloader'
$firefox = $PSScriptRoot

if (-not (Test-Path (Join-Path $chrome 'manifest.json'))) {
    Write-Host "Chrome folder not found: $chrome" -ForegroundColor Red
    exit 1
}

foreach ($f in @('content.js', 'content.css', 'background.js')) {
    Copy-Item (Join-Path $chrome $f) (Join-Path $firefox $f) -Force
    Write-Host "synced $f"
}
# 复制目录内容（而不是把目录复制进自身，避免产生 lib/lib、icons/icons 嵌套）
foreach ($d in @('lib', 'icons')) {
    $srcDir = Join-Path $chrome $d
    $dstDir = Join-Path $firefox $d
    if (-not (Test-Path $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir | Out-Null
    }
    Copy-Item (Join-Path $srcDir '*') $dstDir -Recurse -Force
    Write-Host "synced $d/"
}

Write-Host 'Done. manifest.json untouched (Firefox-specific config kept).' -ForegroundColor Green
