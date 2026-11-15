; Instalador do Copiloto Ui24R (Inno Setup 6). Monte com: powershell -ExecutionPolicy Bypass -File scripts\montar-instalador.ps1
; Recebe do montar-instalador.ps1: AppVer (ex.: 0.1.0-cf5a056), AppSrc (pasta pronta), AppOut (saída), AppRaiz (repositório).
;
; Instala sem pedir administrador em %LOCALAPPDATA%\Programs\Copiloto Ui24R, com o Node.js embutido
; (pasta node\): nada para instalar à parte. Os dados (usuários, presets, senha da mesa) ficam em data\
; e nunca são apagados por atualização, reinstalação ou desinstalação.

#ifndef AppVer
  #define AppVer "0.0.0"
#endif

[Setup]
AppId={{A6F3B2C1-7D4E-4F58-9B2A-1C3D5E7F9A10}
AppName=Copiloto Ui24R
AppVersion={#AppVer}
AppVerName=Copiloto Ui24R {#AppVer}
AppPublisher=Marcelino (Copiloto Ui24R)
AppPublisherURL=https://github.com/MarcelinoJunior/copiloto-ui24r
AppSupportURL=https://github.com/MarcelinoJunior/copiloto-ui24r
DefaultDirName={localappdata}\Programs\Copiloto Ui24R
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#AppOut}
OutputBaseFilename=Copiloto-Setup-{#AppVer}
SetupIconFile={#AppRaiz}\scripts\icones\abrir.ico
UninstallDisplayIcon={app}\scripts\icones\abrir.ico
UninstallDisplayName=Copiloto Ui24R
LicenseFile={#AppRaiz}\LICENSE
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no

[Languages]
Name: "pt"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "atalho"; Description: "Criar o ícone Copiloto Ui24R na área de trabalho"; GroupDescription: "Atalhos:"

[InstallDelete]
; versões antigas criavam dois ícones (Abrir e Fechar): agora é um só (desligar = botão ⏻ na tela)
Type: files; Name: "{autodesktop}\Abrir Copiloto.lnk"
Type: files; Name: "{autodesktop}\Fechar Copiloto.lnk"
Type: files; Name: "{autoprograms}\Copiloto Ui24R\Abrir Copiloto.lnk"
Type: files; Name: "{autoprograms}\Copiloto Ui24R\Fechar Copiloto.lnk"

[Files]
Source: "{#AppSrc}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "\data\*"

[Dirs]
Name: "{app}\data"

[Icons]
; um ícone só: abre o Copiloto na própria janela; fechar a janela desliga (o "Fechar" fica só no Menu Iniciar, para emergência)
Name: "{autoprograms}\Copiloto Ui24R\Copiloto Ui24R"; Filename: "{app}\Abrir Copiloto.bat"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\icones\abrir.ico"; Comment: "Liga o Copiloto e abre o painel"; Flags: runminimized
Name: "{autoprograms}\Copiloto Ui24R\Fechar o Copiloto (emergência)"; Filename: "{app}\Fechar Copiloto.bat"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\icones\fechar.ico"; Flags: runminimized
Name: "{autodesktop}\Copiloto Ui24R"; Filename: "{app}\Abrir Copiloto.bat"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\icones\abrir.ico"; Comment: "Abre o Copiloto na própria janela (fechar a janela desliga)"; Flags: runminimized; Tasks: atalho

[Run]
Filename: "{app}\Abrir Copiloto.bat"; WorkingDir: "{app}"; Description: "Abrir o Copiloto agora"; Flags: postinstall nowait skipifsilent runminimized shellexec

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\copiloto.ps1"" fechar"; Flags: runhidden waituntilterminated; RunOnceId: "FecharCopiloto"

[UninstallDelete]
; o programa (a atualização pode ter acrescentado arquivos que o desinstalador não conhece); data\ fica
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\public"
Type: files; Name: "{app}\versao.json"

[Code]
{ Reinstalando por cima com o Copiloto ligado: fecha antes (o node.exe em uso não pode ser trocado). }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Script: String;
begin
  Result := '';
  Script := ExpandConstant('{app}\scripts\copiloto.ps1');
  if FileExists(Script) then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" fechar', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
