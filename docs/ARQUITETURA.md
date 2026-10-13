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
  tips.ts                    dicas (função pura, testada)
  obs.ts                     cliente obs-websocket v5
  leveler/aux-leveler.ts     o automático (alvo, correção, limites, operador) — puro e testado
  leveler/fx-follower.ts     "efeito acompanha" — puro e testado
  analysis/                  recursos do modo USB (FFT, RTA, detectores, LUFS, fala × música, gravação, motor)
  levels/usb-audio.ts        detecção da Ui24R no USB e captura via ffmpeg embutido
  mixer/types.ts             contrato MixerAdapter (mesa real e simulador)
  mixer/soundcraft-adapter.ts  Ui24R real (biblioteca soundcraft-ui-connection)
  mixer/simulator.ts         mesa falsa
  mixer/sim-audio.ts         "USB simulado" (gera áudio de teste, injeta microfonia/zumbido)
public/                      telas: index (mixagem), analise, conexao, admin (pessoas), login
test/                        testes (vitest)
docs/                        esta documentação
```

## Conceitos

- **Bus (saída):** `MASTER_BUS` (0) é o master/salão, onde o "envio" é o fader do canal; 1 a 10 são os auxes. Um par estéreo (ex.: 7+8) é tratado pelo aux de número menor, e a biblioteca espelha no par. O link é lido do estado da mesa (`a.<n-1>.stereoIndex`).
- **Todas as saídas ao mesmo tempo:** na conexão, o App cria um controlador (`AuxLeveler` + `FxFollower`) para cada saída, cada um com o seu **modo** (desligado/observar/automático). Cada pessoa conectada tem a sua `ClientView` (saída vista + canal aberto) e recebe `snapshotFor(ctx)`.
- **Eco da mesa:** quando o software manda um valor, a mesa devolve o mesmo valor na hora. Por isso `leveler.markCommanded` é chamado **antes** de `adapter.setSendDB`; sem isso, o eco pareceria uma mexida do operador.
- **Operador pelo painel:** mexer num fader do painel (`setSend`) vai direto ao adaptador, **sem** `markCommanded`, para o nivelador tratar como intervenção humana (pausa o canal e aprende o novo alvo).
- **Permissões no servidor:** `App.handle(cmd, ctx)` verifica `canUseBus`. Regras:
  - envio canal→efeito e ganho exigem admin ou o master (mudam o salão);
  - um efeito "só live" pode ser ajustado por quem tem acesso à saída onde ele toca;
  - phantom, conexão, fonte de nível e configuração avançada são só do admin.
- **Fonte de nível:** `vu` (rede) ou `usb` (`AudioSource`: captura real ou simulada). No modo USB, o nível das entradas vem do áudio e o resto continua do VU. Os recursos avançados (`AnalysisEngine`, loudness por dispositivo, OBS) só existem no modo USB.
- **Troca de mesa em tempo real:** `App.switchMixer(kind, ip)` usa um contador `generation` para encerrar os laços de conexão antigos. Nunca espere `disconnect()` sem tempo limite (`safeDisconnect`), porque trava se a mesa não responde.
- **Recarregamento automático:** o servidor manda um `build` em cada estado; se o programa reinicia, as páginas abertas recarregam sozinhas.

## Dados

| Onde | O quê |
|---|---|
| `data/copiloto.db` | SQLite: `users`, `user_buses`, `sessions` (hash do token), `view_modes`. Migrações por `PRAGMA user_version` em `src/db.ts`. |
| `data/estado*.json` | alvos, AUTO, efeito acompanha, modo por saída, preset ativo, fonte de nível, configuração avançada (mesa real e simulador separados) |
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
- etc.

Também incluem um "OBS falso" que fala o protocolo obs-websocket e uma captura real pelo ffmpeg embutido (sinal gerado). Toda mudança em algoritmo deve vir com teste.
