# Monta o instalador do Copiloto Ui24R: dist\Copiloto-Setup-<versão>.exe
#
#   powershell -ExecutionPolicy Bypass -File scripts\montar-instalador.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\montar-instalador.ps1 -Testar   (instala numa pasta de
#       teste em silêncio, liga o Copiloto no simulador, confere o painel e desinstala)
#
# Precisa: git, Inno Setup 6 (ISCC.exe) e internet (baixa o Node.js oficial e as bibliotecas).
# Monta a partir do ÚLTIMO COMMIT (não de arquivos ainda não commitados).

param([switch]$Testar)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP 'copiloto-build'
$cache = Join-Path $work 'cache'
$stage = Join-Path $work 'app'
$saida = Join-Path $raiz 'dist'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$nodeVer = 'v22.19.0'

function Passo([string]$texto) { Write-Host "`n== $texto" -ForegroundColor Cyan }

function Find-Iscc {
  foreach ($p in @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
    if (Test-Path $p) { return $p }
  }
  throw 'Inno Setup 6 (ISCC.exe) não encontrado: instale de https://jrsoftware.org/isdl.php'
}

$iscc = Find-Iscc
New-Item -ItemType Directory -Force $cache, $saida | Out-Null

# ---- versão: package.json + commit ----
$pkg = Get-Content (Join-Path $raiz 'package.json') -Raw | ConvertFrom-Json
$commit = (git -C $raiz rev-parse HEAD).Trim()
$ver = "$($pkg.version)-$($commit.Substring(0, 7))"
$sujo = git -C $raiz status --porcelain --untracked-files=no
if ($sujo) { Write-Host 'Atenção: há mudanças não commitadas; o instalador usa só o último commit.' -ForegroundColor Yellow }
Passo "Montando o Copiloto $ver"

# ---- 1. arquivos do programa (exatamente o commit) ----
Passo 'Copiando os arquivos do commit'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
$fonte = Join-Path $work 'fonte.zip'
git -C $raiz archive --format=zip -o $fonte HEAD
& $tar -xf $fonte -C $stage
if ($LASTEXITCODE -ne 0) { throw 'não consegui extrair os arquivos do commit' }

# ---- 2. Node.js portátil oficial (conferido pelo SHA-256 publicado) ----
Passo "Node.js $nodeVer"
$nodeZipName = "node-$nodeVer-win-x64.zip"
$nodeZip = Join-Path $cache $nodeZipName
if (-not (Test-Path $nodeZip)) {
  Invoke-WebRequest "https://nodejs.org/dist/$nodeVer/$nodeZipName" -OutFile $nodeZip -UseBasicParsing
}
$sums = (Invoke-WebRequest "https://nodejs.org/dist/$nodeVer/SHASUMS256.txt" -UseBasicParsing).Content
$esperado = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($nodeZipName) } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
$obtido = (Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLower()
if (-not $esperado -or $obtido -ne $esperado.ToLower()) {
  Remove-Item $nodeZip -Force
  throw "SHA-256 do Node não confere (esperado $esperado, veio $obtido)"
}
$nodeTmp = Join-Path $work 'node-x'
if (Test-Path $nodeTmp) { Remove-Item $nodeTmp -Recurse -Force }
New-Item -ItemType Directory -Force $nodeTmp | Out-Null
& $tar -xf $nodeZip -C $nodeTmp
Move-Item (Join-Path $nodeTmp "node-$nodeVer-win-x64") (Join-Path $stage 'node')

# ---- 3. bibliotecas (só as de produção), com o npm desse Node ----
Passo 'Instalando as bibliotecas (npm ci --omit=dev)'
$env:PATH = "$stage\node;$env:PATH"
Push-Location $stage
try {
  & "$stage\node\npm.cmd" ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci falhou' }
} finally { Pop-Location }

# ---- 4. versão instalada (o atualizador compara com o GitHub) ----
$arquivos = git -C $raiz ls-files | Where-Object { $_ -and ($_ -split '/')[0] -notin @('data', 'node', 'node_modules', 'dist') }
$info = [ordered]@{
  commit  = $commit
  date    = (git -C $raiz log -1 --format=%cI).Trim()
  message = (git -C $raiz log -1 --format=%s).Trim()
  files   = @($arquivos)
}
$info | ConvertTo-Json -Depth 3 | Out-File (Join-Path $stage 'versao.json') -Encoding utf8

# ---- 5. instalador ----
Passo 'Gerando o instalador (Inno Setup)'
& $iscc "/DAppVer=$ver" "/DAppSrc=$stage" "/DAppOut=$saida" "/DAppRaiz=$raiz" (Join-Path $raiz 'scripts\instalador\copiloto.iss')
if ($LASTEXITCODE -ne 0) { throw 'ISCC falhou' }
$setup = Join-Path $saida "Copiloto-Setup-$ver.exe"
Write-Host "`nPronto: $setup ($([math]::Round((Get-Item $setup).Length / 1MB)) MB)" -ForegroundColor Green

if (-not $Testar) { return }

# ---- teste: instala em silêncio numa pasta própria, liga no simulador, confere e desinstala ----
Passo 'Testando o instalador'
$destino = Join-Path $work 'teste-instalado'
if (Test-Path $destino) { Remove-Item $destino -Recurse -Force }
$p = Start-Process $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$destino", '/TASKS=', '/NOICONS' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "instalação falhou (código $($p.ExitCode))" }
foreach ($f in 'node\node.exe', 'node_modules\tsx\dist\cli.mjs', 'src\main.ts', 'versao.json', 'Abrir Copiloto.bat') {
  if (-not (Test-Path (Join-Path $destino $f))) { throw "faltou $f na instalação" }
}
$dadosTeste = Join-Path $work 'teste-dados'
if (Test-Path $dadosTeste) { Remove-Item $dadosTeste -Recurse -Force }
$env:COPILOTO_DATA = $dadosTeste
$env:PORT = '8093'
$env:COPILOTO_SEM_ATUALIZACAO = '1'
$srv = Start-Process (Join-Path $destino 'node\node.exe') -ArgumentList 'node_modules\tsx\dist\cli.mjs', '--disable-warning=ExperimentalWarning', 'src\main.ts', '--sim' -WorkingDirectory $destino -WindowStyle Hidden -PassThru
try {
  $ok = $false
  for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
    Start-Sleep -Seconds 1
    try { $ok = (Invoke-WebRequest 'http://127.0.0.1:8093/login.html' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
  }
  if (-not $ok) { throw 'o Copiloto instalado não respondeu' }
  Write-Host 'Copiloto instalado ligou e respondeu.' -ForegroundColor Green
} finally {
  & taskkill.exe /PID $srv.Id /T /F | Out-Null
  Remove-Item Env:COPILOTO_DATA, Env:PORT, Env:COPILOTO_SEM_ATUALIZACAO -ErrorAction SilentlyContinue
}
$unins = Get-ChildItem $destino -Filter 'unins*.exe' | Select-Object -First 1
Start-Process $unins.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait
Start-Sleep -Seconds 2
Remove-Item $destino, $dadosTeste -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Teste do instalador: OK (instalou, ligou, respondeu e desinstalou).' -ForegroundColor Green
