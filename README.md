# Copiloto Ui24R

> **Para que serve:** este é um projeto aberto para **auxiliar a operação de mesas de som Soundcraft Ui24R em equipes reduzidas**, por exemplo uma igreja onde uma ou duas pessoas cuidam do som do salão, dos retornos e da transmissão ao mesmo tempo. Ele **não substitui** o operador: ajuda a manter os auxiliares equilibrados, organiza presets e deixa cada pessoa mexer só no que é dela.
>
> Projeto independente, **sem ligação com a Soundcraft/Harman**. "Soundcraft" e "Ui24R" são marcas dos seus donos. Use por sua conta e risco; comece sempre no modo **Observar**.

## O que ele faz

- **Equilíbrio automático de auxiliares** (ex.: o aux da live): lê o nível de cada canal e corrige devagar o envio quando alguém fica alto ou baixo demais, dentro de limites em torno da sua mixagem. Canal em silêncio nunca é mexido.
- **Efeito acompanha:** quando o envio de um canal desce, o reverb dele desce junto na saída (sem a voz "dentro do banheiro").
- **Tela de mixagem em tela cheia**, como na mesa: todos os canais lado a lado, os efeitos e um único master no canto (do aux escolhido ou do salão).
- **Painel do canal:** clique no nome do canal (com **Expandir canal** ligado) e veja todos os volumes dele: master do salão, envio para a saída atual, efeitos 1–4 e os outros auxiliares.
- **Modos de visualização:** quantos faders cabem na tela (8, 12, 16, 24…), quais canais aparecem e em que ordem. Cada pessoa cria os seus, e eles ficam salvos no servidor (SQLite).
- **Presets por saída** ("Louvor – mais batera", "Pregação"…) com fade suave.
- **Pessoas e permissões:** um **admin** cadastra as pessoas e escolhe quais saídas cada uma pode usar, para ninguém mexer no auxiliar do outro. Usuário e senha simples (letras e números, senha com 5 ou mais caracteres).
- **Conexão:** IP da mesa, saúde da conexão (tempo de resposta, perda, dados chegando) e troca entre mesa real e **simulador**.
- **Duas fontes de nível:**
  - **VU pela rede** (padrão, sem cabo);
  - **áudio USB** (conexão física): detecta a Ui24R no Windows e mede o áudio de cada canal com o ffmpeg que já vem junto. O **controle** é sempre pela rede; pelo USB a mesa só manda áudio.
- **Log de cada culto** em `data/sessoes/` (níveis, correções e quem mexeu), base para relatórios futuros com IA.

## Instalação

Precisa do **[Node.js 22 ou mais novo](https://nodejs.org/)**. O SQLite já vem dentro do Node, não precisa instalar banco.

```bash
npm install
```

O `npm install` já baixa tudo, inclusive o **ffmpeg** usado na medição pelo áudio USB (pacote `ffmpeg-static`). Não precisa instalar nada à parte.

A única coisa que não dá para vir dentro do programa é o **driver USB da Ui24R**, que é um driver de hardware do Windows. Se a mesa ligada no USB não aparecer na lista de áudio da tela Conexão, instale o driver da Soundcraft uma vez no Windows. Para usar só o VU pela rede, nada disso é necessário.

## Uso

Testar em casa, com uma mesa **simulada**:

```bash
npm run sim
```

Na igreja, com a mesa real:

```bash
npm start
```

Abra http://localhost:8080.

1. **Primeiro acesso:** entre com usuário **admin** e senha **admin** (criado automaticamente na primeira vez). **Troque a senha** em Conta/Pessoas: o projeto é público e todo mundo conhece a senha padrão. Enquanto ela não for trocada, aparece um aviso vermelho.
2. Em **Pessoas**, cadastre quem vai operar e marque as saídas de cada um (ex.: "live" só com o AUX 7+8).
3. Em **Conexão**, confira o IP da mesa (padrão `192.168.0.122`; no hotspot da Ui24R costuma ser `10.10.1.1`) e a saúde da conexão. O PC precisa estar na mesma rede da mesa.
4. Na **Mixagem**, escolha a **Saída** (ex.: AUX 7+8 · LIVE), deixe em **Observar**, faça a mixagem como sempre e clique em **Gravar alvo** num momento em que estiver soando bem.
5. Conferiu a coluna de correções e fez sentido? Passe para **Automático**. O modo é por saída.

Para descobrir qual aux é o da live e se há auxes em link estéreo:

```bash
npm run diagnostico
```

### A tela de mixagem

| Elemento | O que é |
|---|---|
| **Saída** | Qual saída você vê e mixa. Um par estéreo (ex.: AUX 7+8) aparece como uma opção só, e os dois lados mudam juntos. **MASTER** mexe no som do salão (pede confirmação). |
| **Automático: Desligado / Observar / Ligado** | Modo do automático **nesta saída**. |
| **Alvo: Gravar** | O nível atual de cada canal que está tocando vira o alvo do automático. |
| **Voltar ao original** | Botão de pânico: devolve os envios para a sua mixagem (ou para o preset carregado). |
| **Preset** | Carrega (com fade), salva (+), atualiza (↻) ou apaga (×) presets desta saída. |
| **Tela** | Modo de visualização; ✎ cria ou edita ("Quantos faders você quer ver na tela?", canais, efeitos). |
| **Expandir canal** | Ligado: clicar no nome do canal abre o painel com todos os volumes dele. |
| **Fader do canal** | Envio daquele canal para a saída. Fica laranja por um instante quando o automático mexe. Arrastar vale como mexer na mesa: o canal fica com você por 30 s e o alvo passa a ser o seu. |
| **Medidor** | Verde = agora; linha azul = média; linha branca = alvo. |
| **AUTO** | Liga/desliga o automático só daquele canal. |
| **Faixas rosa (FX)** | Retorno de cada efeito na saída. **ACOMP.** liga o "efeito acompanha"; o selo diz se o efeito toca no "salão+live" ou "só live". |
| **Master no canto** | Volume geral da saída; não muda o equilíbrio entre os canais. |

**Efeitos por canal e o salão:** na Ui24R, cada efeito é um só para o salão e para os auxes. Mexer no envio de um canal para um efeito que toca no salão muda o salão também. Por isso só o admin (ou quem tem o master) pode mexer nesses. Dica: reserve um dos 4 efeitos **só para a live** (retorno no master em -∞): aí quem cuida da live ajusta o reverb de cada canal sem mexer no salão.

## Configuração ([config/config.json](config/config.json))

| Campo | Padrão | O que é |
|---|---|---|
| `mixer.ip` | `192.168.0.122` | IP da mesa (dá para trocar na tela Conexão) |
| `server.host` | `127.0.0.1` | Use `0.0.0.0` para abrir o painel de celulares/tablets na mesma rede (todos precisam de login) |
| `server.port` | `8080` | Porta do painel (ou `PORT=8081 npm start`) |
| (variável) `COPILOTO_DATA` | `./data` | Outra pasta de dados, ex.: para rodar uma cópia de teste isolada |
| `streamAuxes` | `[7]` | Saída que já começa em `initialMode` e que aparece primeiro |
| `initialMode` | `observar` | Modo inicial dessa saída; as outras começam desligadas |
| `leveler.*` | | Limites e velocidades do automático (tolerância, quanto pode subir/descer, pausa depois que o operador mexe, fade dos presets, "efeito acompanha"…) |

Os dados ficam em `data/`, que não vai para o git:
- `copiloto.db`: SQLite com usuários, permissões, sessões e modos de visualização;
- `estado*.json`: alvos e modos por saída;
- `presets*.json`: presets;
- `conexao.json`: IP escolhido na tela;
- `sessoes/`: logs.

## Segurança

- A interface da Ui24R **não tem senha**. **Não exponha a mesa na internet.** Para acesso remoto, publique só o painel deste programa atrás de algo como Cloudflare Access.
- Senhas guardadas com scrypt + sal; sessões em cookie HttpOnly/SameSite; 5 tentativas erradas bloqueiam o login por 30 s.
- As permissões valem no servidor, não só na tela: um operador não consegue mexer em saídas que não são dele nem pela API.

## Desenvolvimento

```bash
npm test
```

```bash
npm run typecheck
```

```
src/
  main.ts                    ponto de entrada (npm start / npm run sim)
  app.ts                     mesa ↔ niveladores de todas as saídas ↔ permissões ↔ presets ↔ log
  server.ts                  painel web, API (/api/*), login e WebSocket /ws (visão por pessoa)
  auth.ts  db.ts  views.ts   usuários/permissões, SQLite, modos de visualização
  health.ts                  saúde da conexão
  levels/usb-audio.ts        detecção da Ui24R no USB e captura de nível via ffmpeg
  leveler/aux-leveler.ts     o algoritmo do automático (testado)
  leveler/fx-follower.ts     "efeito acompanha" (testado)
  mixer/soundcraft-adapter.ts  Ui24R real (biblioteca soundcraft-ui-connection)
  mixer/simulator.ts         mesa falsa
public/                      telas (HTML/CSS/JS puro): mixagem, conexão, pessoas, login
test/                        testes (vitest)
```

Usa a biblioteca [soundcraft-ui-connection](https://github.com/fmalcher/soundcraft-ui) (MIT).

## Roadmap

- [x] Equilíbrio automático dos auxiliares, efeito acompanha, presets
- [x] Tela de mixagem em tela cheia, painel do canal, modos de visualização (SQLite)
- [x] Pessoas e permissões por saída
- [x] Saúde da conexão; mesa real ou simulador; nível pela rede ou pelo USB
- [x] ffmpeg embutido; captura testada com sinal gerado e com dispositivo de áudio real do Windows
- [ ] Validar a captura USB com a Ui24R ligada no USB
- [ ] Ordenar canais arrastando no editor de modos
- [ ] Troca automática de preset por momento do culto
- [ ] Relatório pós-culto com IA local (Ollama) a partir dos logs
- [ ] Alertas (clipping, microfone aberto sem uso)

## Licença

[MIT](LICENSE)
