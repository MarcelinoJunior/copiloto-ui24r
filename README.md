# Copiloto Ui24R

> **Para que serve:** software livre para **auxiliar a operação de mesas de som Soundcraft Ui24R em equipes reduzidas**, por exemplo numa igreja onde uma ou duas pessoas cuidam ao mesmo tempo do salão, dos retornos e da transmissão ao vivo. Ele **não substitui** o operador: mantém os auxiliares equilibrados, avisa quando algo está errado (clip, microfonia, live baixa…), organiza presets e deixa cada pessoa mexer só no que é dela.
>
> Projeto independente, **sem ligação com a Soundcraft/Harman**. "Soundcraft" e "Ui24R" são marcas dos seus donos. Use por sua conta e risco e comece sempre no modo **Só sugerir**.

Licença: **GPL-3.0** (software livre de cooperação: quem distribuir uma versão modificada precisa compartilhar o código). Contribuições são bem-vindas, veja [CONTRIBUINDO.md](CONTRIBUINDO.md).

## ⬇ Baixar (Windows)

**[Baixar o instalador mais recente: Copiloto-Setup.exe](https://github.com/MarcelinoJunior/copiloto-ui24r/releases/latest/download/Copiloto-Setup.exe)** · [todas as versões e novidades](https://github.com/MarcelinoJunior/copiloto-ui24r/releases)

Dois cliques e pronto: instala sem pedir administrador, já traz tudo o que precisa e cria o ícone **Copiloto Ui24R** na área de trabalho. O Copiloto abre na **própria janela** (como um programa normal); **fechar a janela desliga o Copiloto**. Enquanto ele estiver aberto, a **mesma tela** fica disponível pela rede para celulares e tablets (cada pessoa com o próprio login): o endereço aparece em **Configurações › Este computador**. Depois de instalado, ele avisa sozinho quando houver versão nova (**Atualizar agora**, no topo da tela). Detalhes em [Instalação](#instalação).

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
- **Efeito acompanha:** o envio de cada canal para o efeito (FX1, FX2…) copia o fader dele numa **saída escolhida para cada efeito** (padrão: a live; pode ser o master ou outro aux), com a diferença escolhida na tela (**igual, −2, −4, −8, −10, −15, −20 dB** ou **manter**). Mexeu o canal nessa saída, na mesa ou pelo ajuste automático, o efeito daquele canal vai junto. Ex.: o reverb da voz copia a live com −4 dB, e o delay copia o master. Um botão **FX** em cima de cada canal deixa ignorar canais (ex.: bumbo, baixo). O envio para o efeito é um só por canal: se o retorno do efeito também está no salão, o reverb do salão muda junto (normalmente imperceptível lá).
- **Voz sumida na live:** uma voz que fica muito abaixo da voz mais alta na live (mais de 12 dB, por 10 s; ex.: o envio de uma cantora esquecido lá embaixo) ganha um volume ideal novo, 8 dB abaixo da voz mais alta, e sobe devagar (até 15 dB acima da sua mixagem). Em *Só sugerir* aparece a sugestão e um aviso. Se você mexer no fader dessa voz na live, o Copiloto respeita por 10 min. Vale para os canais que são voz: pelo nome (pastor, ministro, vocal, back…) ou marcados no botão **🎤 É voz?** da janela do canal (ex.: canais com o nome da cantora).
- **Tela parada:** se o painel perder a ligação com o Copiloto, a mixagem escurece e aparece "⚠ TELA PARADA", para ninguém confiar em medidores congelados.
- **Tempo de análise** do ajuste automático na tela: 5, 10, 20, 30 ou 60 s por saída (mais tempo = ignora picos).
- **Tela de mixagem em tela cheia**, como na mesa:
  - todos os canais lado a lado, com o número embaixo;
  - os efeitos e um único master no canto (do aux escolhido ou do salão);
  - linhas alinhadas.
- **MUTE em cada faixa** (canais e efeitos): muta o envio só na saída que você está vendo; no MASTER é o mute do canal na mesa.
- **Janela do canal** (clique no nome): mute, ganho e phantom 48V, todos os volumes do canal (master do salão, esta saída, efeitos 1–4, outros auxiliares), **equalizador** (4 bandas + passa-altas, com a curva desenhada), ajuste automático, alertas do canal e espectro.
- **Tipo de som de cada canal** (voz, bumbo, caixa, pratos, baixo, violão/guitarra/teclado): pelo nome do canal no modo VU e **ouvindo o áudio** no modo USB. Serve para o botão **Volume ideal › Pelo tipo de som** (a voz principal vira referência e cada tipo fica alguns dB abaixo dela) e para as dicas.
- **Dicas:** clip, volume baixo demais, possível ruído ou microfone aberto sem uso, saída perto de clipar, ajuste automático no limite e **equilíbrio entre os canais pelo VU** (canal muito acima ou quase sumido em relação aos outros, voz encoberta pela banda), sempre com quanto mexer. O equilíbrio usa a média dos últimos ~30 s e só avisa se o problema durar 20 s (picos de bumbo/caixa não viram dica; percussão tem mais tolerância; talk back fica de fora). O painel tem uma nota explicando equilíbrio e equalização.
- **Presets por saída** ("Música – mais batera", "Fala"…) com fade suave.
- **Modos de visualização** salvos no servidor (SQLite): quantos faders cabem na tela e quais canais aparecem.
- **Pessoas e permissões:** o admin escolhe quais saídas cada pessoa pode usar, para ninguém mexer no auxiliar do outro.
- **Configurações:** travas de segurança (liberar saídas ainda não testadas), IP da mesa, saúde da conexão (tempo de resposta, perda, dados chegando), troca entre mesa real e **simulador**.

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

### Jeito fácil (Windows): instalador

Baixe o **[Copiloto-Setup.exe](https://github.com/MarcelinoJunior/copiloto-ui24r/releases/latest/download/Copiloto-Setup.exe)** (sempre a versão mais recente) e dê dois cliques. Ele instala sem pedir administrador, já traz o Node.js e as bibliotecas (nada para instalar à parte) e cria os ícones **Abrir Copiloto** e **Fechar Copiloto** na área de trabalho. O Windows pode mostrar "O Windows protegeu o computador" (o instalador não é assinado): clique em **Mais informações › Executar assim mesmo**.

**Atualizações:** o Copiloto confere o GitHub ao ligar e a cada 30 minutos. Quando houver versão nova, aparece uma faixa azul no topo: **Atualizar agora** (só o admin). Ele nunca atualiza sozinho (para não reiniciar no meio do culto). Ao atualizar, baixa a versão nova, mantém os dados (usuários, presets, senha da mesa, `data/`) e reinicia em ~30 s; a página volta sozinha. A tela **Configurações › Versão do Copiloto** mostra a versão instalada e tem *Conferir atualização agora*. Configuração própria deste computador vai em `data/config.json` (a atualização nunca apaga; tem prioridade sobre `config/config.json`).

Para montar o instalador (quem desenvolve): `powershell -ExecutionPolicy Bypass -File scripts\montar-instalador.ps1` (precisa do Inno Setup 6; `-Testar` instala, liga e desinstala numa pasta de teste).

### Jeito manual (quem desenvolve)

Precisa do **[Node.js 22 ou mais novo](https://nodejs.org/)**. Depois, na pasta do projeto:

```bash
npm install
```

O `npm install` baixa **tudo**: o banco (SQLite já vem no Node) e o **ffmpeg** usado no modo Áudio USB (pacote `ffmpeg-static`). Não precisa instalar nada à parte.

### Atalhos na área de trabalho (para quem não usa terminal)

Dê dois cliques em **`Criar atalhos na area de trabalho.bat`** (na pasta do projeto). Aparece um ícone, **Copiloto Ui24R**: na primeira vez instala o que falta (`npm install`), liga o programa (escondido; mensagens em `data\copiloto.log`) e abre a **janela do Copiloto** (Microsoft Edge em modo aplicativo, que já vem no Windows: sem abas nem barra de endereço). Se já estiver ligado, só abre a janela.

**Para desligar: feche a janela** (ou o botão **⏻** no topo, só o admin). Um "vigia" escondido percebe a janela fechada e desliga o programa com calma. Sem Edge nem Chrome, o painel abre no navegador padrão.

**Celulares e tablets:** com `server.host` = `0.0.0.0` (padrão), a mesma tela abre em qualquer aparelho da rede, no endereço mostrado em **Configurações › Este computador** (ex.: `http://192.168.0.117:8124`), cada pessoa com o próprio login. Na primeira vez o Windows pode perguntar se permite o acesso pela rede: escolha **Redes privadas** e **Permitir**. Para deixar só neste computador, use `127.0.0.1`. Em emergência (painel fechado), há o **Fechar Copiloto.bat** na pasta do programa (e no Menu Iniciar, quando instalado pelo Setup). Se a área de trabalho não aceitar os atalhos, eles são criados na própria pasta do projeto. Os atalhos ligam a **mesa real** (`npm start`); o simulador continua disponível pela tela Configurações.

A única coisa que não pode vir dentro do programa é o **driver USB da Ui24R**, que é um driver de hardware do Windows. Só é necessário para o modo Áudio USB, e só se o Windows não reconhecer a mesa sozinho.

## Primeiros passos

1. Rode o programa.
   - Na igreja, com a **mesa real**:
     ```bash
     npm start
     ```
   - Em casa, com o **simulador** (uma mesa falsa, com USB simulado, microfonia e zumbido de teste). Depois que o Copiloto conecta uma vez na mesa real, o simulador **clona** os nomes dos canais, as saídas (live, fones, matrizes) e os envios dela (`data/mesa-espelho.json`):
     ```bash
     npm run sim
     ```
2. Abra **http://localhost:8124** e entre com usuário **admin** e senha **admin**. Esse usuário é criado sozinho na primeira vez. **Troque a senha** em *Conta*: o projeto é público e todo mundo conhece a senha padrão. Enquanto ela não for trocada, aparece um aviso vermelho.
3. Em **Configurações**, confira o IP da mesa (padrão `192.168.0.122`; no hotspot da Ui24R costuma ser `10.10.1.1`). O PC precisa estar na mesma rede da mesa.
4. Em **Pessoas**, cadastre quem vai operar e marque as saídas de cada um (ex.: "live" só com o AUX 7+8).
5. Na **Mixagem**, escolha a **Saída** (ex.: AUX 7+8 · LIVE), deixe o **Ajuste automático de volume** em *Só sugerir*, faça a mixagem como sempre e clique em **Volume ideal › Gravar volumes atuais** num momento em que estiver soando bem (ou em **Pelo tipo de som**, com a banda e a voz tocando).
6. A correção mostrada embaixo de cada fader fez sentido? Passe para **Ajustando**. O modo é por saída.

Primeira vez com a mesa real? Siga o roteiro [docs/PRIMEIRO-TESTE.md](docs/PRIMEIRO-TESTE.md). Para descobrir qual aux é o da live, quais estão em link estéreo e se a mesa aceita os comandos (sem mudar o som):

```bash
npm run diagnostico
```

## As telas

### Mixagem

A tela vai de cima para baixo, com o máximo de espaço para os faders: barra de cima; **uma linha** com o quadro "qual entrada é", **ajuste automático**, **volume ideal**, **presets** e **tela**; as **abas** (o que os faders mexem); os **faders**; e, embaixo, o **efeito acompanha** (2 efeitos por linha). O rodapé mostra a legenda dos medidores e das cores dos canais.

**A cor da tela mostra o que os faders estão mexendo** (como na Ui24R): **avermelhado = entrada (ganho)**, **escuro = master (salão)**, **alaranjado = auxiliares** (live, fones), **azulado = efeitos (envios)**. Assim fica claro quando você trocou de controle.

**Barra de cima:**
- abas Mixagem, Análise, Configurações e Pessoas;
- controles do simulador (só aparecem no simulador);
- aviso **⚠ senha padrão** (enquanto o admin usar a senha `admin`; clique para trocar);
- selo da mesa (verde = mesa real com o tempo de resposta; roxo = simulador);
- **Dicas**, com um contador que fica laranja ou vermelho quando há algo importante;
- **⛔ BYPASS** (botão de pânico, também nas telas Análise e Configurações): um clique e o Copiloto **para de mexer na mesa** e só monitora. Veja abaixo;
- **⏻ Desligar o Copiloto** (só o admin; também nas telas Análise e Configurações): fecha o programa para todo mundo depois de confirmar. Os envios da mesa ficam como estão. Para ligar de novo, use o ícone *Abrir Copiloto*;
- **⚙** com o seu usuário (trocar senha, sair).

**Qual entrada é:** ao **passar o mouse ou arrastar um fader**, a faixa acende e o quadro no começo da linha de cima mostra em destaque **qual entrada é** (número, nome, valor e destino, ex.: *20 JAQUE −34,1 dB · voz · envio para AUX 5+6*). Na mesma linha ficam os controles (abaixo) e a **Tela** (modo de visualização; ✎ cria: quantos faders, quais canais).

**Cada faixa de canal mostra:**
- a **engrenagem ⚙** em cima: abre a janela do canal (ganho, volumes do salão, das saídas e dos efeitos FX1 a FX4, e o equalizador);
- uma **etiqueta no topo com o número grande e o nome**, colorida pelo tipo de som: **azul = voz, verde = instrumento, laranja = bateria, cinza = outros**. O tipo vem do nome do canal, do áudio (modo USB) ou do botão **🎤 É voz?** na janela do canal. Nomes longos que não cabem são separados por sílaba (GUI-TARRA);
- **estado** (ok, corrige, silêncio, operador…; passe o mouse para a explicação);
- etiqueta **48V** quando o phantom está ligado;
- **AUTO** (ajuste automático só deste canal) e **MUTE** (vermelho = mutado nesta saída);
- **medidor**: verde = agora, azul = média, branco = volume ideal;
- **fader**, que é o envio para a saída e fica laranja quando o software mexe;
- valor e correção.

As faixas rosa são os **retornos dos efeitos** nesta saída (o Copiloto não mexe neles sozinho). No canto direito fica o **master** da saída.

**Controles** (na linha de cima, ao lado do quadro "qual entrada é"), cada um numa caixa com cor própria; o botão **?** explica cada uma:

| Seção | O que faz |
|---|---|
| **Abas** (logo acima dos faders, como as de uma planilha) | O que os faders controlam: clique na aba. Par estéreo aparece como na mesa: duas abas coladas (ex.: **AUX 5** e **AUX 6** 🔗, L e R), e clicar em qualquer uma seleciona as duas. Ficam sempre numa linha só; nome comprido aparece com "…" (o nome inteiro aparece ao passar o mouse). Uma bolinha verde = "Ajustando", amarela = "Só sugerir". **Entrada · ganho**: o ganho do pré de cada canal (−6 a +57 dB), com o botão **+48V** no lugar do MUTE (só o admin, com confirmação). **Master**: os faders dos canais no salão. **Auxiliares**: os envios para a live ou um fone (par estéreo aparece junto, ex.: AUX 5+6). **FX1 a FX4**: o envio de cada canal para o efeito, com o retorno do efeito no salão no canto direito. Ganho e FX só aparecem para o admin e quem tem o master (mudam o canal inteiro: salão, live e fones); neles, ajuste automático, volume ideal e presets ficam apagados (são das saídas). Cada pessoa vê o seu. |
| **Ajuste automático de volume** | O software mantém cada canal perto do volume ideal. *Desligado* (só mostra), *Só sugerir* (mostra quanto mexeria, sem mexer), *Ajustando* (corrige devagar). Ao lado, quantos segundos de som ele analisa. Vale só para esta saída. |
| **Volume ideal** | A referência do ajuste automático. *Gravar atuais*: o volume de agora de cada canal vira o ideal. *Pelo tipo*: calcula a partir da voz principal (backs ~5 dB abaixo, bumbo/baixo ~6, violão/teclado ~8, pratos ~12). *Desfazer*: volta os envios para antes das correções (pânico). |
| **Presets** | Um botão para cada mixagem salva desta saída (ex.: Música, Fala, Avisos): clique para carregar com fade suave; o ativo fica verde. *+ novo* salva a mixagem atual, ↻ atualiza o ativo, × apaga o ativo. |

**Efeito acompanha** (embaixo dos faders, 2 efeitos por linha; sempre visível para quem pode mexer nos efeitos; funciona sozinho, não importa o que está na tela): cada efeito pergunta **de qual saída copiar o fader** de cada canal (a live, o master ou outro aux) e **com quanto**, nos botões *não copiar, igual, −2, −4, −8, −10, −15, −20* ou *manter*. Ele só mexe no efeito de um canal quando o fader daquele canal muda; para **alinhar todos os canais agora**, clique de novo na diferença já escolhida (ou responda OK ao escolher). Veja "Efeito acompanha" acima.

**Janela do canal** (clique na engrenagem **⚙** em cima do canal; ✕, Esc ou clique fora fecham). Ocupa quase a tela toda e **não tem barra de rolagem**: os faders dividem a largura, o equalizador fica numa faixa embaixo e os alertas mostram só o título (o detalhe aparece ao passar o mouse; os demais ficam em Dicas):
- **Todos os volumes do canal em faders grandes:** master (salão), esta saída, efeitos F1–F4 e os outros auxiliares liberados. Os efeitos que tocam no salão ficam bloqueados para quem não tem o master.
- **Ganho (pré)**, de -6 a +57 dB. Muda o **salão e todas as saídas**, por isso só o admin ou quem tem o master pode mexer, e mudanças grandes pedem confirmação.
- **Phantom 48V**: só o admin, com confirmação (ligar ou desligar com som aberto dá estalo).
- **MUTE** do canal na saída que você está vendo, e o **tipo de som** identificado ("som: voz (pelo áudio, 96%)" ou "pelo nome").
- **Equalizador** da mesa: 4 bandas paramétricas (frequência, ganho, largura/Q), passa-altas e liga/desliga, com a curva desenhada sobre o espectro do canal. Muda o canal **inteiro** (salão, auxes e live): só o admin ou quem tem o master. No modo USB aparecem **sugestões de EQ** com botão *Aplicar*. Os valores aparecem com "≈" porque a conversão da escala interna da mesa (0..1) para Hz/dB não é documentada; veja *Perguntas frequentes*.
- **Ajuste automático deste canal**: AUTO, volume ideal, nível agora, média e correção.
- **Alertas** só deste canal e **espectro** (modo USB).

### Análise (modo Áudio USB)

Alertas ao vivo, loudness da live, fala × música (troca automática de preset por saída e papel de cada canal), gravação multipista e OBS. Detalhes em [docs/RECURSOS-USB.md](docs/RECURSOS-USB.md).

### Configurações

- **Travas de segurança:** lista do que ainda não foi testado com o Copiloto (saídas fora de `safeBuses`, e ganho/+48V/EQ/envios para efeitos) com *Liberar* (10 min, 1 h ou 3 h) e *Travar de novo*. A mixagem não mostra nada sobre isso.
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
| `mixer.ip` | `192.168.0.122` | IP da mesa (dá para trocar na tela Configurações) |
| `server.host` | `127.0.0.1` | Use `0.0.0.0` para abrir o painel em celulares e tablets da mesma rede (todos precisam de login) |
| `server.port` | `8124` | Porta do painel (ou `PORT=8081 npm start`). Se outro programa já usa essa porta (ex.: o AmpSim usa a 8080), o Copiloto usa a próxima livre e o atalho acha sozinho |
| (variável) `COPILOTO_DATA` | `./data` | Outra pasta de dados, ex.: para rodar uma cópia de teste isolada |
| `streamAuxes` | `[5, 6]` | Saída da live: já começa em `initialMode` e aparece primeiro (confira com `npm run diagnostico`). Par estéreo: pode escrever os dois números ou só um; o Copiloto mexe nos dois lados juntos |
| `safeBuses` | (sem) | Opcional. Saídas **já testadas** com o Copiloto (ex.: `[5, 6, 9]`). Com esta linha, as outras, o master e os controles do canal inteiro (ganho, phantom, EQ, efeitos) ficam **travados** até alguém liberar em **Configurações › Travas de segurança** (10 min, 1 h ou 3 h, só para quem liberou). Sem esta linha (padrão), nada fica travado |
| `initialMode` | `observar` | Modo inicial dessa saída (`desligado`, `observar` = *Só sugerir*, `automatico` = *Ajustando*); as outras começam desligadas |
| `leveler.*` | | Limites do automático: tolerância, quanto pode subir/descer, velocidade, pausa depois que o operador mexe, fade dos presets, "efeito acompanha" |
| `leveler.rescueBelowDB` / `rescueToDB` / `rescueAfterSec` / `rescueMaxBoostDB` | `12` / `8` / `10` / `15` | Voz sumida na live: quantos dB abaixo da voz mais alta disparam, onde fica o novo volume ideal (abaixo da voz mais alta), por quanto tempo precisa ficar baixa e quanto pode subir acima da sua mixagem |

Os dados ficam em `data/`, que não vai para o git:
- `copiloto.db` (SQLite): usuários, permissões, sessões e modos de visualização;
- `estado*.json`: volumes ideais, modos por saída e configuração dos recursos avançados;
- `presets*.json`: presets;
- `conexao.json`: IP escolhido na tela;
- `sessoes/`: log de cada culto (níveis da live a cada 2 s, mexidas do operador e do Copiloto, envios para os efeitos, vozes sumidas);
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

**Quero usar o Copiloto só na live e no meu fone, por enquanto.**
Coloque essas saídas em `safeBuses` no `config/config.json` (ex.: `[5, 9]`). As outras ficam travadas, sem aviso na mixagem (só não deixam mexer; ao tentar, aparece uma mensagem curta). Para mexer numa delas, vá em **Configurações › Travas de segurança**, escolha por quanto tempo (10 min, 1 h ou 3 h) e clique em *Liberar*; vale só para você, em todas as telas, até o tempo acabar ou você clicar em *Travar de novo*. Ganho, +48V, EQ e envios para efeitos (que mudam o canal inteiro) têm a mesma trava, na mesma lista. Uma saída fora da lista nunca volta ligada em "Ajustando" depois de reiniciar.

**Ele mexe no som do salão?**
Só se você escolher a saída **MASTER** (a tela fica escura e pede confirmação), mexer no **ganho** ou no **phantom**, ou mexer em **efeitos que tocam no salão**. Nos auxiliares, ele mexe só nos envios daquele aux.

**Como ele sabe que dois auxes estão em link estéreo?**
Lê da própria mesa. O par aparece como uma saída só (ex.: AUX 7+8).

**Preciso de plugins pagos?**
Não. Para processar o áudio da transmissão, use os plugins **gratuitos** dentro do OBS (supressão de ruído RNNoise, compressor, limitador, ReaPlugs, LoudMax…). O Copiloto liga e desliga esses filtros pela tela Análise.

**Minha mesa tem senha (Settings › Access). O Copiloto funciona?**
Sim. Na Ui24R a senha é conferida pela **página da mesa** (navegador/tablet); a conexão de controle que o Copiloto e outros programas usam não pede senha (verificado pelo autor da biblioteca [soundcraft-ui](https://github.com/bitfocus/companion-module-soundcraft-ui/issues/49)). Na tela Configurações, marque *A mesa tem senha* e digite a senha para o Copiloto conferir; o **teste de comando** confirma, sem mudar o som, que a mesa aceita os comandos. Se um firmware futuro bloquear, o teste mostra FALHOU.

**Os valores do equalizador batem com os da mesa?**
A mesa guarda cada parâmetro do EQ como um número de 0 a 1 e a fórmula exata não é publicada. O Copiloto usa a conversão mais comum (frequência e Q em escala logarítmica, ganho linear de ±20 dB) e mostra "≈". Para conferir, rode `npm run diagnostico`: ele imprime o EQ do canal 1 (bruto e convertido). Compare com a interface web da mesa; se não bater, as constantes ficam todas em `src/mixer/eq.ts`. Contribuições com a calibração são bem-vindas.

**Como ele sabe se o canal é voz, bumbo, baixo…?**
Você pode marcar na janela do canal (botão **🎤 É voz?**), o que vale mais que tudo. Sem marca: no modo VU, pelo nome do canal (BUMBO, Kick, Cx, OH, Baixo, Violão, Voz Pastor…); nomes de pessoas (ex.: JAQUE) não dizem que é voz, então marque. No modo Áudio USB ele ouve o canal: energia por faixa de frequência, ataques por segundo e a queda logo depois (percussão), pausas e variação de volume (voz). É uma estimativa; a confiança aparece na janela do canal e na tela Análise.

**O PC não está na rede da mesa.**
A tela Configurações mostra os IPs do PC e avisa "outra rede". Conecte o PC no mesmo Wi-Fi ou cabo da mesa.

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
