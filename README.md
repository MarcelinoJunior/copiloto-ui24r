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

### Qual saída o software controla ("Saída")

Na barra de cima, **Saída** escolhe qual saída da mesa aparece e é controlada, uma por vez, como ao trocar de camada na Ui24R:

- **AUX** (ex.: **AUX 7+8 · LIVE**): o software mexe nos **envios** de cada canal para aquele aux. É o mesmo que você vê na Ui24R ao selecionar o aux. **O salão não muda.**
- **Par estéreo** (dois auxes em link na mesa) aparece como **uma opção só**, por exemplo AUX 7+8, e os dois lados mudam juntos.
- **MASTER**: o software mexe nos **faders dos canais no master**, ou seja, **no som do salão**. Pede confirmação e fica destacado em vermelho.

### O painel (vista "Mesa")

A tela ocupa a janela inteira:
- os **24 canais lado a lado**, com faders da altura da janela;
- os 4 efeitos;
- **um só master no canto direito**: o do aux escolhido, ou o do salão quando a saída é o master.

A barra de cima tem uma linha só: saída, modo, gravar alvo, presets e o menu **Exibir**. O último acontecimento aparece no rodapé; clique nele para ver o histórico.

Passando o mouse no nome ou no fader, aparece o que ele controla (ex.: "envio do canal para AUX 7+8" ou "fader do canal no master").

- **Fader do canal** = envio daquele canal para a saída escolhida. Ele se move sozinho quando o automático corrige (o botão do fader fica laranja por um instante). Se você arrastar, vale como se tivesse mexido na mesa: o canal fica em "operador" por 30 s e o alvo passa a ser o seu.
- **Medidor**: verde = nível agora; linha azul = média; linha branca = alvo; faixa clara = tolerância.
- **AUTO**: liga/desliga o controle automático só daquele canal.
- **Alvo − / +**: muda em 1 dB o nível que o automático persegue, sem mexer no fader na hora.
- **Envios de efeito por canal** (mini faders embaixo de cada canal): quanto daquele canal vai para cada efeito (reverb, delay...).
  - **Rosa** = efeito só da live: mexer não muda o salão.
  - **Laranja** = o efeito também toca no salão: mexer muda o salão **e** a live. Na Ui24R o mesmo efeito alimenta os dois.
  - **Dica:** para ajustar o efeito de cada canal só na live, reserve um dos 4 efeitos para a live. Deixe o retorno dele no master em -∞ e mande só para o aux da live.
- **Faixas rosa (FX 1–4)**: retorno de cada efeito na saída. **ACOMP.** liga o "efeito acompanha" (abaixo). O selo diz se o efeito toca no "salão + live" ou "só live".
- **Faixa do master** (à direita): volume geral daquela saída. Não muda o equilíbrio entre os canais.
- **Exibir**: liga/desliga os envios de efeito por canal e o ajuste de alvo (para ganhar altura de fader), mostra line/player e troca para a vista **Tabela**.

### Mesa real ou simulador

O selo no canto superior direito sempre diz de onde vêm os dados:
- **verde "mesa 192.168.0.122 · 4 ms"** = mesa real;
- **roxo "SIMULADOR (mesa falsa)"** = simulador.

No simulador também aparece uma faixa roxa logo abaixo da barra de cima. Nada do simulador vai para a Ui24R.

- `npm start` abre na **mesa real**; `npm run sim` abre no **simulador**.
- Dá para trocar a qualquer momento na tela **Conexão**, sem reiniciar.
- Alvos, saída escolhida e presets do simulador ficam separados dos da mesa real.

### Tela "Conexão"

Em **Conexão** (no topo, ou clicando no selo):

- **De onde vem o som**: cartão **Mesa real** (com o IP) ou **Simulador**; o que está em uso fica marcado "EM USO".
- **IP da mesa**: **Testar** verifica se a mesa responde nesse IP sem mudar nada (funciona até no simulador). **Conectar na mesa real** troca na hora. O IP fica salvo em `data/conexao.json` e tem prioridade sobre o `config/config.json`.
- **Saúde da conexão** (só para a mesa real): um selo (boa / instável / ruim / sem conexão) com o motivo, e estes indicadores:
  - **tempo de resposta** da mesa na rede: atual, média, melhor e pior;
  - **perda** nos testes de rede;
  - **idade do último dado** recebido: se passar de 1 s, o software está "cego";
  - VU e mensagens por segundo;
  - reconexões.
- **Gráfico** do tempo de resposta nos últimos 2 minutos.
- **Este computador**: os IPs do PC, avisando se ele está na **mesma rede da mesa**.
- **Histórico** da conexão.

### Presets

Um preset guarda a mixagem inteira da live: o envio de cada canal, o retorno de cada efeito e os alvos do automático. Exemplos: "Louvor – mais batera", "Louvor – mais guitarra", "Pregação".

- **+ Salvar novo**: monte a mixagem (pelos faders daqui ou na mesa) e dê um nome.
- **Clicar no preset**: carrega com **fade de 3 s** (`presetFadeSec`). Durante o fade o automático não interfere.
- **Atualizar ativo / Apagar ativo**: sobrescreve ou apaga o preset carregado.

Os presets ficam em `data/presets.json`.

### Efeito acompanha (reverb "de banheiro")

Quando o envio de um canal para a live desce e o reverb continua igual, a voz fica "dentro do banheiro". Com **ACOMP.** ligado, o retorno do efeito na live desce junto, na proporção de quanto cada canal alimenta aquele efeito:
- se o pastor é o único no reverb e desceu 4 dB, o reverb desce 4 dB;
- se só um de três backs desceu, o reverb desce um pouco;
- canal fechado na live tira a reverb dele da live.

Vale tanto para as correções do automático quanto para os seus ajustes manuais. Só mexe no **envio do retorno de efeito para o aux da live**: o salão e o efeito em si não mudam. A referência é a mixagem gravada ("Gravar mixagem atual como alvo") ou o preset carregado. Se você mexer no fader do efeito, o novo valor vira a referência.

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
- **arrastar um fader** do painel: é como você mexendo na mesa (o canal fica em "operador").

## Na igreja

1. Conecte o PC no Wi-Fi da mesa e confira se http://192.168.0.122 abre a interface da Ui24R.
2. Descubra qual aux é o da live:
   ```bash
   npm run diagnostico
   ```
   Ele lista os auxes com nome, quantos canais enviam para cada um e a tabela de envios dos auxes 7, 8 e 9. Auxes em **link estéreo** aparecem marcados (ex.: "estéreo com AUX 8").
3. Se o IP da mesa não for 192.168.0.122, troque na tela **Conexão** do painel. Depois escolha a saída da live em **Saída** (ex.: AUX 7+8).
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
| `streamAuxes` | `[7]` | Saída mostrada na primeira vez que o programa abre (depois vale a escolhida em **Saída**) |
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
| `leveler.fxRateDBps` | `3` | Velocidade máxima do "efeito acompanha" |
| `leveler.fxMaxCutDB` / `fxMaxBoostDB` | `20` / `6` | Limites do "efeito acompanha" em relação à referência |
| `leveler.presetFadeSec` | `3` | Duração do fade ao carregar um preset |

Os alvos ficam salvos em `data/estado.json` e sobrevivem a reinícios do programa.
Cada culto gera um log em `data/sessoes/` (níveis, correções e intervenções), que será usado nas próximas frentes.

## Segurança

A interface da Ui24R **não tem senha**. Não exponha a mesa na internet (Cloudflare Tunnel, port forward etc.): qualquer pessoa com o link poderia mutar a live. Para acesso remoto, publique só o **painel deste programa** atrás de **Cloudflare Access**, que é gratuito e pede login por e-mail. Isso ainda vai ser implementado: veja o roadmap.

## Roadmap (frentes)

- [x] **1. Equilíbrio automático do aux da live** (VU → envios)
- [x] Vista "Mesa" com faders verticais, presets com fade, "efeito acompanha", master da live
- [x] Escolha das saídas (aux, par estéreo, master), envio de efeito por canal, tela de Conexão
- [ ] 2. Troca automática de preset por momento do culto (pelos canais ativos ou por cues da mesa)
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
  leveler/fx-follower.ts   "efeito acompanha": retorno de FX segue os canais
  preset-store.ts          presets (data/presets.json)
  health.ts                saúde da conexão (tempo de resposta, perda, dados)
  connection-store.ts      endereço da mesa escolhido no painel (data/conexao.json)
public/conexao.html        tela "Conexão"
  mixer/types.ts           contrato comum (mesa real ou simulador)
  mixer/soundcraft-adapter.ts  Ui24R real (biblioteca soundcraft-ui-connection)
  mixer/simulator.ts       mesa falsa para testes
public/                    painel (HTML/CSS/JS puro)
test/                      testes do algoritmo (npm test)
```

Usa a biblioteca [soundcraft-ui-connection](https://github.com/fmalcher/soundcraft-ui) (MIT).
