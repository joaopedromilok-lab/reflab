# Fala espontânea real: CORAA (português do Brasil)

Os testes com `--coraa` usam conversas e entrevistas reais com transcrição validada por pessoas.

## Origem e licença

- **Conjunto:** CORAA v1.1 — <https://huggingface.co/datasets/gabrielrstan/CORAA-v1.1> (divisão `test`)
- **Licença:** [Creative Commons BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/):
  uso só para teste interno. **Nada desse material vai para o Git nem para o app.**
- **Citação:** Candido Junior, A. et al. *CORAA: a large corpus of spontaneous and prepared speech manually
  validated for speech recognition in Brazilian Portuguese.* 2021. arXiv:2110.15731.

Na primeira execução, `coraa.js` baixa o índice do conjunto de teste (2,6 MB) e lê de dentro do `test.zip`
(2,4 GB) **só os segmentos escolhidos**, por requisições de intervalo HTTP: cerca de 22 MB em
`test/transcricao/coraa/` (pasta no `.gitignore`). Usa só módulos nativos do Node.js.

## Passagens

Uma por acervo, com cerca de 200 palavras de segmentos seguidos de uma mesma gravação.
A escolha é automática (a primeira gravação, na ordem dos nomes, com palavras suficientes) e fica
gravada em `coraa/passagens.json`.

| Passagem | Acervo | Fala |
|---|---|---|
| `nurc-dialogo` | NURC-Recife | Diálogo entre informantes, gravação dos anos 1970 |
| `alip-entrevista` | ALIP (interior de SP) | Entrevista com um adolescente |
| `coral-conversa` | C-ORAL-BRASIL I (MG) | Conversa informal entre várias pessoas |
| `sp2010-entrevista` | SP2010 (capital) | Entrevista que inclui um trecho de notícia **lido** |

Cada uma roda em duas condições: `original` (0,3 s entre os segmentos) e `ruido-festa`
(as mesmas vozes ao contrário do FLEURS, SNR 6 dB).

## Rodar

```bash
node test/transcricao/executar.js --so-coraa
node test/transcricao/executar.js --so-coraa --sem-recuperacao
```

## Limites

- A numeração dos segmentos de teste tem buracos (partes que ficaram em treino/validação), então a
  passagem pode pular pedaços da conversa e as pausas reais entre falas viram 0,3 s.
- O gabarito transcreve hesitações ("eh", "ahn") e palavras cortadas. O whisper costuma omiti-las,
  então o WER absoluto fica alto. A comparação com e sem recuperação continua válida.
- Falas sobrepostas estão no gabarito como texto corrido.
