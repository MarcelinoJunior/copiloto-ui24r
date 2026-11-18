# Arquitetura

Visão geral para quem quer entender ou contribuir com o código. O projeto é escrito em português (código, comentários, telas e documentação), porque o público são operadores de som no Brasil.

```
            rede (WebSocket da Ui24R)                   navegador(es)
Ui24R  ◄──────────────────────────────►  Copiloto  ◄────────────────────►  painel web
   │        VU, envios, faders, ganho     (Node.js)     /ws por pessoa      (HTML/JS puro)
   │                                          ▲
   └──── USB (áudio de cada canal) ──ffmpeg───┘  ← só no modo Áudio USB
```

## Pastas

```
src/
  main.ts                    ponto de entrada (npm start / npm run sim)
  app.ts                     o "cérebro": mesa ↔ niveladores ↔ permissões ↔ presets ↔ análise ↔ log
  server.ts                  HTTP (telas + /api/*), login por cookie, WebSocket /ws (estado por pessoa)
  auth.ts  db.ts  views.ts   usuários e permissões, SQLite (node:sqlite), modos de visualização
  health.ts                  saúde da conexão (tempo de resposta TCP, perda, dados chegando)
  tips.ts                    dicas, incluindo equilíbrio de volumes pelo VU (funções puras, testadas)
  obs.ts                     cliente obs-websocket v5
  leveler/aux-leveler.ts     o automático (alvo, correção, limites, operador) — puro e testado
  leveler/fx-follower.ts     retorno do efeito por saída (o antigo "ACOMP."; hoje sempre desligado) — puro e testado
  analysis/                  recursos do modo USB (FFT, RTA, detectores, LUFS, fala × música, gravação, motor)
  analysis/identify.ts       tipo de som do canal: pelo áudio (SourceIdentifier) e pelo nome (typeFromName)
  analysis/eq-advice.ts      sugestões de EQ pelo espectro médio e pelo tipo de som
  levels/usb-audio.ts        detecção da Ui24R no USB e captura via ffmpeg embutido
  mixer/types.ts             contrato MixerAdapter (mesa real e simulador)
  mixer/soundcraft-adapter.ts  Ui24R real (biblioteca soundcraft-ui-connection)
  mixer/eq.ts                EQ do canal: escala 0..1 da mesa ↔ Hz/dB/Q (único lugar a calibrar) e curva
  mixer/simulator.ts         mesa falsa
  mixer/sim-audio.ts         "USB simulado" (gera áudio de teste, injeta microfonia/zumbido)
public/                      telas: index (mixagem), analise, conexao, admin (pessoas), login
scripts/copiloto.ps1         abrir/fechar/criar atalhos (chamado pelos .bat da raiz; PID em data/copiloto.pid)
scripts/gerar-icones.ps1     desenha os ícones dos atalhos (scripts/icones/*.ico)
test/                        testes (vitest)
docs/                        esta documentação
```

## Conceitos

- **Bus (saída):** `MASTER_BUS` (0) é o master/salão, onde o "envio" é o fader do canal; 1 a 10 são os auxes. Um par estéreo (ex.: 7+8) é tratado pelo aux de número menor, e a biblioteca espelha no par. O link é lido do estado da mesa (`a.<n-1>.stereoIndex`).
- **Todas as saídas ao mesmo tempo:** na conexão, o App cria um controlador (`AuxLeveler` + `FxFollower`) para cada saída, cada um com o seu **modo** (`desligado` / `observar` = "Só sugerir" / `automatico` = "Ajustando"; a tela chama o conjunto de "Ajuste automático de volume" e o alvo de "volume ideal"). Cada pessoa conectada tem a sua `ClientView` (saída vista + canal aberto) e recebe `snapshotFor(ctx)`.
- **Eco da mesa:** quando o software manda um valor, a mesa devolve o mesmo valor na hora. Por isso `leveler.markCommanded` é chamado **antes** de `adapter.setSendDB`; sem isso, o eco pareceria uma mexida do operador.
- **Operador pelo painel:** mexer num fader do painel (`setSend`) vai direto ao adaptador, **sem** `markCommanded`, para o nivelador tratar como intervenção humana (pausa o canal e aprende o novo alvo).
- **Permissões no servidor:** `App.handle(cmd, ctx)` verifica `canUseBus`. Regras:
  - envio canal→efeito, ganho e **EQ** exigem admin ou o master (mudam o salão);
  - **mute** (`setMute`) vale para a saída: quem tem acesso a ela pode mutar o envio; no master é o mute do canal;
  - um efeito cujo retorno não está no master pode ser ajustado por quem tem acesso à saída onde ele toca (a tela não mostra mais a etiqueta "salão"/"só live": na igreja os efeitos ficam abertos nos dois);
  - marcar um canal como voz (`channel.voice`): quem tem a live, o master ou admin;
  - phantom, conexão, fonte de nível e configuração avançada são só do admin.
- **Fonte de nível:** `vu` (rede) ou `usb` (`AudioSource`: captura real ou simulada). No modo USB, o nível das entradas vem do áudio e o resto continua do VU. Os recursos avançados (`AnalysisEngine`, loudness por dispositivo, OBS) só existem no modo USB.
- **Troca de mesa em tempo real:** `App.switchMixer(kind, ip)` usa um contador `generation` para encerrar os laços de conexão antigos. Nunca espere `disconnect()` sem tempo limite (`safeDisconnect`), porque trava se a mesa não responde.
- **Dicas de equilíbrio num período:** `BalanceTracker` (tips.ts) guarda a média em potência de ~30 s do peso de cada canal por saída (atualizada no `tick`); o canal só entra na conta depois de ~15 s tocando. `TipHold` só mostra dicas `bal-*` que persistem 20 s e as mantém 10 s depois de resolvidas. Percussão tem tolerância maior; canais de serviço (`isUtilityName`: talk back, click, guia) ficam fora.
- **Saídas testadas (`safeBuses`) e risco:** `App.checkRisk` calcula o escopo do comando (`bus:N` para envios/mute/master/presets/"Ajustando" de uma saída; `canal` para EQ, ganho, phantom e envio para efeitos). Fora das saídas testadas, só passa se a pessoa liberou (`risk.ack` com `minutes` = 10, 60 ou 180; guardado por **nome de usuário** em `App.riskAcks`, então vale em todas as telas dela). A liberação fica só na tela Configurações (`conexao.html`, quadro *Travas de segurança*); a mixagem não mostra nada sobre risco, só a mensagem do `CommandError` se a pessoa tentar. O bypass vem antes (é mais forte). Na partida, saída fora da lista salva em "Ajustando" volta para "Só sugerir".
- **Espelho da mesa:** conectado na mesa real, o App grava `data/mesa-espelho.json` (nomes, saídas, link, matrizes, envios) 8 s depois de conectar e a cada 5 min (`src/mixer/mirror.ts`). O `SimulatorAdapter(mirror)` usa esses dados; o tipo de som de cada canal vem do nome.
- **Bypass (pânico):** `App.bypass` (salvo em `data/conexao.json`, sobrevive a reinício). Duas travas: (1) `handle` recusa os comandos de `WRITE_COMMANDS` com `CommandError`; (2) `App.guard()` embrulha o adaptador num `Proxy` que descarta os métodos de `MIXER_WRITES` (envio, mute, EQ, ganho, phantom, master, teste de comando) e conta em `blocked`. `apply()` e os fades também param; níveis, dicas e sugestões continuam. Qualquer pessoa logada liga; desligar pede confirmação na tela. **Exceção** (`bypass.allow`, `BypassState.allow`): uma saída (nunca o master) cujos envios/mute/master do bus passam (`bypassAllows(bus)` no guard, em `apply()`, nos fades e em `BUS_SCOPED_COMMANDS`); escritas do canal inteiro (EQ, ganho, phantom, envio para FX, teste de comando) continuam barradas. Testado contra a Ui24R falsa: com o bypass ligado a mesa não recebe nenhuma mensagem.
- **Senha da mesa (Access):** a conexão de controle (WebSocket, `3:::SETD^…`) não pede senha; quem confere é a página da mesa. `ConnectionStore` guarda `{ enabled, password }` em `data/conexao.json` só para comparar com `MixerAdapter.accessState()` (chaves de acesso/senha que a mesa informa). A senha nunca vai para o snapshot, o log nem a mesa.
- **Teste de comando:** `MixerAdapter.testWrite()` muda `i.0.pan` em 0,0002 e volta, e abre uma **segunda** conexão para ver se a mesa repassou. Precisa ser outra conexão porque o estado da biblioteca é feito de mensagens que chegam **e** que saem (`conn.allMessages$`): olhar o próprio estado não prova nada. Roda sozinho ao conectar na mesa real. Pelo mesmo motivo, a saúde conta só `conn.inbound$`.
- **Mute:** `MixerAdapter.setSendMute(bus, key, muted)`; o estado vem no `SendInfo.muted` e aparece em `ChannelSnapshot.muted` / `FxSnapshot.muted`. Canal mutado não entra nas dicas de equilíbrio.
- **Equalizador:** o adaptador assina as chaves `i.<n>.eq.*` do estado da mesa (`watchEq`) e escreve valores brutos (`setEqRaw`, só parâmetros da lista branca). A conversão para Hz/dB/Q fica em `mixer/eq.ts` e é **uma suposição** (log para frequência e Q, linear para ganho), por isso a tela mostra "≈"; `npm run diagnostico` imprime o EQ bruto do canal 1 para calibrar.
- **Tipo de som:** `App.identityOf(key)` usa primeiro a marcação da tela (botão "🎤 É voz?" na janela do canal; `PersistedState.voices`: `true` = voz, `false` = não é voz), depois o áudio (modo USB, `AnalysisEngine.identification`) e, sem ele, o nome do canal.
- **Voz sumida (`AuxLeveler.rescueVoices`, testado):** só na saída da live (`App.tick` passa as vozes com `setVoices`; nas outras saídas a lista é vazia). Compara o peso (nível + envio) de cada voz tocando com a voz **mais alta** tocando, e não com a média de todos os canais: no culto de 15/11 a JAQUE estava na média geral (bateria e overs baixos na live), mas 16 dB abaixo do MINISTRO. Mais de `rescueBelowDB` (12) abaixo por `rescueAfterSec` (10 s) → volume ideal = voz mais alta − `rescueToDB` (8), só sobe; `rescued` libera subir até `rescueMaxBoostDB` (15) acima da mixagem do operador (o normal é `maxBoostDB`). Em "Só sugerir" vira sugestão; em "Ajustando" sobe devagar (`boostRateDBps`). Operador mexeu na voz na live → a regra respeita por 10 min. Evento + registro `voz-sumida`. Alimenta `suggestTargets` (volume ideal = voz principal + `TYPE_OFFSET_DB`), as dicas de equilíbrio (`balanceTips`) e o papel "automático" do fala × música.
- **Efeito acompanha (`src/leveler/fx-link.ts`, puro e testado):** cada efeito tem uma **saída de referência** (`FxLinkState.refs`, padrão = a live via `setDefaultRef`; comando `fxlink.ref`, só para quem passa em `canEditFx`; matrizes ficam de fora). O App guarda o último fader de cada canal em **todas** as saídas (`busSends`, alimentado pelo `watchSend` de cada controlador; no master é o fader do canal). Quando o fader de um canal muda numa saída (`App.onBusSend`; a 1ª leitura só registra), `FxLink.onSend(bus, …)` ajusta só os efeitos que copiam aquela saída: envio para o efeito = `referência + diferença` (ou `referência + diferença do canal`, no "manter"; trocar a referência recalcula o "manter"); referência fechada/mutada → efeito −∞. Escreve com `setFxSendDB` (barrado pelo bypass). O antigo "ACOMP." (`FxFollower`: o retorno do efeito em cada saída seguindo os canais) fica sempre desligado (`ensureReturn(..., false)`) e saiu da tela: o usuário quer que só o envio canal → efeito acompanhe. Estado em `PersistedState.fxLink`; quem pode ligar: `canEditFx`. Cada ajuste vai para o registro (`efeito-acompanha`, com a referência e o fader dela na hora; troca de referência = `fx-referencia`), e o registro também guarda os envios de todos os canais para os efeitos sempre que mudam (`envios-fx`). Atenção: a diferença é entre os dois **botões de envio**; o quanto de efeito se ouve depende também do retorno do efeito na live e de o envio para o efeito ser pós-fader (o fader do salão mexe nele).
- **Tela de mixagem (`public/index.html`, `app.js`):** de cima para baixo: barra de cima, linha das entradas (`.inbar`: o que está sendo visto, quadro "qual entrada é" `#touch`, bancos, Tela), abas (`#out-tabs`, `renderTabs`: entrada, master, cada aux, cada FX; `flex: 1 1 0` + reticências, nunca quebram linha nem rolam), faixas (⚙ `.gear-btn` em cima de cada canal abre a janela do canal; a faixa sob o mouse ganha `.is-touch`, nunca `.touch`, que é o quadro) e, embaixo, `.bottom` com no máximo 2 linhas: controles (`.toolbar`: ajuste automático, volume ideal, presets) e efeito acompanha (`#fxlink-bar`: os 4 efeitos lado a lado, cada um com as caixinhas `select.fxl-ref` (de qual saída) e `select.fxl-off` (com quanto); sempre visível para quem passa em `canEditFx`; o funcionamento não depende da tela). `body[data-mode]` = `gain` / `master` / `aux` / `fx` pinta a tela (`--mode`: vermelho, escuro, laranja, azul).
- **Camadas (ganho e envios para efeito):** além das saídas, `ClientView.layer` pode ser `gain` ou `f1`..`f4` (comando `view` com `layer`; `bus` volta para uma saída). `App.layerChoices` só oferece para admin ou quem tem o master; `layerView` monta `AppSnapshot.layer` (canais com nível, ganho/phantom ou envio para o FX, e o retorno do FX no master). O painel desenha com `renderLayer` (escala própria do ganho `GAIN_MAP`, −6 a +57 dB; `+48V` no lugar do MUTE, só admin) e escreve com os comandos que já existiam (`setGain`, `setPhantom`, `setFxSend`, `setSend` no master), que passam pelas mesmas permissões, trava (`canal`) e bypass. A cor da etiqueta de cada faixa (`data-type`: voz, ins, bat, out, fx) vem de `ViewedBus.types` (o mesmo `soundInfo` das dicas: nome, áudio USB ou marca 🎤). `fitName` diminui a letra até 8 px e, se ainda não couber, separa a palavra por sílaba (`hyphenate`, aproximado para pt-BR).
- **Tela parada:** o painel (`public/app.js`) mostra "⚠ TELA PARADA" e apaga a mixagem quando passa 4 s sem mensagem do servidor (desconectou ou travou), para ninguém confiar em medidores congelados. Some sozinho quando volta.
- **Janela "Abrindo o Copiloto":** `copiloto.ps1` desliga o QuickEdit do console (`Desligar-Selecao`, `SetConsoleMode` sem 0x40). Com ele ligado, um clique na janela entrava no modo "Selecionar" e pausava o script até apertar Esc.
- **Tempo de análise:** `AuxLeveler.setAveragingSec` (troca o τ do `GatedLevel` de cada canal), por saída em `PersistedState.averaging`; padrão `leveler.averagingSec` = 10 s.
- **Janela própria:** `copiloto.ps1 abrir` liga o servidor escondido (`cmd /c … > data\copiloto.log`) e chama a ação `janela` num PowerShell escondido (o "vigia"): abre o Edge (ou Chrome) em `--app=http://localhost:<porta>` com perfil próprio (`data\janela`, `--disable-background-mode`), espera o processo do navegador sair (= janela fechada) e desliga pelo `/api/shutdown-local`. `data\janela.pid` evita dois vigias; se o navegador repassar para uma janela já aberta e sair em menos de 5 s, o vigia não desliga. O painel escuta a rede (`server.host` 0.0.0.0) para celulares; `/api/ping` (sem login) diz se é mesa ou simulador.
- **Porta:** padrão 8124 (o AmpSim usa a 8080). Se a porta estiver ocupada por outro programa, o `main.ts` tenta as 10 seguintes e grava a usada em `data/copiloto.porta` (apagado ao desligar); o `copiloto.ps1` lê esse arquivo e só considera "Copiloto ligado" quando `/api/ping` responde `app: copiloto-ui24r` (outro programa na mesma porta não engana o atalho). Se não abrir, o atalho mostra uma caixa com as últimas linhas do `data/copiloto.log`.
- **Atualização (`src/updater.ts`):** confere `api.github.com/repos/MarcelinoJunior/copiloto-ui24r/commits/master` ao ligar (+20 s) e a cada 30 min. Cópia com git: `fetch` + `merge --ff-only` (recusa com mudanças locais). Instalado pelo Setup (sem git): baixa o ZIP do commit, copia por cima sem tocar em `data/`, `node/`, `node_modules/` (`KEEP`), apaga o que saiu da versão (lista em `versao.json`) e roda `npm ci --omit=dev` se as bibliotecas do `package-lock.json` mudaram (`depsHash`: o número da versão não conta). O npm roda pelo `node\node.exe` embutido + `npm-cli.js`, sem cmd: a pasta "Copiloto Ui24R" tem espaço e um `npm.cmd` sem aspas quebrava ali (`quoteForCmd` no último recurso). Se o npm falhar, `versao.json` fica com `npmPending` e a atualização continua oferecida. Aplicar é o comando `update.apply` (só admin); depois `App.onRestart` chama `scripts/copiloto.ps1 reiniciar` e sai. Usa o `tar` do Windows (o do Git não abre ZIP).
- **Instalador (`scripts/montar-instalador.ps1` + `scripts/instalador/copiloto.iss`):** `git archive` do último commit + Node.js oficial (SHA-256 conferido) em `node\` + `npm ci --omit=dev` + `versao.json` → Inno Setup. Instala em `%LOCALAPPDATA%\Programs\Copiloto Ui24R` sem admin; o `copiloto.ps1` usa o `node\node.exe` embutido quando existe. `tsx` é dependência normal (roda o programa).
- **Desligar pelo painel:** `POST /api/shutdown` (só admin) chama o mesmo `shutdown()` do Ctrl+C em `main.ts`: registra no log, para o App e o servidor e sai. O servidor corta WebSockets e conexões keep-alive (`terminate`/`closeAllConnections`), e há um prazo de 3 s para sair mesmo se algo travar.
- **Recarregamento automático:** o servidor manda um `build` em cada estado; se o programa reinicia, as páginas abertas recarregam sozinhas.

## Dados

| Onde | O quê |
|---|---|
| `data/copiloto.db` | SQLite: `users`, `user_buses`, `sessions` (hash do token), `view_modes`. Migrações por `PRAGMA user_version` em `src/db.ts`. |
| `data/estado*.json` | volumes ideais (alvos), AUTO, efeito acompanha, modo por saída, preset ativo, fonte de nível, configuração avançada (mesa real e simulador separados) |
| `data/presets*.json` | presets por saída |
| `data/sessoes/*.jsonl` | log de cada culto (uma linha JSON por evento) |
| `data/gravacoes/` | gravações multipista |

O primeiro acesso cria `admin/admin` (`AuthService.ensureDefaultAdmin`). O painel avisa enquanto a senha padrão não for trocada.

## Testes

Os testes usam **sinais sintéticos com resultado conhecido**:
- senoide a -20 dBFS na FFT → aparece em -20 dB;
- senoide de 1 kHz a -20 dBFS → -20 LUFS;
- tom puro crescendo → é microfonia; tom com harmônicos e vibrato → não é;
- zumbido de 60 Hz com harmônicos → é zumbido;
- bumbo, caixa, pratos, baixo, voz e acorde sintéticos → cada um identificado pelo tipo certo (inclusive a banda inteira do "USB simulado");
- voz embolada sem passa-altas → sugestões "passa-altas" e "embolado"; som plano → nenhuma sugestão;
- voz abaixo da banda → dica "voz encoberta"; canal mutado não entra na conta;
- etc.

Também incluem uma **Ui24R falsa** (`test/fake-ui24r.test.ts`): um servidor WebSocket com o protocolo da mesa (lote de linhas com um `3:::` na frente, repasse para os outros aparelhos, modo "trancada") onde roda o **SoundcraftAdapter de verdade** e o programa inteiro. Também incluem um "OBS falso" que fala o protocolo obs-websocket e uma captura real pelo ffmpeg embutido (sinal gerado). Toda mudança em algoritmo deve vir com teste.
