# Copiloto Ui24R

> **Para que serve:** software livre para **auxiliar a operação de mesas de som Soundcraft Ui24R em equipes reduzidas**, por exemplo numa igreja onde uma ou duas pessoas cuidam ao mesmo tempo do salão, dos retornos e da transmissão ao vivo. Ele **não substitui** o operador: mantém os auxiliares equilibrados, avisa quando algo está errado (clip, microfonia, live baixa…), organiza presets e deixa cada pessoa mexer só no que é dela.
>
> Projeto independente, **sem ligação com a Soundcraft/Harman**. "Soundcraft" e "Ui24R" são marcas dos seus donos. Use por sua conta e risco e comece sempre no modo **Só sugerir**.

Licença: **GPL-3.0** (software livre de cooperação: quem distribuir uma versão modificada precisa compartilhar o código). Contribuições são bem-vindas, veja [CONTRIBUINDO.md](CONTRIBUINDO.md).

---

## Sumário

- [O que ele faz](#o-que-ele-faz)
- [Instalação](#instalação)
- [Primeiros passos](#primeiros-passos)
- [As telas](#as-telas)
- [Modo VU (rede) e modo Áudio USB](#modo-vu-rede-e-modo-áudio-usb)
- [Configuração](#configuração)
- [Segurança](#segurança)
- [Perguntas frequentes](#perguntas-frequentes)
- [Desenvolvimento](#desenvolvimento)
- [Roadmap](#roadmap)

## O que ele faz

**Sempre (pela rede, sem cabo extra):**
- **Equilíbrio automático de auxiliares** (ex.: o aux da live). Lê o nível de cada canal e corrige devagar o envio quando alguém fica alto ou baixo demais, dentro de limites em torno da sua mixagem. Canal em silêncio nunca é mexido, para não virar ruído.
- **Efeito acompanha:** quando o envio de um canal desce, o reverb dele desce junto na saída, sem a voz "dentro do banheiro".
- **Tela de mixagem em tela cheia**, como na mesa:
  - todos os canais lado a lado, com o número embaixo;
  - os efeitos e um único master no canto (do aux escolhido ou do salão);
  - linhas alinhadas.
- **MUTE em cada faixa** (canais e efeitos): muta o envio só na saída que você está vendo; no MASTER é o mute do canal na mesa.
- **Janela do canal** (clique no nome): mute, ganho e phantom 48V, todos os volumes do canal (master do salão, esta saída, efeitos 1–4, outros auxiliares), **equalizador** (4 bandas + passa-altas, com a curva desenhada), ajuste automático, alertas do canal e espectro.
- **Tipo de som de cada canal** (voz, bumbo, caixa, pratos, baixo, violão/guitarra/teclado): pelo nome do canal no modo VU e **ouvindo o áudio** no modo USB. Serve para o botão **Volume ideal › Pelo tipo de som** (a voz principal vira referência e cada tipo fica alguns dB abaixo dela) e para as dicas.
- **Dicas:** clip, volume baixo demais, possível ruído ou microfone aberto sem uso, saída perto de clipar, ajuste automático no limite e **equilíbrio entre os canais pelo VU** (canal muito acima ou quase sumido em relação aos outros, voz encoberta pela banda), sempre com quanto mexer. O painel tem uma nota explicando equilíbrio e equalização.
- **Presets por saída** ("Música – mais batera", "Fala"…) com fade suave.
- **Modos de visualização** salvos no servidor (SQLite): quantos faders cabem na tela e quais canais aparecem.
- **Pessoas e permissões:** o admin escolhe quais saídas cada pessoa pode usar, para ninguém mexer no auxiliar do outro.
- **Conexão:** IP da mesa, saúde da conexão (tempo de resposta, perda, dados chegando), troca entre mesa real e **simulador**.

**No modo Áudio USB (conexão física), tela Análise:**
- **Alerta de microfonia:** acha o tom puro que está crescendo e diz a frequência ("Pastor: microfonia em ~2,5 kHz").
- **Zumbido (60/50 Hz) e chiado** por canal.
- **Espectro (RTA)** de 1/3 de oitava na janela do canal, desenhado também por baixo da curva do EQ.
- **Sugestões de EQ** pelo som médio de cada canal e pelo tipo de som (passa-altas, som embolado em 250–400 Hz, agudo agressivo, voz abafada, bumbo "papelão"…), aplicáveis com um clique.
- **Fala × música:** detecta fala (pregação, avisos) ou música e **troca o preset sozinho**.
- **Loudness da live (LUFS, ITU-R BS.1770)**, com alvo de -14 LUFS (YouTube).
- **Gravação multipista** (um WAV por canal) para treinar a mixagem durante a semana.
- **Integração com o OBS Studio:** mostra se a live está no ar e o nível real da transmissão, avisa se a fonte está muda, mutada ou clipando, e liga/desliga filtros e plugins do OBS.

## Instalação

Precisa do **[Node.js 22 ou mais novo](https://nodejs.org/)**. Depois, na pasta do projeto:

```bash
npm install
```

O `npm install` baixa **tudo**: o banco (SQLite já vem no Node) e o **ffmpeg** usado no modo Áudio USB (pacote `ffmpeg-static`). Não precisa instalar nada à parte.

### Atalhos na área de trabalho (para quem não usa terminal)

Dê dois cliques em **`Criar atalhos na area de trabalho.bat`** (na pasta do projeto). Aparecem dois ícones:

- **Abrir Copiloto**: na primeira vez instala o que falta (`npm install`), liga o programa numa janela minimizada "Copiloto Ui24R" e abre o painel no navegador. Se já estiver ligado, só abre o painel.
- **Fechar Copiloto**: desliga o programa.

Não feche a janela minimizada "Copiloto Ui24R" na mão: use o atalho **Fechar Copiloto**. Se a área de trabalho não aceitar os atalhos, eles são criados na própria pasta do projeto. Os atalhos ligam a **mesa real** (`npm start`); o simulador continua disponível pela tela Conexão.

A única coisa que não pode vir dentro do programa é o **driver USB da Ui24R**, que é um driver de hardware do Windows. Só é necessário para o modo Áudio USB, e só se o Windows não reconhecer a mesa sozinho.

## Primeiros passos

1. Rode o programa.
   - Na igreja, com a **mesa real**:
     ```bash
     npm start
     ```
   - Em casa, com o **simulador** (uma mesa falsa, com USB simulado, microfonia e zumbido de teste):
     ```bash
     npm run sim
     ```
2. Abra **http://localhost:8080** e entre com usuário **admin** e senha **admin**. Esse usuário é criado sozinho na primeira vez. **Troque a senha** em *Conta*: o projeto é público e todo mundo conhece a senha padrão. Enquanto ela não for trocada, aparece um aviso vermelho.
3. Em **Conexão**, confira o IP da mesa (padrão `192.168.0.122`; no hotspot da Ui24R costuma ser `10.10.1.1`). O PC precisa estar na mesma rede da mesa.
4. Em **Pessoas**, cadastre quem vai operar e marque as saídas de cada um (ex.: "live" só com o AUX 7+8).
5. Na **Mixagem**, escolha a **Saída** (ex.: AUX 7+8 · LIVE), deixe o **Ajuste automático de volume** em *Só sugerir*, faça a mixagem como sempre e clique em **Volume ideal › Gravar volumes atuais** num momento em que estiver soando bem (ou em **Pelo tipo de som**, com a banda e a voz tocando).
6. A correção mostrada embaixo de cada fader fez sentido? Passe para **Ajustando**. O modo é por saída.

Primeira vez com a mesa real? Siga o roteiro [docs/PRIMEIRO-TESTE.md](docs/PRIMEIRO-TESTE.md). Para descobrir qual aux é o da live, quais estão em link estéreo e se a mesa aceita os comandos (sem mudar o som):

```bash
npm run diagnostico
```

## As telas

### Mixagem

**Barra de cima (1º andar):**
- abas Mixagem, Análise, Conexão e Pessoas;
- controles do simulador (só aparecem no simulador);
- **⛔ BYPASS** (botão de pânico, também nas telas Análise e Conexão): um clique e o Copiloto **para de mexer na mesa** e só monitora. Veja abaixo;
- **Dicas**, com um contador que fica laranja ou vermelho quando há algo importante;
- selo da mesa (verde = mesa real com o tempo de resposta; roxo = simulador);
- seu usuário.

**2º andar: cinco seções**, cada uma numa caixa com cor própria. O botão **? Como funciona** explica cada uma.

| Seção | O que faz |
|---|---|
| **Saída** | Qual saída você vê e mixa: aux da live, um retorno ou o master (salão). Par estéreo aparece junto (ex.: AUX 7+8). Cada pessoa vê a sua. |
| **Ajuste automático de volume** | O software mantém cada canal perto do volume ideal. *Desligado* (só mostra), *Só sugerir* (mostra quanto mexeria, sem mexer), *Ajustando* (corrige devagar). Vale só para esta saída. |
| **Volume ideal** | A referência do ajuste automático. *Gravar volumes atuais*: o volume de agora de cada canal vira o ideal. *Pelo tipo de som*: calcula a partir da voz principal (backs ~5 dB abaixo, bumbo/baixo ~6, violão/teclado ~8, pratos ~12). *Desfazer ajustes*: volta os envios para antes das correções (pânico). |
| **Preset** | Carrega com fade (lista), salva (+), atualiza (↻), apaga (×) as mixagens desta saída. |
| **Tela** | Modo de visualização (✎ cria: quantos faders, quais canais) e **Expandir canal** (clique no nome abre a janela do canal). |

**Cada faixa de canal mostra:**
- **nome**;
- **estado** (ok, corrige, silêncio, operador…; passe o mouse para a explicação);
- etiqueta **48V** quando o phantom está ligado;
- **AUTO** (ajuste automático só deste canal) e **MUTE** (vermelho = mutado nesta saída);
- **medidor**: verde = agora, azul = média, branco = volume ideal;
- **fader**, que é o envio para a saída e fica laranja quando o software mexe;
- valor e correção;
- **número do canal** embaixo.

As faixas rosa são os **retornos dos efeitos**: o botão **ACOMP.** liga o "efeito acompanha", e o selo diz se o efeito toca no salão. No canto direito fica o **master** da saída.

**Janela do canal** (com *Expandir canal* ligado, clique no nome; ✕, Esc ou clique fora fecham):
- **Todos os volumes do canal em faders grandes:** master (salão), esta saída, efeitos F1–F4 e os outros auxiliares liberados. Os efeitos que tocam no salão ficam bloqueados para quem não tem o master.
- **Ganho (pré)**, de -6 a +57 dB. Muda o **salão e todas as saídas**, por isso só o admin ou quem tem o master pode mexer, e mudanças grandes pedem confirmação.
- **Phantom 48V**: só o admin, com confirmação (ligar ou desligar com som aberto dá estalo).
- **MUTE** do canal na saída que você está vendo, e o **tipo de som** identificado ("som: voz (pelo áudio, 96%)" ou "pelo nome").
- **Equalizador** da mesa: 4 bandas paramétricas (frequência, ganho, largura/Q), passa-altas e liga/desliga, com a curva desenhada sobre o espectro do canal. Muda o canal **inteiro** (salão, auxes e live): só o admin ou quem tem o master. No modo USB aparecem **sugestões de EQ** com botão *Aplicar*. Os valores aparecem com "≈" porque a conversão da escala interna da mesa (0..1) para Hz/dB não é documentada; veja *Perguntas frequentes*.
- **Ajuste automático deste canal**: AUTO, volume ideal, nível agora, média e correção.
- **Alertas** só deste canal e **espectro** (modo USB).

### Análise (modo Áudio USB)

Alertas ao vivo, loudness da live, fala × música (troca automática de preset por saída e papel de cada canal), gravação multipista e OBS. Detalhes em [docs/RECURSOS-USB.md](docs/RECURSOS-USB.md).

### Conexão

- **De onde vem o som:** mesa real (IP, com **Testar** e **Conectar**) ou simulador. A troca é na hora.
- **Senha da mesa (Settings › Access):** marque *A mesa tem senha* e digite a senha. A conexão de controle da Ui24R **não pede senha** (só a página da mesa pede), então nada é enviado: o Copiloto guarda a senha só neste PC (`data/conexao.json`) para **conferir** com a que a mesa informa.
- **Teste de comando:** roda sozinho ao conectar na mesa real (e pelo botão). Mexe no pan do canal 1 numa quantidade impossível de ouvir, volta, e confere por uma segunda conexão se a mesa aceitou. Mostra ✓ OK ou o motivo da falha.
- **Medição de nível:** VU pela rede ou Áudio USB. Inclui **Procurar a Ui24R no USB**, que detecta a mesa no Windows e lista os dispositivos de áudio.
- **Saúde da conexão:**
  - tempo de resposta (atual, média, melhor e pior);
  - perda;
  - idade do último dado da mesa;
  - VU e mensagens por segundo;
  - reconexões;
  - gráfico dos últimos 2 minutos.
- Também mostra os **IPs deste PC** (avisando se estão em outra rede que não a da mesa) e o histórico da conexão.

### Pessoas / Conta

O admin cadastra pessoas (usuário e senha de letras e números; senha com 5 ou mais caracteres), escolhe o papel (admin ou operador) e marca as **saídas liberadas** de cada um. Todos podem trocar a própria senha.

## Modo VU (rede) e modo Áudio USB

| | VU (rede) | Áudio USB (físico) |
|---|---|---|
| Cabo | só a rede/Wi-Fi | rede **e** cabo USB da mesa ao PC |
| O que o software recebe | um número de volume por canal (~20×/s) | o **áudio** de cada canal |
| Controle (faders, envios) | pela rede | pela rede (pelo USB a mesa só manda áudio) |
| Recursos | automático, dicas, presets, permissões… | tudo do VU **+** microfonia, zumbido, chiado, espectro, fala × música, loudness, gravação, OBS |

O som **nunca passa pelo PC**: tudo é só análise, então não há atraso nem risco para o culto se o PC travar.

## Configuração

Arquivo [config/config.json](config/config.json):

| Campo | Padrão | O que é |
|---|---|---|
| `mixer.ip` | `192.168.0.122` | IP da mesa (dá para trocar na tela Conexão) |
| `server.host` | `127.0.0.1` | Use `0.0.0.0` para abrir o painel em celulares e tablets da mesma rede (todos precisam de login) |
| `server.port` | `8080` | Porta do painel (ou `PORT=8081 npm start`) |
| (variável) `COPILOTO_DATA` | `./data` | Outra pasta de dados, ex.: para rodar uma cópia de teste isolada |
| `streamAuxes` | `[7]` | Saída que já começa em `initialMode` e aparece primeiro |
| `initialMode` | `observar` | Modo inicial dessa saída (`desligado`, `observar` = *Só sugerir*, `automatico` = *Ajustando*); as outras começam desligadas |
| `leveler.*` | | Limites do automático: tolerância, quanto pode subir/descer, velocidade, pausa depois que o operador mexe, fade dos presets, "efeito acompanha" |

Os dados ficam em `data/`, que não vai para o git:
- `copiloto.db` (SQLite): usuários, permissões, sessões e modos de visualização;
- `estado*.json`: volumes ideais, modos por saída e configuração dos recursos avançados;
- `presets*.json`: presets;
- `conexao.json`: IP escolhido na tela;
- `sessoes/`: log de cada culto;
- `gravacoes/`: gravações multipista.

## Segurança

- A interface da Ui24R **não tem senha**. **Não exponha a mesa na internet.** Para acesso remoto, publique só o painel deste programa, atrás de algo como Cloudflare Access.
- **Troque a senha padrão `admin/admin`** logo no primeiro acesso.
- Senhas são guardadas com scrypt + sal; sessões em cookie HttpOnly/SameSite; 5 tentativas erradas bloqueiam o login por 30 s.
- As permissões valem **no servidor**: um operador não consegue mexer em saídas que não são dele nem pela API.

## Perguntas frequentes

**Como faço o Copiloto parar de mexer em tudo, na hora?**
Clique em **⛔ BYPASS** no topo da tela (qualquer pessoa logada pode). A partir daí o Copiloto **não manda nada para a mesa**: nem envios, faders, mute, EQ, ganho, phantom, presets ou o teste de comando. Os níveis, as dicas e as sugestões continuam na tela (as correções aparecem como "corrigiria"), e uma faixa vermelha avisa quem ligou e quando. Os controles que mexem na mesa ficam travados, e o servidor também recusa. O bypass continua ligado mesmo se o programa reiniciar. Para desligar: clique de novo e confirme.

**Exceção do bypass (testar numa saída só):** com o bypass ligado, a faixa vermelha tem *mexer só em:* — escolha uma saída (ex.: o fone de um músico) e o Copiloto passa a mexer **só nos envios dela** (faders, mute, ajuste automático, presets). EQ, ganho, phantom, efeitos, o salão e as outras saídas continuam protegidos. Ao desligar e religar o bypass, a exceção some.

**Ele mexe no som do salão?**
Só se você escolher a saída **MASTER** (fica em vermelho e pede confirmação), mexer no **ganho** ou no **phantom**, ou mexer em **efeitos que tocam no salão**. Nos auxiliares, ele mexe só nos envios daquele aux.

**Como ele sabe que dois auxes estão em link estéreo?**
Lê da própria mesa. O par aparece como uma saída só (ex.: AUX 7+8).

**Preciso de plugins pagos?**
Não. Para processar o áudio da transmissão, use os plugins **gratuitos** dentro do OBS (supressão de ruído RNNoise, compressor, limitador, ReaPlugs, LoudMax…). O Copiloto liga e desliga esses filtros pela tela Análise.

**Minha mesa tem senha (Settings › Access). O Copiloto funciona?**
Sim. Na Ui24R a senha é conferida pela **página da mesa** (navegador/tablet); a conexão de controle que o Copiloto e outros programas usam não pede senha (verificado pelo autor da biblioteca [soundcraft-ui](https://github.com/bitfocus/companion-module-soundcraft-ui/issues/49)). Na tela Conexão, marque *A mesa tem senha* e digite a senha para o Copiloto conferir; o **teste de comando** confirma, sem mudar o som, que a mesa aceita os comandos. Se um firmware futuro bloquear, o teste mostra FALHOU.

**Os valores do equalizador batem com os da mesa?**
A mesa guarda cada parâmetro do EQ como um número de 0 a 1 e a fórmula exata não é publicada. O Copiloto usa a conversão mais comum (frequência e Q em escala logarítmica, ganho linear de ±20 dB) e mostra "≈". Para conferir, rode `npm run diagnostico`: ele imprime o EQ do canal 1 (bruto e convertido). Compare com a interface web da mesa; se não bater, as constantes ficam todas em `src/mixer/eq.ts`. Contribuições com a calibração são bem-vindas.

**Como ele sabe se o canal é voz, bumbo, baixo…?**
No modo VU, pelo nome do canal (BUMBO, Kick, Cx, OH, Baixo, Violão, Voz Pastor…). No modo Áudio USB ele ouve o canal: energia por faixa de frequência, ataques por segundo e a queda logo depois (percussão), pausas e variação de volume (voz). É uma estimativa; a confiança aparece na janela do canal e na tela Análise.

**O PC não está na rede da mesa.**
A tela Conexão mostra os IPs do PC e avisa "outra rede". Conecte o PC no mesmo Wi-Fi ou cabo da mesa.

## Desenvolvimento

```bash
npm test
```

```bash
npm run typecheck
```

- Arquitetura e decisões: [docs/ARQUITETURA.md](docs/ARQUITETURA.md)
- Recursos do modo USB (como cada detector funciona): [docs/RECURSOS-USB.md](docs/RECURSOS-USB.md)
- Roteiro do primeiro teste com a mesa real: [docs/PRIMEIRO-TESTE.md](docs/PRIMEIRO-TESTE.md)
- Como contribuir: [CONTRIBUINDO.md](CONTRIBUINDO.md)

Usa a biblioteca [soundcraft-ui-connection](https://github.com/fmalcher/soundcraft-ui) (MIT) para conversar com a mesa e o [ffmpeg](https://ffmpeg.org/) (via `ffmpeg-static`, baixado no `npm install`) para capturar o áudio USB.

## Roadmap

- [x] Equilíbrio automático dos auxiliares, efeito acompanha, presets
- [x] Mixagem em tela cheia, janela do canal (ganho, phantom, efeitos), modos de visualização
- [x] Pessoas e permissões por saída
- [x] Saúde da conexão; mesa real ou simulador; nível pela rede ou pelo USB
- [x] Dicas; microfonia, zumbido, chiado, espectro, fala × música, loudness, gravação, OBS
- [x] Mute por saída, equalizador do canal, tipo de som (nome e áudio), dicas de equilíbrio e sugestões de EQ
- [ ] Validar com a Ui24R real (rede e USB) e ajustar os limites dos detectores
- [ ] Calibrar a escala do equalizador com a mesa real
- [ ] Ordenar canais arrastando no editor de modos
- [ ] Relatório pós-culto a partir dos logs
- [ ] Sugerir o corte de EQ para a microfonia detectada

## Licença

Copyright (C) 2026 Marcelino Dias Junior e colaboradores.

Este programa é software livre: você pode redistribuí-lo e/ou modificá-lo sob os termos da **GNU General Public License versão 3** (ou, a seu critério, qualquer versão posterior), publicada pela Free Software Foundation. Ele é distribuído na esperança de ser útil, mas **sem nenhuma garantia**. Veja o arquivo [LICENSE](LICENSE).
