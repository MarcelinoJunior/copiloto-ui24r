# Copiloto Ui24R

Assistente de som para a **Soundcraft Ui24R** usada nos cultos ao vivo.

**Primeira frente:** manter equilibrada a mixagem da **transmissão** (o aux da live). Quando um canal fica alto ou baixo demais (voz, bateria, guitarra, teclas, qualquer canal), o software corrige o envio desse canal para o aux da live. Ele faz isso devagar e dentro de limites. **O som do salão não é tocado.**

## Como funciona

```
Ui24R ──(Wi-Fi, WebSocket)──► Copiloto (Node.js neste PC) ──► Painel web (navegador)
   ▲                                │
   └──── ajusta envios do aux ◄─────┘
```

1. O programa lê o **VU de cada canal** na mesa, cerca de 20 vezes por segundo, no ponto de onde sai o envio (pré/pós-fader e pré/pós-processamento são detectados sozinhos).
2. Para cada canal ele calcula o **peso na live**, que é o nível médio enquanto o canal toca somado ao envio.
3. Você aperta **"Gravar mixagem atual como alvo"** num momento em que a live está soando bem.
4. Daí em diante, se um canal se afasta do alvo (o guitarrista aumentou o amp, o pastor se empolgou), o envio é corrigido:
   - abaixa até **1 dB/s** e sobe até **0,4 dB/s**;
   - fica no máximo **-9 / +4 dB** em relação à sua mixagem;
   - tolera ±2 dB antes de agir;
   - **canal em silêncio nunca é mexido**. Um microfone parado não sobe e não vira ruído na live.
5. **Você continua no comando.** Se mexer num envio na mesa, o programa percebe, deixa aquele canal em paz por 30 s e passa a usar o seu ajuste como novo alvo (ele "aprende" com você).

Como o VU é medido *antes* do envio, mexer no envio não muda a medição. Por isso o controle não oscila.

### Modos

| Modo | O que faz |
|---|---|
| **Desligado** | Só mostra os níveis. |
| **Observar** | Calcula e mostra a correção que faria, mas **não mexe na mesa**. Comece sempre por aqui. |
| **Automático** | Aplica as correções nos envios do aux da live. |

**Botão de pânico:** "Voltar envios ao original" devolve todos os envios para a sua mixagem.

## Instalação (uma vez)

Precisa do [Node.js 22 ou mais novo](https://nodejs.org/).

```bash
npm install
```

## Testar em casa (simulador)

```bash
npm run sim
```

Abra http://localhost:8080. O simulador imita uma banda (pastor, ministro, backs, violão, guitarra, baixo, teclado, bateria). No painel você pode:
- trocar o momento do culto (louvor / pregação / avisos);
- **"fonte +6"**: simula um músico aumentando o volume;
- **"operador +3"**: simula você mexendo no envio direto na mesa.

## Na igreja

1. Conecte o PC no Wi-Fi da mesa e confira se http://192.168.0.122 abre a interface da Ui24R.
2. Descubra qual aux é o da live:
   ```bash
   npm run diagnostico
   ```
   Ele lista os auxes com nome, quantos canais enviam para cada um e a tabela de envios dos auxes 7, 8 e 9. Se dois auxes vizinhos têm valores idênticos, estão em **link estéreo**: use só o primeiro (ímpar).
3. Ajuste `streamAuxes` em [config/config.json](config/config.json), por exemplo `[7]`.
4. Rode:
   ```bash
   npm start
   ```
   e abra http://localhost:8080.
5. Protocolo sugerido para o primeiro culto:
   - deixe em **Observar** e faça a mixagem da live como sempre;
   - num momento bom do louvor, aperte **Gravar mixagem atual como alvo**. Faça o mesmo na pregação para o pastor. Só os canais que estão tocando são gravados;
   - acompanhe a coluna **Correção**: é o que o software faria. Fez sentido? Então passe para **Automático**.

## Configuração ([config/config.json](config/config.json))

| Campo | Padrão | O que é |
|---|---|---|
| `mixer.ip` | `192.168.0.122` | IP da mesa |
| `server.host` | `127.0.0.1` | Use `0.0.0.0` para abrir o painel de um celular/tablet na mesma rede |
| `server.port` | `8080` | Porta do painel |
| `streamAuxes` | `[7]` | Auxes da transmissão |
| `initialMode` | `observar` | Modo ao abrir o programa |
| `leveler.gateDB` | `-50` | Abaixo disso o canal é considerado em silêncio |
| `leveler.averagingSec` | `4` | Janela da média de nível (maior = reage mais devagar e respeita mais a dinâmica da música) |
| `leveler.minActiveSec` | `2` | Tempo tocando antes de começar a corrigir |
| `leveler.deadbandDB` | `2` | Tolerância em torno do alvo |
| `leveler.cutRateDBps` / `boostRateDBps` | `1.0` / `0.4` | Velocidade máxima para abaixar / subir |
| `leveler.maxCutDB` / `maxBoostDB` | `9` / `4` | Limites em relação à sua mixagem |
| `leveler.maxSendDB` | `6` | Teto absoluto de qualquer envio |
| `leveler.manualHoldSec` | `30` | Pausa no canal depois que você mexe nele |
| `leveler.learnFromOperator` | `true` | Seu ajuste manual atualiza o alvo |

Os alvos ficam salvos em `data/estado.json` e sobrevivem a reinícios do programa.
Cada culto gera um log em `data/sessoes/` (níveis, correções e intervenções), que será usado nas próximas frentes.

## Segurança

A interface da Ui24R **não tem senha**. Não exponha a mesa na internet (Cloudflare Tunnel, port forward etc.): qualquer pessoa com o link poderia mutar a live. Para acesso remoto, publique só o **painel deste programa** atrás de **Cloudflare Access**, que é gratuito e pede login por e-mail. Isso ainda vai ser implementado: veja o roadmap.

## Roadmap (frentes)

- [x] **1. Equilíbrio automático do aux da live** (VU → envios)
- [ ] 2. Perfis por momento do culto (louvor / pregação / ceia), com troca automática pelos canais ativos ou por cues da mesa
- [ ] 3. Relatório pós-culto com IA local e gratuita (Ollama) a partir dos logs em `data/sessoes/`
- [ ] 4. Alertas: clipping, microfone aberto sem uso, aux da live alto demais
- [ ] 5. Acesso remoto seguro ao painel (Cloudflare Tunnel + Access)
- [ ] 6. Integração com Stream Deck / Companion e OBS

## Estrutura

```
src/
  main.ts                  ponto de entrada (npm start / npm run sim)
  app.ts                   liga mesa, niveladores, persistência e log
  server.ts                painel web + WebSocket /ws
  diagnostico.ts           npm run diagnostico
  config.ts                leitura do config/config.json
  leveler/aux-leveler.ts   O ALGORITMO: alvo, correção, limites, operador
  leveler/gated-level.ts   média de nível que ignora silêncio
  mixer/types.ts           contrato comum (mesa real ou simulador)
  mixer/soundcraft-adapter.ts  Ui24R real (biblioteca soundcraft-ui-connection)
  mixer/simulator.ts       mesa falsa para testes
public/                    painel (HTML/CSS/JS puro)
test/                      testes do algoritmo (npm test)
```

Usa a biblioteca [soundcraft-ui-connection](https://github.com/fmalcher/soundcraft-ui) (MIT).
