# Abre, fecha e cria os atalhos do Copiloto Ui24R para quem não usa terminal.
# É chamado pelos arquivos "Abrir Copiloto.bat", "Fechar Copiloto.bat" e
# "Criar atalhos na area de trabalho.bat" (na pasta do projeto).
#
#   abrir    instala as dependências na primeira vez, liga o programa numa janela
#            minimizada e abre o painel no navegador (se já estiver ligado, só abre o painel)
#   fechar   desliga o programa
#   atalhos  cria os atalhos com ícone na área de trabalho (ou na pasta do projeto)
#   reiniciar  espera o Copiloto fechar e liga de novo sem abrir outra aba (usado depois de atualizar)
#
# Instalado pelo Copiloto-Setup.exe, usa o Node que vem junto (pasta node\): nada para instalar à parte.

param(
  [ValidateSet('abrir', 'fechar', 'atalhos', 'reiniciar')]
  [string]$Acao = 'abrir'
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$dados = Join-Path $raiz 'data'
$pidFile = Join-Path $dados 'copiloto.pid'
$titulo = 'Copiloto Ui24R'

$nodeLocal = Join-Path $raiz 'node\node.exe'

function Get-Porta {
  # data\config.json (deste computador) tem prioridade sobre o config\config.json do programa
  foreach ($c in @((Join-Path $dados 'config.json'), (Join-Path $raiz 'config\config.json'))) {
    if (Test-Path $c) {
      try { return [int](Get-Content $c -Raw | ConvertFrom-Json).server.port } catch {}
    }
  }
  return 8080
}

function Test-Painel([int]$porta) {
  try {
    Invoke-WebRequest "http://127.0.0.1:$porta/login.html" -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch { return $false }
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
    Write-Host 'O Copiloto já está ligado. Abrindo o painel...'
    if (-not $SemNavegador) { Start-Process $url }
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
  # Janela minimizada com o programa. Se der erro, a janela fica aberta mostrando o motivo.
  $inicio = if ($embutido) { 'node\node.exe node_modules\tsx\dist\cli.mjs --disable-warning=ExperimentalWarning src\main.ts' } else { 'npm.cmd start' }
  $cmd = "title $titulo - NAO FECHE (use o atalho Fechar Copiloto) && $inicio || pause"
  $proc = Start-Process cmd.exe -ArgumentList '/c', $cmd -WorkingDirectory $raiz -WindowStyle Minimized -PassThru
  Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Painel $porta) {
      Write-Host 'Pronto! Abrindo o painel no navegador...' -ForegroundColor Green
      if (-not $SemNavegador) { Start-Process $url }
      return
    }
    if ($proc.HasExited) { break }
    Start-Sleep -Seconds 1
    Write-Host '.' -NoNewline
  }
  Write-Host ''
  Write-Host 'O Copiloto não respondeu. Veja a janela "Copiloto Ui24R" na barra de tarefas para o motivo.' -ForegroundColor Red
  exit 1
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
      Novo-Atalho $pasta 'Copiloto Ui24R' 'Abrir Copiloto.bat' 'abrir.ico' 'Liga o Copiloto Ui24R e abre o painel (para desligar: botão ⏻ na tela)'
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
  'fechar' { Fechar }
  'atalhos' { Atalhos }
}
