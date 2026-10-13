# Recursos do modo Áudio USB

No modo Áudio USB, o Copiloto recebe o **áudio de cada canal** pelo cabo USB da Ui24R. Ele captura com o ffmpeg (DirectShow no Windows), em PCM 16 bits a 48 kHz, e analisa tudo no próprio PC. O som **não passa** pelo Copiloto: é só análise. O controle da mesa continua pela rede.

Para testar sem a mesa: rode `npm run sim` e, em **Conexão › Medição de nível**, clique em **Usar USB simulado**. O simulador gera áudio de verdade (fala com sílabas, canto com vibrato, acordes, batidas). No painel do canal dá para **injetar microfonia ou zumbido**.

## Como ligar na mesa real

1. Ligue o cabo USB da Ui24R no PC. Se o Windows não reconhecer a mesa, instale o driver USB da Soundcraft (uma vez).
2. **Conexão › Procurar a Ui24R no USB**. A tela mostra se achou a mesa, a versão do ffmpeg embutido e os dispositivos de áudio.
3. Escolha o dispositivo da mesa e o número de canais e clique em **Usar este áudio USB**.
4. Os recursos aparecem na tela **Análise** e nas **Dicas**.

Considera-se que o canal N do USB é a entrada N da mesa (patch padrão).

## Alerta de microfonia

Arquivo: `src/analysis/detectors.ts` (`FeedbackDetector`).

A cada 200 ms, para cada canal com sinal, o software faz uma FFT de 4096 pontos (janela de Hann, ~11,7 Hz por bin) e procura picos que:
1. estejam acima de -50 dBFS, entre 100 Hz e 12 kHz;
2. se destaquem **22 dB ou mais** dos vizinhos (pico estreito);
3. **não tenham harmônicos** (2ª e 3ª harmônica e meia frequência pelo menos 18 dB abaixo), porque microfonia é praticamente uma senoide pura;
4. **não façam parte de uma série harmônica** (voz e instrumentos têm "irmãos" em f·(n±1)/n);
5. fiquem **parados na mesma frequência** (±2 bins) por **1 s ou mais** e **cresçam 3 dB ou mais**, ou se destaquem muito (32 dB ou mais).

A dica diz o canal e a frequência aproximada, para baixar o canal e depois cortar essa frequência no EQ.

**Limites conhecidos:** um teclado com timbre muito puro e nota longa pode, em casos raros, parecer microfonia. Os limiares estão em `FEEDBACK_DEFAULTS` e serão ajustados com uso real.

## Zumbido e chiado

Arquivo: `src/analysis/detectors.ts` (`analyzeNoise`). Só roda quando o canal está **quieto** (RMS entre -78 e -30 dBFS).
- **Zumbido:** 60 Hz (ou 50 Hz) 18 dB ou mais acima do fundo (mediana de 30 Hz a 1 kHz), com 2ª/3ª harmônica presentes, por 2 s ou mais. Costuma ser cabo, DI ou aterramento.
- **Chiado:** espectro "plano" entre 1 e 15 kHz (flatness acima de 0,4) num canal sem ninguém tocando, por 5 s ou mais. Costuma ser ganho alto com o instrumento parado ou equipamento ruidoso.

## Espectro (RTA)

Arquivo: `src/analysis/rta.ts`. São 30 bandas de 1/3 de oitava (25 Hz a 20 kHz), suavizadas (sobem rápido e descem 3 dB por atualização). O espectro ao vivo só é enviado para o canal aberto no painel. Na janela do canal ele aparece em barras e também por baixo da curva do equalizador.

## Que som é esse? (identificação do canal)

Arquivo: `src/analysis/identify.ts`. Enquanto o canal toca, o motor acumula:
- a **distribuição da energia** por faixa (abaixo de 120 Hz, 120–500, 500–2k, 2k–6k, acima de 6k), o **centroide** e a "ruidosidade" acima de 1 kHz;
- **ataques por segundo** (blocos de 50 ms que sobem 9 dB ou mais) e **quanto o som cai ~150 ms depois** de cada ataque (percussão despenca 15–40 dB; fala e canto sustentam a sílaba);
- **pausas** e **variação de volume** entre blocos (voz oscila por sílabas e frases; instrumento sustentado não).

Regras: grave + ataques com queda rápida = **bumbo**; grave sustentado com fundamental abaixo de 120 Hz = **baixo**; quase tudo acima de 2 kHz = **pratos/overhead**; ataques rápidos com ruído largo = **caixa**; médios com pausas ou variação de sílabas = **voz**; o resto = **violão/guitarra/teclado**. Precisa de ~2,5 s tocando; durante pausas longas fica com a última resposta. A confiança aparece na janela do canal e na tela Análise ("ouvido: …"). Sem áudio USB, o tipo vem do **nome** do canal.

Usos: botão **Volume ideal › Pelo tipo de som**, dicas de equilíbrio, sugestões de EQ e o papel "automático (pelo som)" do fala × música (instrumento reconhecido conta como música).

## Sugestões de EQ

Arquivo: `src/analysis/eq-advice.ts`. Usa o espectro médio de minutos do canal (relativo ao nível dele, então mexer no volume não muda nada) e o tipo de som:
- **passa-altas** desligado e grave abaixo de 80 Hz acima de ~0,5% da energia (voz, violão, caixa, pratos);
- **embolado**: 250–400 Hz mais de 5 dB acima dos médios → −3 dB em ~300 Hz;
- **agressivo**: 2,5–4 kHz mais de 5 dB acima dos médios → −2 dB em ~3,2 kHz (não vale para pratos);
- **voz abafada**: pouca presença em 2–5 kHz → +2 dB em ~3,5 kHz;
- **bumbo "papelão"** (300–600 Hz) → −4 dB em ~400 Hz; **baixo com ronco** → passa-altas em ~35 Hz.

Cada sugestão vira mudanças no EQ da mesa (escolhe uma banda livre perto da frequência) e só é aplicada com o clique em *Aplicar*, com confirmação, por admin ou quem tem o master. Muitos canais com sugestão viram uma dica só no painel Dicas.

## Fala × música

Arquivo: `src/analysis/moment.ts`.
- Cada canal tem um **papel**: fala, canto, instrumento, automático ou ignorar. O papel é adivinhado pelo nome ("Pastor" = fala, "Back" = canto, "Guitarra" = instrumento) e pode ser ajustado na tela Análise.
- O detector compara a **energia média recente da fala** com a **energia da música** (instrumentos + canto). Assim, um teclado de fundo durante a pregação não vira "música" se o pastor está acima dele.
- Canais em "automático (pelo som)" usam a identificação do canal: instrumento reconhecido conta como música; voz é classificada pelo jeito do som (fala tem muitas pausas curtas).
- A troca só acontece depois de **12 s** estáveis (histerese). Silêncio não troca nada.
- **Troca automática de preset:** na tela Análise, para cada saída, escolha o preset de "fala" e o de "música" e marque a saída. Quem tem acesso à saída pode configurar.

## Loudness da live (LUFS)

Arquivo: `src/analysis/loudness.ts`. Segue a **ITU-R BS.1770-4 / EBU R128**:
- filtro K;
- momentâneo (400 ms);
- curto prazo (3 s);
- integrado com gate absoluto (-70 LUFS) e relativo (-10 LU);
- pico de amostra.

O alvo padrão é **-14 LUFS** (YouTube); a dica avisa quando o integrado se afasta 3 LU ou mais.

De onde medir (tela Análise):
- **Outro dispositivo:** a saída que vai para a transmissão (Voicemeeter, OBS, a placa da live). É a opção recomendada.
- **Dois canais do USB da mesa:** se a mesa mandar a mixagem da live pelo USB.

## Gravação multipista

Arquivo: `src/analysis/recorder.ts`. Grava um WAV mono de 16 bits / 48 kHz **por canal** em `data/gravacoes/AAAA-MM-DD_HHMMSS/`. São cerca de 2,8 MB por minuto por canal: um culto de 2 h com 24 canais ocupa cerca de 8 GB. Os arquivos abrem no Reaper ou no Audacity.

## OBS Studio

Arquivo: `src/obs.ts`. Usa o obs-websocket v5, que já vem no OBS 28+ (OBS › Ferramentas › Configurações do servidor WebSocket).
- Mostra se a live está no ar e o nível da fonte de áudio escolhida, depois dos filtros do OBS.
- Dicas: **fonte mutada com a live no ar**, **live quase sem som**, **áudio clipando**.
- Liga e desliga os **filtros** da fonte (supressão de ruído RNNoise, compressor, limitador, plugins VST gratuitos).
- A senha do OBS fica só no PC (`data/estado.json`) e nunca é enviada ao navegador.
