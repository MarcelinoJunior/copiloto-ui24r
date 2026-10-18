# Primeiro teste com a mesa real (pela rede)

Roteiro para a primeira vez com a Ui24R de verdade. Leva uns 15 minutos e **não muda o som**: o Copiloto começa no modo *Só sugerir* e só mexe quando você mandar. Hoje sem USB: a medição de nível fica em **VU da mesa (rede)**.

## 1. Rede

- Ligue o PC na **mesma rede da mesa** (o Wi-Fi da igreja onde a Ui24R está, ou o Wi-Fi da própria mesa).
- Abra `http://192.168.0.122` no navegador. Se a página da mesa abrir, a rede está certa. (Se a mesa tiver senha em *Settings › Access*, a página dela vai pedir a senha: isso é normal e **não** afeta o Copiloto, veja abaixo.)

## 2. Diagnóstico (sem mudar nada)

Na pasta do projeto:

```bash
npm run diagnostico
```

Ou, com outro IP: `npm run diagnostico -- 192.168.0.122`. Confira:

| Item | O esperado |
|---|---|
| Modelo / firmware | `ui24` e a versão do firmware |
| VU | algumas leituras por segundo (com som passando) |
| AUXES | o aux da live com `[estéreo com AUX 8]` (ou o par que vocês usam) |
| ENVIOS | os canais que vão para a live, com valores parecidos com os da mesa |
| EQ do canal 1 | valores brutos aparecendo (servem para calibrar o EQ) |
| SENHA DA MESA | se a mesa informa a senha (o valor nunca é impresso) |
| TESTE DE COMANDO | `✓ OK em … ms` |

O teste de comando mexe no **pan do canal 1 em 0,0002** (impossível de ouvir) e volta. Uma segunda conexão confere se a mesa repassou a mudança, como a página da mesa veria.

**Guarde o texto do diagnóstico.** Se algo vier diferente do esperado, ele mostra o que ajustar.

## 3. Abrir o Copiloto

- Dê dois cliques em **Abrir Copiloto** (área de trabalho) ou rode `npm start`.
- Entre com o seu usuário. Na primeira vez é `admin` / `admin`: troque a senha.
- Vá em **Conexão**:
  - **IP da mesa** `192.168.0.122` e **Salvar e reconectar** se precisar;
  - **Saúde**: tempo de resposta baixo (poucos ms) e "VU recebido" com leituras por segundo;
  - **Senha da mesa**: marque **A mesa tem senha**, digite a senha da mesa e **Salvar**. Deve aparecer *Senha confere* (ou *a mesa não mostra a senha*, que também é normal). **Nada é enviado para a mesa**: a conexão de controle da Ui24R não pede senha; o Copiloto só guarda para conferir;
  - **Teste de comando**: roda sozinho ao conectar. Deve estar **✓ OK**.

## 4. Mixagem (só olhando)

- **Saída**: o aux da live (ex.: AUX 7+8). O modo deve estar **Só sugerir**.
- Os **nomes** dos canais e a posição dos **faders** devem bater com a mesa.
- Mexa um fader **na mesa** (tablet/página da mesa): o Copiloto acompanha.
- Mexa no Copiloto o fader de um canal **sem uso** nessa saída: a mesa acompanha. Volte o fader.
- Teste o **MUTE** num canal sem uso e desfaça.

## 5. Só depois de conferir tudo

- Com a mixagem da live soando bem: **Volume ideal › Gravar volumes atuais**.
- Deixe em **Só sugerir** por um tempo e veja se as sugestões embaixo dos faders fazem sentido.
- Só então passe para **Ajustando**.

## Se algo der errado

- **Fechar Copiloto** (ou Ctrl+C no terminal). Os envios ficam como estão; nada continua mexendo.
- Não conecta: confira se o PC está na mesma rede (a tela Conexão mostra os IPs do PC e avisa "outra rede").
- **Teste de comando FALHOU**: a mesa recebeu mas não repassou a mudança. Pode ser bloqueio por senha num firmware diferente. Mande o resultado do diagnóstico.
