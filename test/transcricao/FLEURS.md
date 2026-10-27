# Fala humana real: FLEURS (português do Brasil)

Os testes com `--fleurs` usam frases gravadas por pessoas, com o texto exato de referência.

## Origem e licença

- **Conjunto:** FLEURS, Google — <https://huggingface.co/datasets/google/fleurs> (configuração `pt_br`, divisão `test`)
- **Licença:** [Creative Commons Attribution 4.0 (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- **Citação:** Conneau, A. et al. *FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech.* 2022. arXiv:2205.12446.
- **Modificações:** os clipes são concatenados, recebem pausas, música sintética, vozes ao contrário
  (outros clipes do mesmo conjunto), chiado e mudança de volume para montar as condições de teste.

Os áudios **não vão para o Git**. Na primeira execução, `fleurs.js` baixa `test.tsv` e os
**40 primeiros clipes** de `audio/test.tar.gz` para `test/transcricao/fleurs/` (pasta no `.gitignore`).
São cerca de 35 MB, e o download para no meio do arquivo de 621 MB. Usa só módulos nativos do Node.js.

## Condições

Todas usam as mesmas 7 frases (99 s de fala, 188 palavras), exceto `sem-fala`.

| Condição | O que testa |
|---|---|
| `limpo-continuo` | Fala contínua sem fundo |
| `musica-moderada` / `musica-forte` | Música sintética por baixo (SNR 10 dB / 3 dB) |
| `ruido-festa` | Vozes ao fundo (SNR 6 dB). É onde o whisper pulava uma frase inteira |
| `fala-baixa` | Fala em cerca de −40 dBFS com chiado |
| `pausas-variadas` | Pausas de 1, 4, 12 (música), 2, 6 e 15 s |
| `sem-fala` | Só música, silêncio e chiado: nada deve ser transcrito |

## Rodar

```bash
node test/transcricao/executar.js --so-fleurs
node test/transcricao/executar.js --so-fleurs --sem-recuperacao              # compara sem a recuperação
node test/transcricao/executar.js --so-fleurs --raiz ../outra-copia --rotulo anterior   # outra versão do código
node test/transcricao/executar.js --so-fleurs --modelo small --recuperacao-forcada     # liga a recuperação (experimento)
node test/transcricao/executar.js --so-fleurs --fleurs-conjunto validacao-a            # frases que não serviram de calibração
```

### Conjuntos de frases

| Conjunto | Clipes usados como fala | Uso |
|---|---|---|
| `calibracao` (padrão) | 1 a 7 | Serviram para ajustar os filtros da recuperação |
| `validacao-a` | 8 a 14 | Validação: **não ajustar nada com base neles antes de medir** |
| `validacao-b` | 15 a 20 | Validação, idem |

Os três usam as mesmas vozes de fundo (clipes 21 a 40, ao contrário) e a mesma música sintética.

A recuperação de falas omitidas fica **desligada por padrão em todos os modelos**, inclusive no turbo:
nas frases de validação (e no CORAA) as recuperações aceitas pioraram o texto. Ela só roda com
`--recuperacao-forcada` (ou `ativa: true` nas opções), para experimentos.

Medidas: WER (trocas, palavras perdidas e inventadas), trechos perdidos (3+ palavras seguidas),
frases perdidas (metade ou mais das palavras), repetições a mais e, para cada recuperação aceita,
se ela **melhorou ou piorou** o texto em relação ao gabarito.

## Limites

- **Fala lida**, não espontânea, e de poucos falantes. A coluna de gênero do arquivo de origem marca todos como masculinos.
- A música e o chiado são sintéticos, e as "vozes ao fundo" são fala ao contrário (ininteligível).
- Uma só passagem de 188 palavras: cada palavra vale cerca de 0,5 ponto de WER, então diferenças pequenas são ruído.
- Não substitui as amostras reais de casamento, futebol e publicidade (`amostras/`).
