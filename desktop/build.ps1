# Build "DSH Pair.exe" from the Electron runtime plus our shell and the dsh-pair tree.
#
# Layout inside the package (relative structure matters!):
#   resources/app/     <- the Electron shell (main.js + package.json)
#   resources/pair/app <- E:\dsh-pair\app   (server.js, lib/, public/)
#   resources/pair/peer<- E:\dsh-pair\peer  (lib/bridge.js, peer.js)
#
# Why resources/pair/<name> instead of resources/<name>:
#   app/lib/sides.js does require(path.join(__dirname,'..','..','peer','lib','bridge.js'))
#   and app/lib/project.js does the same for peer/peer.js. Keeping app/ and peer/
#   as siblings under resources/pair preserves those two-level-up paths.
#
# ASCII only on purpose (PowerShell 5.1 + non-ASCII bytes can swallow newlines).

$ErrorActionPreference = 'Stop'

$root    = 'E:\dsh-pair'
$desktop = Join-Path $root 'desktop'
$outRoot = Join-Path $desktop 'out'
$target  = Join-Path $outRoot 'DSH Pair'
$dist    = Join-Path $desktop 'node_modules\electron\dist'

if (-not (Test-Path (Join-Path $dist 'electron.exe'))) {
  throw "electron runtime not found at $dist - run: npm install (in $desktop)"
}
foreach ($need in 'app\server.js', 'peer\lib\bridge.js', 'peer\peer.js') {
  if (-not (Test-Path (Join-Path $root $need))) { throw "missing source: $need" }
}

Write-Host "[1/6] clean $target"
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null

Write-Host "[2/6] copy electron runtime"
Copy-Item (Join-Path $dist '*') $target -Recurse -Force

Write-Host "[3/6] rename electron.exe -> DSH Pair.exe"
$old = Join-Path $target 'electron.exe'
if (Test-Path $old) { Rename-Item -LiteralPath $old -NewName 'DSH Pair.exe' }

Write-Host "[4/6] install shell into resources\app"
$appDir = Join-Path $target 'resources\app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Copy-Item (Join-Path $desktop 'main.js') $appDir -Force
if (Test-Path (Join-Path $desktop 'icon.ico')) { Copy-Item (Join-Path $desktop 'icon.ico') $appDir -Force }
$appPkg = '{ "name": "dsh-pair-desktop", "version": "1.0.0", "main": "main.js" }'
[System.IO.File]::WriteAllText((Join-Path $appDir 'package.json'), $appPkg, (New-Object System.Text.ASCIIEncoding))

Write-Host "[5/6] bundle app/ + peer/ into resources\pair (keeping them siblings)"
$pairDir = Join-Path $target 'resources\pair'
New-Item -ItemType Directory -Force -Path $pairDir | Out-Null
$skip = @('docs', 'node_modules', '.edge-profile', 'test', 'logs', '__pycache__')
foreach ($name in @('app', 'peer')) {
  $srcDir = Join-Path $root $name
  $dstDir = Join-Path $pairDir $name
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  foreach ($item in Get-ChildItem $srcDir -Force) {
    if ($skip -contains $item.Name) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $dstDir -Recurse -Force
  }
}

Write-Host "[6/6] verify the bundle"
$checks = @(
  'DSH Pair.exe',
  'resources\app\main.js',
  'resources\pair\app\server.js',
  'resources\pair\app\lib\sides.js',
  'resources\pair\app\lib\project.js',
  'resources\pair\app\public\index.html',
  'resources\pair\peer\lib\bridge.js',
  'resources\pair\peer\peer.js'
)
$bad = 0
foreach ($c in $checks) {
  $ok = Test-Path (Join-Path $target $c)
  if (-not $ok) { $bad++ }
  Write-Host ("  {0} {1}" -f $(if ($ok) { 'ok  ' } else { 'MISS' }), $c)
}
if ($bad -gt 0) { throw "$bad required file(s) missing from the bundle" }

$sizeMB = [math]::Round(((Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)
Write-Host ""
Write-Host "done:  $(Join-Path $target 'DSH Pair.exe')"
Write-Host "size:  $sizeMB MB"
Write-Host "note:  resources\pair is a copy; re-run this script after changing app/ or peer/."