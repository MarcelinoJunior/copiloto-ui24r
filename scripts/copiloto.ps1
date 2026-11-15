# Abre, fecha e cria os atalhos do Copiloto Ui24R para quem não usa terminal.
# É chamado pelos arquivos "Abrir Copiloto.bat", "Fechar Copiloto.bat" e
# "Criar atalhos na area de trabalho.bat" (na pasta do projeto).
#
#   abrir    instala as dependências na primeira vez, liga o programa (escondido, mensagens em
#            data\copiloto.log) e abre a JANELA do Copiloto (se já estiver ligado, só abre a janela)
#   janela   (interno) abre a janela própria (Edge em modo aplicativo) e, quando ela é fechada,
#            desliga o Copiloto, como um programa normal
#   fechar   desliga o programa
#   atalhos  cria o atalho com ícone na área de trabalho (ou na pasta do projeto)
#   reiniciar  espera o Copiloto fechar e liga de novo sem abrir outra janela (usado depois de atualizar)
#
# Instalado pelo Copiloto-Setup.exe, usa o Node que vem junto (pasta node\): nada para instalar à parte.
# A mesma tela continua disponível pela rede (celulares e tablets), enquanto a janela estiver aberta.

param(
  [ValidateSet('abrir', 'fechar', 'atalhos', 'reiniciar', 'janela')]
  [string]$Acao = 'abrir'
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$dados = Join-Path $raiz 'data'
$pidFile = Join-Path $dados 'copiloto.pid'
$titulo = 'Copiloto Ui24R'

$nodeLocal = Join-Path $raiz 'node\node.exe'

function Get-PortaConfig {
  # data\config.json (deste computador) tem prioridade sobre o config\config.json do programa
  foreach ($c in @((Join-Path $dados 'config.json'), (Join-Path $raiz 'config\config.json'))) {
    if (Test-Path $c) {
      try { return [int](Get-Content $c -Raw | ConvertFrom-Json).server.port } catch {}
    }
  }
  return 8124
}

# Porta em que o Copiloto está: se a configurada estiver ocupada por outro programa (ex.: o AmpSim
# usa a 8080), ele mesmo escolhe a próxima livre e grava em data\copiloto.porta.
function Get-Porta {
  $f = Join-Path $dados 'copiloto.porta'
  if (Test-Path $f) {
    try {
      $p = [int](Get-Content $f -Raw).Trim()
      if (Test-Painel $p) { return $p }
    } catch {}
  }
  return Get-PortaConfig
}

# $true só se quem responde na porta é MESMO o Copiloto (outro programa na mesma porta não conta).
function Test-Painel([int]$porta) {
  try {
    $info = Invoke-RestMethod "http://127.0.0.1:$porta/api/ping" -TimeoutSec 2
    return $info.app -eq 'copiloto-ui24r'
  } catch { return $false }
}

function Avisar([string]$texto) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($texto, $titulo, 'OK', 'Warning')
  } catch {}
}

# Processo que está ouvindo a porta do painel, se for o Copiloto (src/main.ts).
function Get-ProcessoCopiloto([int]$porta) {
  $conn = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
  if ($p -and $p.CommandLine -like '*main.ts*') { return $p }
  return $null
}

# Pede para o próprio Copiloto desligar (chave local em data\copiloto.token). Não depende de
# listar processos do Windows (WMI), que às vezes trava. Devolve $true se ele desligou.
function Fechar-PorChave([int]$porta) {
  $tokenFile = Join-Path $dados 'copiloto.token'
  if (-not (Test-Path $tokenFile) -or -not (Test-Painel $porta)) { return $false }
  try {
    $token = (Get-Content $tokenFile -Raw).Trim()
    Invoke-WebRequest "http://127.0.0.1:$porta/api/shutdown-local" -Method Post -Headers @{ 'x-copiloto-token' = $token } -UseBasicParsing -TimeoutSec 5 | Out-Null
    for ($i = 0; $i -lt 10 -and (Test-Painel $porta); $i++) { Start-Sleep -Milliseconds 700 }
  } catch {}
  return -not (Test-Painel $porta)
}

function Abrir([switch]$SemNavegador) {
  $porta = Get-Porta
  $url = "http://localhost:$porta"

  # O atalho é para a MESA REAL: se um simulador estiver ocupando a porta, fecha ele antes.
  # (pergunta ao próprio Copiloto, sem listar processos do Windows)
  if (Test-Painel $porta) {
    try {
      $info = Invoke-RestMethod "http://127.0.0.1:$porta/api/ping" -TimeoutSec 3
      if ($info.source -eq 'simulador') {
        Write-Host 'Um SIMULADOR do Copiloto estava aberto. Fechando para abrir a mesa real...'
        [void](Fechar-PorChave $porta)
      }
    } catch {}
  }

  if (Test-Painel $porta) {
    Write-Host 'O Copiloto já está ligado. Abrindo a janela...'
    if (-not $SemNavegador) { Abrir-Janela $url }
    return
  }

  $embutido = Test-Path $nodeLocal
  if (-not $embutido -and -not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'O Node.js não está instalado neste computador.' -ForegroundColor Red
    Write-Host 'Instale a versão LTS (gratuita) em https://nodejs.org e tente de novo.'
    exit 1
  }

  if (-not $embutido -and -not (Test-Path (Join-Path $raiz 'node_modules'))) {
    Write-Host 'Primeira vez: instalando o que o programa precisa (leva alguns minutos)...'
    Push-Location $raiz
    try { & npm.cmd install --no-fund --no-audit } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Não consegui instalar. Confira a internet e tente de novo.' -ForegroundColor Red
      exit 1
    }
  }

  Write-Host 'Ligando o Copiloto...'
  New-Item -ItemType Directory -Force $dados | Out-Null
  # O programa roda escondido; as mensagens vão para data\copiloto.log (mostradas aqui se der erro).
  $log = Join-Path $dados 'copiloto.log'
  $inicio = if ($embutido) { 'node\node.exe node_modules\tsx\dist\cli.mjs --disable-warning=ExperimentalWarning src\main.ts' } else { 'npm.cmd start' }
  $cmd = "title $titulo && $inicio > ""$log"" 2>&1"
  $proc = Start-Process cmd.exe -ArgumentList '/c', $cmd -WorkingDirectory $raiz -WindowStyle Hidden -PassThru
  Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

  # a primeira vez depois de instalar pode demorar (antivírus conferindo o node.exe)
  for ($i = 0; $i -lt 90; $i++) {
    $porta = Get-Porta # pode ter ido para outra porta (a configurada estava ocupada)
    if (Test-Painel $porta) {
      Write-Host 'Pronto! Abrindo a janela do Copiloto...' -ForegroundColor Green
      if (-not $SemNavegador) { Abrir-Janela "http://localhost:$porta" }
      return
    }
    if ($proc.HasExited) { break }
    Start-Sleep -Seconds 1
    Write-Host '.' -NoNewline
  }
  Write-Host ''
  Write-Host 'O Copiloto não respondeu. Últimas mensagens dele:' -ForegroundColor Red
  $ultimas = if (Test-Path $log) { @(Get-Content $log -Tail 15) } else { @() }
  $ultimas | ForEach-Object { Write-Host "  $_" }
  Write-Host "(arquivo completo: $log)"
  # o atalho roda minimizado: avisa numa caixa para ninguém ficar sem saber
  if (-not $SemNavegador) {
    Avisar ("O Copiloto não conseguiu abrir.`n`nÚltimas mensagens:`n" + (($ultimas | Select-Object -Last 6) -join "`n") + "`n`nArquivo completo: $log")
  }
  exit 1
}

# Edge (vem no Windows) ou Chrome, para abrir a janela própria (modo aplicativo, sem abas).
function Find-Navegador {
  foreach ($p in @(
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Get-ArgsJanela([string]$url) {
  $perfil = Join-Path $dados 'janela'
  return @("--app=$url", "--user-data-dir=`"$perfil`"", '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--start-maximized')
}

# Abre a janela do Copiloto; um "vigia" escondido desliga o programa quando ela for fechada.
function Abrir-Janela([string]$url) {
  $nav = Find-Navegador
  if (-not $nav) { Start-Process $url; return } # sem Edge/Chrome: abre no navegador padrão
  $lock = Join-Path $dados 'janela.pid'
  if (Test-Path $lock) {
    $vigia = Get-Process -Id ([int](Get-Content $lock -Raw).Trim()) -ErrorAction SilentlyContinue
    if ($vigia) {
      # já tem janela vigiada: só abre outra, sem um segundo vigia
      Start-Process $nav -ArgumentList (Get-ArgsJanela $url)
      return
    }
  }
  Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"", 'janela' -WindowStyle Hidden
}

# (vigia) abre a janela, espera ela fechar e desliga o Copiloto, como um programa normal.
function Janela {
  $porta = Get-Porta
  $nav = Find-Navegador
  if (-not $nav) { return }
  $lock = Join-Path $dados 'janela.pid'
  Set-Content -Path $lock -Value $PID -Encoding ascii
  try {
    $t0 = Get-Date
    $p = Start-Process $nav -ArgumentList (Get-ArgsJanela "http://localhost:$porta") -PassThru
    $p.WaitForExit()
    # o navegador pode repassar para uma janela do mesmo perfil já aberta e sair na hora: aí não desliga
    if (((Get-Date) - $t0).TotalSeconds -lt 5) { return }
    [void](Fechar-PorChave $porta)
  } finally {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
  }
}

function Fechar {
  $fechou = $false
  $porta = Get-Porta

  # 0) jeito limpo: pede para o próprio Copiloto desligar (sem WMI)
  if (Fechar-PorChave $porta) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Copiloto fechado.' -ForegroundColor Green
    return
  }

  # 1) a janela que o atalho "Abrir" ligou (confere que é mesmo ela antes de fechar)
  if (Test-Path $pidFile) {
    $id = [int](Get-Content $pidFile -Raw).Trim()
    # confere que é a mesma janela (cmd) que o Abrir ligou: nome e hora de início (sem WMI)
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    $gravado = (Get-Item $pidFile).LastWriteTime
    if ($p -and $p.ProcessName -eq 'cmd' -and $p.StartTime -le $gravado.AddSeconds(5)) {
      & taskkill.exe /PID $id /T /F | Out-Null
      $fechou = $true
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }

  # 2) o Copiloto ligado de outro jeito (ex.: npm start no terminal): só procura se o painel ainda responde
  Start-Sleep -Milliseconds 500
  if (Test-Painel $porta) {
    $p = Get-ProcessoCopiloto $porta
    if ($p) {
      & taskkill.exe /PID $p.ProcessId /T /F | Out-Null
      $fechou = $true
    }
  }

  if ($fechou) { Write-Host 'Copiloto fechado.' -ForegroundColor Green }
  else { Write-Host 'O Copiloto já estava fechado.' }
}

function Novo-Atalho([string]$pasta, [string]$nome, [string]$bat, [string]$icone, [string]$descricao) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $pasta "$nome.lnk"))
  $lnk.TargetPath = Join-Path $raiz $bat
  $lnk.WorkingDirectory = $raiz
  $lnk.IconLocation = (Join-Path $PSScriptRoot "icones\$icone") + ',0'
  $lnk.Description = $descricao
  $lnk.WindowStyle = 7 # minimizado: só a mensagem rápida
  $lnk.Save()
}

function Atalhos {
  $destinos = @([Environment]::GetFolderPath('Desktop'), $raiz) | Where-Object { $_ -and (Test-Path $_) }
  foreach ($pasta in $destinos) {
    try {
      # um ícone só: para desligar, use o botão ⏻ na tela do Copiloto
      Novo-Atalho $pasta 'Copiloto Ui24R' 'Abrir Copiloto.bat' 'abrir.ico' 'Abre o Copiloto Ui24R na própria janela (fechar a janela desliga)'
      Write-Host "Atalhos criados em: $pasta" -ForegroundColor Green
      return
    } catch {
      Write-Host "Não consegui gravar em $pasta ($($_.Exception.Message)). Tentando a próxima pasta..."
    }
  }
  Write-Host 'Não consegui criar os atalhos.' -ForegroundColor Red
  exit 1
}

function Reiniciar {
  # espera o Copiloto antigo sair (ele mesmo pediu o reinício depois de atualizar)
  $porta = Get-Porta
  for ($i = 0; $i -lt 30 -and (Test-Painel $porta); $i++) { Start-Sleep -Seconds 1 }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Abrir -SemNavegador
}

switch ($Acao) {
  'abrir' { Abrir }
  'reiniciar' { Reiniciar }
  'janela' { Janela }
  'fechar' { Fechar }
  'atalhos' { Atalhos }
}
