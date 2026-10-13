# Abre, fecha e cria os atalhos do Copiloto Ui24R para quem não usa terminal.
# É chamado pelos arquivos "Abrir Copiloto.bat", "Fechar Copiloto.bat" e
# "Criar atalhos na area de trabalho.bat" (na pasta do projeto).
#
#   abrir    instala as dependências na primeira vez, liga o programa numa janela
#            minimizada e abre o painel no navegador (se já estiver ligado, só abre o painel)
#   fechar   desliga o programa
#   atalhos  cria os atalhos com ícone na área de trabalho (ou na pasta do projeto)

param(
  [ValidateSet('abrir', 'fechar', 'atalhos')]
  [string]$Acao = 'abrir'
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$dados = Join-Path $raiz 'data'
$pidFile = Join-Path $dados 'copiloto.pid'
$titulo = 'Copiloto Ui24R'

function Get-Porta {
  try { return [int](Get-Content (Join-Path $raiz 'config\config.json') -Raw | ConvertFrom-Json).server.port } catch { return 8080 }
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

function Abrir {
  $porta = Get-Porta
  $url = "http://localhost:$porta"

  if (Test-Painel $porta) {
    Write-Host 'O Copiloto já está ligado. Abrindo o painel...'
    Start-Process $url
    return
  }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'O Node.js não está instalado neste computador.' -ForegroundColor Red
    Write-Host 'Instale a versão LTS (gratuita) em https://nodejs.org e tente de novo.'
    exit 1
  }

  if (-not (Test-Path (Join-Path $raiz 'node_modules'))) {
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
  $cmd = "title $titulo - NAO FECHE (use o atalho Fechar Copiloto) && npm.cmd start || pause"
  $proc = Start-Process cmd.exe -ArgumentList '/c', $cmd -WorkingDirectory $raiz -WindowStyle Minimized -PassThru
  Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Painel $porta) {
      Write-Host 'Pronto! Abrindo o painel no navegador...' -ForegroundColor Green
      Start-Process $url
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

  # 1) a janela que o atalho "Abrir" ligou (confere que é mesmo ela antes de fechar)
  if (Test-Path $pidFile) {
    $id = (Get-Content $pidFile -Raw).Trim()
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if ($p -and $p.Name -eq 'cmd.exe' -and $p.CommandLine -like "*$titulo*") {
      & taskkill.exe /PID $id /T /F | Out-Null
      $fechou = $true
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }

  # 2) o Copiloto ligado de outro jeito (ex.: npm start no terminal)
  Start-Sleep -Milliseconds 500
  $p = Get-ProcessoCopiloto (Get-Porta)
  if ($p) {
    & taskkill.exe /PID $p.ProcessId /T /F | Out-Null
    $fechou = $true
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
      Novo-Atalho $pasta 'Abrir Copiloto' 'Abrir Copiloto.bat' 'abrir.ico' 'Liga o Copiloto Ui24R e abre o painel'
      Novo-Atalho $pasta 'Fechar Copiloto' 'Fechar Copiloto.bat' 'fechar.ico' 'Desliga o Copiloto Ui24R'
      Write-Host "Atalhos criados em: $pasta" -ForegroundColor Green
      return
    } catch {
      Write-Host "Não consegui gravar em $pasta ($($_.Exception.Message)). Tentando a próxima pasta..."
    }
  }
  Write-Host 'Não consegui criar os atalhos.' -ForegroundColor Red
  exit 1
}

switch ($Acao) {
  'abrir' { Abrir }
  'fechar' { Fechar }
  'atalhos' { Atalhos }
}
