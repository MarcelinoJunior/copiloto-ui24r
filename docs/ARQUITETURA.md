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
  leveler/fx-follower.ts     "efeito acompanha" — puro e testado
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
  - um efeito "só live" pode ser ajustado por quem tem acesso à saída onde ele toca;
  - phantom, conexão, fonte de nível e configuração avançada são só do admin.
- **Fonte de nível:** `vu` (rede) ou `usb` (`AudioSource`: captura real ou simulada). No modo USB, o nível das entradas vem do áudio e o resto continua do VU. Os recursos avançados (`AnalysisEngine`, loudness por dispositivo, OBS) só existem no modo USB.
- **Troca de mesa em tempo real:** `App.switchMixer(kind, ip)` usa um contador `generation` para encerrar os laços de conexão antigos. Nunca espere `disconnect()` sem tempo limite (`safeDisconnect`), porque trava se a mesa não responde.
- **Senha da mesa (Access):** a conexão de controle (WebSocket, `3:::SETD^…`) não pede senha; quem confere é a página da mesa. `ConnectionStore` guarda `{ enabled, password }` em `data/conexao.json` só para comparar com `MixerAdapter.accessState()` (chaves de acesso/senha que a mesa informa). A senha nunca vai para o snapshot, o log nem a mesa.
- **Teste de comando:** `MixerAdapter.testWrite()` muda `i.0.pan` em 0,0002 e volta, e abre uma **segunda** conexão para ver se a mesa repassou. Precisa ser outra conexão porque o estado da biblioteca é feito de mensagens que chegam **e** que saem (`conn.allMessages$`): olhar o próprio estado não prova nada. Roda sozinho ao conectar na mesa real. Pelo mesmo motivo, a saúde conta só `conn.inbound$`.
- **Mute:** `MixerAdapter.setSendMute(bus, key, muted)`; o estado vem no `SendInfo.muted` e aparece em `ChannelSnapshot.muted` / `FxSnapshot.muted`. Canal mutado não entra nas dicas de equilíbrio.
- **Equalizador:** o adaptador assina as chaves `i.<n>.eq.*` do estado da mesa (`watchEq`) e escreve valores brutos (`setEqRaw`, só parâmetros da lista branca). A conversão para Hz/dB/Q fica em `mixer/eq.ts` e é **uma suposição** (log para frequência e Q, linear para ganho), por isso a tela mostra "≈"; `npm run diagnostico` imprime o EQ bruto do canal 1 para calibrar.
- **Tipo de som:** `App.identityOf(key)` usa o áudio (modo USB, `AnalysisEngine.identification`) e, sem ele, o nome do canal. Alimenta `suggestTargets` (volume ideal = voz principal + `TYPE_OFFSET_DB`), as dicas de equilíbrio (`balanceTips`) e o papel "automático" do fala × música.
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
