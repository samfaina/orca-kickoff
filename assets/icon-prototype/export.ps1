# PROTOTYPE (#71), throwaway. Exports every variant SVG in every colour to a 512x512 PNG with
# Edge headless, into out/<colour>/, then renders the preview sheets:
#   out/preview-<colour>.png  every variant at 128 and 32 px, on light and dark
#   out/overview.png          every variant in every colour, at 64 and 32 px
# The SVGs are drawn in #EA580C; the other colours replace that value.
# Run from anywhere: powershell -File assets/icon-prototype/export.ps1
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$out = Join-Path $dir 'out'
$colours = [ordered]@{ orange = '#EA580C'; indigo = '#4F46E5'; green = '#16A34A'; ink = '#18181B'; pink = '#FF006D'; violet = '#5F00FF' }

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found' }

# A separate profile, so a running Edge window does not swallow the headless call.
$profileDir = Join-Path ([IO.Path]::GetTempPath()) 'kickoff-icon-export'

function Export-Shot([string]$url, [string]$target, [int]$width, [int]$height, [string]$background) {
  $arguments = @(
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    "--user-data-dir=$profileDir",
    "--window-size=$width,$height",
    "--default-background-color=$background",
    "--screenshot=$target",
    $url
  )
  $p = Start-Process -FilePath $edge -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($p.ExitCode -ne 0) { throw "Edge exited with $($p.ExitCode) for $url" }
}

$svgs = Get-ChildItem $dir -Filter *.svg
foreach ($colour in $colours.Keys) {
  $target = Join-Path $out $colour
  New-Item -ItemType Directory -Force $target | Out-Null
  foreach ($svg in $svgs) {
    $copy = Join-Path $target $svg.Name
    (Get-Content $svg.FullName -Raw).Replace('#EA580C', $colours[$colour]) | Set-Content -Encoding utf8 -NoNewline $copy
    # 00000000 is a transparent background, so the rounded corners stay clear.
    Export-Shot ([Uri]$copy).AbsoluteUri (Join-Path $target ($svg.BaseName + '.png')) 512 512 '00000000'
  }
}

$preview = ([Uri](Join-Path $dir 'preview.html')).AbsoluteUri
$rows = $svgs.Count
foreach ($colour in $colours.Keys) {
  Export-Shot "$preview`?colour=$colour" (Join-Path $out "preview-$colour.png") 860 (40 + 156 * $rows) 'FFFFFFFF'
}
Export-Shot "$preview`?colour=all" (Join-Path $out 'overview.png') 1760 (40 + 92 * $rows) 'FFFFFFFF'

Add-Type -AssemblyName System.Drawing
Get-ChildItem $out -Filter *.png -Recurse | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  '{0,-32} {1}x{2}  {3:N0} bytes' -f $_.FullName.Substring($out.Length + 1), $img.Width, $img.Height, $_.Length
  $img.Dispose()
}
