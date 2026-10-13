# Contribuindo

Obrigado por querer ajudar! O Copiloto Ui24R nasceu para ajudar equipes de som pequenas (igrejas, escolas, eventos). Toda ajuda conta: testar na sua mesa, relatar problemas, melhorar a documentação ou o código.

## Relatar um problema

Abra uma *issue* contando:
- o que você fez, o que esperava e o que aconteceu;
- modelo e firmware da mesa (aparece na tela Conexão) e se estava em modo VU ou Áudio USB;
- se possível, o log do culto em `data/sessoes/` (remova o que for pessoal).

## Preparar o ambiente

Precisa do Node.js 22 ou mais novo:

```bash
npm install
```

```bash
npm run sim
```

O comando acima abre o simulador em http://localhost:8080 (usuário `admin`, senha `admin`). Em Conexão, "Usar USB simulado" liga os recursos do modo USB sem precisar da mesa.

Para rodar uma segunda cópia, isolada, sem misturar dados:

```bash
COPILOTO_DATA=./dados-teste PORT=8081 npm run sim
```

## Antes de abrir um *pull request*

```bash
npm run typecheck
```

```bash
npm test
```

- **Escreva em português** (código, comentários, mensagens e telas), como o resto do projeto.
- **Algoritmos vêm com teste**, de preferência com sinais sintéticos de resultado conhecido (veja `test/analysis.test.ts`).
- Toda funcionalidade nova precisa funcionar **com o simulador e com a mesa real** (contrato `MixerAdapter`).
- **Permissões ficam no servidor** (`App.handle`), nunca só na tela.
- Mantenha o padrão seguro: modo **Só sugerir** antes de **Ajustando**, limites de correção, nada que mexa no salão sem deixar isso claro.
- Commits pequenos, com mensagem dizendo **o quê** e **por quê**.

## Licença

Ao contribuir, você concorda que sua contribuição seja distribuída sob a **GPL-3.0-or-later**, a mesma licença do projeto ([LICENSE](LICENSE)).
