# Gera os ícones dos atalhos (scripts/icones/abrir.ico e fechar.ico).
# Só precisa rodar de novo se quiser mudar o desenho:
#   powershell -ExecutionPolicy Bypass -File scripts\gerar-icones.ps1

Add-Type -AssemblyName System.Drawing
$saida = Join-Path $PSScriptRoot 'icones'
New-Item -ItemType Directory -Force $saida | Out-Null

function Cor([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

function Desenhar([string]$arquivo, [string]$corSelo, [string]$simbolo) {
  $n = 256
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  # fundo: quadrado arredondado escuro, como o painel
  $r = 48
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(8, 8, $r, $r, 180, 90)
  $path.AddArc($n - 8 - $r, 8, $r, $r, 270, 90)
  $path.AddArc($n - 8 - $r, $n - 8 - $r, $r, $r, 0, 90)
  $path.AddArc(8, $n - 8 - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush (Cor '#161b22')), $path)
  $g.DrawPath((New-Object System.Drawing.Pen (Cor '#4aa8ff'), 8), $path)

  # três faders de mesa
  $trilho = New-Object System.Drawing.Pen (Cor '#3a4452'), 12
  $trilho.StartCap = 'Round'; $trilho.EndCap = 'Round'
  $faders = @(@(72, 150, '#4aa8ff'), @(128, 82, '#3ecf8e'), @(184, 118, '#f5b642'))
  foreach ($f in $faders) {
    $g.DrawLine($trilho, $f[0], 44, $f[0], 212)
    $g.FillRectangle((New-Object System.Drawing.SolidBrush (Cor $f[2])), $f[0] - 26, $f[1] - 13, 52, 26)
  }

  # selo: verde com "play" (abrir) ou vermelho com "stop" (fechar)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush (Cor '#161b22')), 132, 132, 120, 120)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush (Cor $corSelo)), 140, 140, 104, 104)
  $branco = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  if ($simbolo -eq 'play') {
    $pts = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 178, 164), (New-Object System.Drawing.Point 178, 220), (New-Object System.Drawing.Point 224, 192))
    $g.FillPolygon($branco, $pts)
  } else {
    $g.FillRectangle($branco, 170, 170, 44, 44)
  }
  $g.Dispose()

  # ICO com uma imagem PNG de 256 px (o Windows reduz para os outros tamanhos)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $fs = [System.IO.File]::Create((Join-Path $saida $arquivo))
  $w = New-Object System.IO.BinaryWriter $fs
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)          # cabeçalho: ícone, 1 imagem
  $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0) # 256x256, sem paleta
  $w.Write([UInt16]1); $w.Write([UInt16]32)                              # planos, bits por pixel
  $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)                    # tamanho e posição da imagem
  $w.Write($png)
  $w.Close()
  $bmp.Dispose()
}

Desenhar 'abrir.ico' '#2fb36f' 'play'
Desenhar 'fechar.ico' '#e5484d' 'stop'
Write-Host "Ícones gerados em $saida"
