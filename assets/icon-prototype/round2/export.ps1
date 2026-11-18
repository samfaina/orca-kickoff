# PROTOTYPE (#71), throwaway. Round 2: I-B in indigo, the glyph at three sizes on three backgrounds.
# Writes one SVG per combination, exports each to a 512x512 PNG with Edge headless, then renders
# preview.html to preview.png. Run from anywhere: powershell -File assets/icon-prototype/round2/export.ps1
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$out = Join-Path $dir 'out'
New-Item -ItemType Directory -Force $out | Out-Null

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found' }
$profileDir = Join-Path ([IO.Path]::GetTempPath()) 'kickoff-icon-export'

function Export-Shot([string]$url, [string]$target, [int]$width, [int]$height, [string]$background) {
  $arguments = @(
    '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    "--user-data-dir=$profileDir", "--window-size=$width,$height",
    "--default-background-color=$background", "--screenshot=$target", $url
  )
  $p = Start-Process -FilePath $edge -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($p.ExitCode -ne 0) { throw "Edge exited with $($p.ExitCode) for $url" }
}

# Backgrounds: flat indigo, a slight diagonal gradient, and a stronger one. Light at the top left.
$backgrounds = [ordered]@{
  flat   = $null
  soft   = @('#5B54F0', '#443CD6')
  strong = @('#7A70F7', '#3F35C9')
}
# Glyph scale, around the tile's centre. 100 is round 1's I-B, centred.
$scales = [ordered]@{ '100' = 1.0; '85' = 0.85; '72' = 0.72 }

# I-B's glyph spans x 138-438, y 88-424 in round 1: its centre is (288, 256).
$glyph = @'
    <g fill="none" stroke="#FFFFFF" stroke-width="44" stroke-linecap="round" stroke-linejoin="round">
      <line x1="160" y1="110" x2="160" y2="402"/>
      <path d="M160,372 C160,270 220,236 286,236"/>
    </g>
    <polygon points="300,150 420,236 300,322" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="36" stroke-linejoin="round"/>
'@

foreach ($bg in $backgrounds.Keys) {
  foreach ($scale in $scales.Keys) {
    $stops = $backgrounds[$bg]
    if ($stops) {
      $defs = "  <defs><linearGradient id=`"bg`" x1=`"0`" y1=`"0`" x2=`"1`" y2=`"1`"><stop offset=`"0`" stop-color=`"$($stops[0])`"/><stop offset=`"1`" stop-color=`"$($stops[1])`"/></linearGradient></defs>`n"
      $fill = 'url(#bg)'
    } else {
      $defs = ''
      $fill = '#4F46E5'
    }
    $s = $scales[$scale]
    $svg = @"
<!-- PROTOTYPE (#71), throwaway. Round 2: I-B, background $bg, glyph at $scale%. -->
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
$defs  <rect width="512" height="512" rx="112" fill="$fill"/>
  <g transform="translate(256 256) scale($s) translate(-288 -256)">
$glyph  </g>
</svg>
"@
    $name = "b-$bg-$scale"
    $path = Join-Path $out "$name.svg"
    Set-Content -Encoding utf8 -NoNewline -Path $path -Value $svg
    Export-Shot ([Uri]$path).AbsoluteUri (Join-Path $out "$name.png") 512 512 '00000000'
  }
}

Export-Shot ([Uri](Join-Path $dir 'preview.html')).AbsoluteUri (Join-Path $out 'preview.png') 1040 1440 'FFFFFFFF'

Add-Type -AssemblyName System.Drawing
Get-ChildItem $out -Filter *.png | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  '{0,-20} {1}x{2}  {3:N0} bytes' -f $_.Name, $img.Width, $img.Height, $_.Length
  $img.Dispose()
}
