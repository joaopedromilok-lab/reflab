# Amostras reais (português brasileiro)

O arquivo `manifesto.json` lista as amostras planejadas. **Nenhuma foi avaliada ainda.**

Os arquivos ficam em `amostras/arquivos/`, que **não vai para o Git** (material de cliente e
direitos autorais). Para cada `id` do manifesto:

| Arquivo | Obrigatório | Conteúdo |
|---|---|---|
| `<id>.wav` (ou .mp3, .m4a, .mp4, .mov, .flac) | sim | O trecho de áudio ou vídeo |
| `<id>.txt` | sim | Texto de referência **revisado por uma pessoa**: exatamente o que é falado, sem marcar música ou risos |
| `<id>.tempos.json` | não | Tempos conferidos à mão para medir o erro de tempo |

Formato de `<id>.tempos.json`:

```json
{
  "palavras": [{ "w": "Ana", "start": 12.40 }, { "w": "Rafael", "start": 13.05 }],
  "iniciosFala": [12.40, 47.80]
}
```

- `palavras`: algumas palavras (10 a 20 bastam) com o início conferido num editor (Premiere/DaVinci/Audacity),
  espalhadas pelo trecho, principalmente **logo depois de pausas e de música**.
- `iniciosFala`: momentos em que a fala recomeça depois de uma pausa longa ou de música.
- Se houver nomes difíceis, coloque-os em `nomesDificeis` no manifesto (o teste passa como "nomes e palavras difíceis").

Rodar:

```bash
node test/transcricao/executar.js --amostras
```
