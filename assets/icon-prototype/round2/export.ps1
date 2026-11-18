# PROTOTYPE (#71), throwaway. Round 2: I-B and I-E in indigo, with regular and thin strokes, the glyph at
# three sizes on three backgrounds. Writes one SVG per combination, exports each to a 512x512 PNG with Edge
# headless, then renders one preview sheet per shape and stroke:
#   out/preview-<shape>-<stroke>.png   (shape b or e, stroke regular or thin)
# Run from anywhere: powershell -File assets/icon-prototype/round2/export.ps1
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

# Backgrounds, in two sets that each get their own preview sheet. A gradient is diagonal, light at the top left.
# `accent` colours the play (I-B's triangle, I-E's badge); without it the play is white.
$backgrounds = [ordered]@{
  flat           = @{ set = 'indigo'; colour = '#4F46E5' }
  soft           = @{ set = 'indigo'; colour = '#4F46E5'; stops = @('#5B54F0', '#443CD6') }
  strong         = @{ set = 'indigo'; colour = '#4F46E5'; stops = @('#7A70F7', '#3F35C9') }
  slate          = @{ set = 'slate'; colour = '#1E293B' }
  'slate-grad'   = @{ set = 'slate'; colour = '#1E293B'; stops = @('#3B4A63', '#1A2233') }
  'slate-accent' = @{ set = 'slate'; colour = '#1E293B'; stops = @('#3B4A63', '#1A2233'); accent = '#6366F1' }
}
# Glyph scale, around the tile's centre.
$scales = [ordered]@{ '100' = 1.0; '85' = 0.85; '72' = 0.72 }
# Stroke widths in user units, before scaling: thin is about 70% of regular.
$strokes = [ordered]@{
  regular = @{ line = 44; card = 40; text = 36; ring = 36 }
  thin    = @{ line = 30; card = 28; text = 26; ring = 28 }
}
# Each glyph with its centre, so the scale keeps it centred on the tile. {tile} is the tile's flat colour,
# used where the glyph cuts into itself.
$shapes = [ordered]@{
  b = @{
    centre = '-288 -256'
    glyph  = @'
    <g fill="none" stroke="#FFFFFF" stroke-width="{line}" stroke-linecap="round" stroke-linejoin="round">
      <line x1="160" y1="110" x2="160" y2="402"/>
      <path d="M160,372 C160,270 220,236 286,236"/>
    </g>
    <polygon points="300,150 420,236 300,322" fill="{accent}" stroke="{accent}" stroke-width="36" stroke-linejoin="round"/>
'@
  }
  e = @{
    centre = '-261 -264'
    glyph  = @'
    <rect x="86" y="92" width="256" height="310" rx="44" fill="none" stroke="#FFFFFF" stroke-width="{card}"/>
    <g stroke="#FFFFFF" stroke-width="{text}" stroke-linecap="round">
      <line x1="152" y1="180" x2="276" y2="180"/>
      <line x1="152" y1="250" x2="230" y2="250"/>
    </g>
    <circle cx="352" cy="352" r="104" fill="{accent}" stroke="{bg}" stroke-width="{ring}" paint-order="stroke"/>
    <polygon points="322,300 410,352 322,404" fill="{play}" stroke="{play}" stroke-width="20" stroke-linejoin="round"/>
'@
  }
}

foreach ($shape in $shapes.Keys) {
  foreach ($stroke in $strokes.Keys) {
    foreach ($bg in $backgrounds.Keys) {
      foreach ($scale in $scales.Keys) {
        $stops = $backgrounds[$bg].stops
        $s = $scales[$scale]
        if ($stops) {
          # The tile's gradient runs from (0,0) to (512,512). Inside the scaled glyph group the same gradient
          # runs between the points that the group's transform maps onto those corners.
          $c = $shapes[$shape].centre.Split(' ') | ForEach-Object { -[double]$_ }
          $g1x = $c[0] - 256 / $s; $g1y = $c[1] - 256 / $s; $g2x = $c[0] + 256 / $s; $g2y = $c[1] + 256 / $s
          $stopTags = "<stop offset=`"0`" stop-color=`"$($stops[0])`"/><stop offset=`"1`" stop-color=`"$($stops[1])`"/>"
          $defs = "  <defs><linearGradient id=`"bg`" gradientUnits=`"userSpaceOnUse`" x1=`"0`" y1=`"0`" x2=`"512`" y2=`"512`">$stopTags</linearGradient>" +
                  "<linearGradient id=`"bgGlyph`" gradientUnits=`"userSpaceOnUse`" x1=`"$g1x`" y1=`"$g1y`" x2=`"$g2x`" y2=`"$g2y`">$stopTags</linearGradient></defs>`n"
          $fill = 'url(#bg)'
          $glyphFill = 'url(#bgGlyph)'
        } else {
          $defs = ''
          $fill = $backgrounds[$bg].colour
          $glyphFill = $fill
        }
        $w = $strokes[$stroke]
        $accent = $backgrounds[$bg].accent
        # The ring in I-E takes the tile's colour, gradient included, so the cut matches. The play inside the
        # badge is cut out in the tile's colour too, or white on an accent badge.
        $play = if ($accent) { '#FFFFFF' } else { $glyphFill }
        $glyph = $shapes[$shape].glyph.Replace('{line}', $w.line).Replace('{card}', $w.card).Replace('{text}', $w.text).Replace('{ring}', $w.ring).Replace('{bg}', $glyphFill).Replace('{play}', $play).Replace('{accent}', $(if ($accent) { $accent } else { '#FFFFFF' }))
        $svg = @"
<!-- PROTOTYPE (#71), throwaway. Round 2: I-$($shape.ToUpper()), $stroke stroke, background $bg, glyph at $scale%. -->
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
$defs  <rect width="512" height="512" rx="112" fill="$fill"/>
  <g transform="translate(256 256) scale($s) translate($($shapes[$shape].centre))">
$glyph  </g>
</svg>
"@
        $name = "$shape-$stroke-$bg-$scale"
        $path = Join-Path $out "$name.svg"
        Set-Content -Encoding utf8 -NoNewline -Path $path -Value $svg
        Export-Shot ([Uri]$path).AbsoluteUri (Join-Path $out "$name.png") 512 512 '00000000'
      }
    }
  }
}

$preview = ([Uri](Join-Path $dir 'preview.html')).AbsoluteUri
foreach ($shape in $shapes.Keys) {
  foreach ($stroke in $strokes.Keys) {
    Export-Shot "$preview`?shape=$shape&stroke=$stroke&set=indigo" (Join-Path $out "preview-$shape-$stroke.png") 860 1440 'FFFFFFFF'
    Export-Shot "$preview`?shape=$shape&stroke=$stroke&set=slate" (Join-Path $out "preview-$shape-$stroke-slate.png") 860 1440 'FFFFFFFF'
  }
}

Add-Type -AssemblyName System.Drawing
Get-ChildItem $out -Filter preview-*.png | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  '{0,-28} {1}x{2}' -f $_.Name, $img.Width, $img.Height
  $img.Dispose()
}
$sizes = Get-ChildItem $out -Filter *.png | Where-Object Name -notlike 'preview-*' | Measure-Object Length -Maximum
'{0} icons, largest {1:N0} bytes' -f $sizes.Count, $sizes.Maximum
