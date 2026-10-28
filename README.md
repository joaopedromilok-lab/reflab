# RefLab

Baixador e laboratório de referências para editores de vídeo (Premiere Pro e DaVinci Resolve).
Baixa vídeos já em formatos que abrem no editor sem travar e tem ferramentas para estudar a edição.
Feito para uso pessoal e estudo.

## O que ele faz

- **Tela centrada no vídeo:** o Início pergunta o que fazer (baixar, transcrever, estudar a edição, achar momentos) e cada vídeo tem uma página com abas (resumo, cortes, momentos, transcrição, ferramentas). Biblioteca em grade com o que já foi feito em cada vídeo. Cores com contraste legível nos temas claro e escuro.
- **Download com presets para edição:** H.264 + AAC, HEVC + AAC (acelerado pelo chip do Mac), ProRes 422, original, WAV ou MP3.
- **Baixar só um trecho** (ex.: de 1:20 a 1:45).
- **Organização:** pasta de destino, subpastas por data, canal ou projeto, `.txt` com link e crédito, miniatura e legendas `.srt`.
- **Fila** com progresso; playlists opcionais. Os Mix automáticos do YouTube (`list=RD...`) são ignorados.
- **Estudar edição:** detecta os cortes e mostra número de planos, duração média, cortes por minuto e gráfico de ritmo, além de:
  - XML com a timeline já cortada em cada plano (Premiere: *Arquivo > Importar*; DaVinci: *Arquivo > Importar > Timeline*);
  - EDL de marcadores para o DaVinci;
  - lista de cortes em CSV;
  - folha de contato (imagem + página HTML);
  - dividir o vídeo em um arquivo por plano.
  - BPM da música, marcadores em cada batida e quantos cortes caem na batida;
  - paleta de cores de cada plano e do vídeo todo;
  - planos favoritos (★) que viram clipes.
- **Momentos e clipes:** detecta os momentos mais intensos pelo áudio (torcida, narração, aplausos), exporta marcadores e recorta vários trechos de uma vez, inclusive na vertical 9:16.
- **Transcrição e roteiro** (whisper.cpp, modelo large-v3-turbo por padrão e large-v3 para máxima qualidade, roda no próprio Mac):
  - transcrever direto de um link sem guardar o vídeo (usa a legenda do autor ou um áudio temporário que é apagado);
  - ignora música e silêncio (detecção de voz) e transcreve em blocos guiados por ela, para não perder fala baixa nem trechos depois de pausas longas; aceita nomes e palavras difíceis, tempo de cada palavra;
  - player junto com o texto, correção do texto, busca com marcadores;
  - montagem pelo texto: escolher frases e gerar timeline XML ou vídeo;
  - legenda gravada estilo Reels: 5 estilos prontos, fonte, cores, tamanho, posição, palavras em destaque, logo/marca d'água, formatos 9:16, 4:5 e 1:1 e prévia antes de gerar;
  - métricas do roteiro (palavras por minuto, tempo até a primeira fala, % com fala, pausas);
  - capítulos para o YouTube, `.srt` pronto para subir, legenda curta e legenda em inglês;
  - decupagem (roteiro AV: imagem | fala de cada plano);
  - transcrever uma pasta inteira e buscar dentro das falas de todos os vídeos (Biblioteca).
- **Comparar referências:** até 4 vídeos lado a lado (ritmo de edição, música e roteiro).
- **Remover silêncios** de entrevistas e discursos (timeline XML e vídeo).
- **Ferramentas:** converter arquivo local, gerar proxy ProRes, versão vertical, marcar batidas de uma música, extrair frames.
- **Antes de baixar:** resolução, fps, codec e tamanho estimado; aviso de link copiado; senha de vídeo (Vimeo).
- **Integração:** botão para abrir no Premiere/DaVinci e notificação do sistema quando uma tarefa termina.
- **Biblioteca** com busca, etiquetas e anotações.
- **Atualização automática do yt-dlp** (o YouTube muda com frequência).

Funciona com YouTube, Instagram, TikTok, Vimeo, X e os outros sites suportados pelo [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Instalar no Mac

1. Baixe `RefLab-mac-arm64.dmg` na página **Releases** do repositório, ou em **Actions** > última execução > *Artifacts*.
2. Abra o `.dmg` e arraste o **RefLab** para **Aplicativos**.
3. Na primeira vez, abra o **Terminal** e rode:

   ```bash
   xattr -cr /Applications/RefLab.app
   ```

   O comando é necessário porque o app não é assinado pela Apple. Isso só se faz uma vez.
4. Abra o RefLab. Na primeira execução ele baixa as ferramentas (yt-dlp, ffmpeg e Deno), cerca de 150 MB.

O app é para Mac com chip Apple (M1, M2, M3, M4).

## Desenvolver (Windows ou Mac)

```bash
npm install
```

```bash
npm start
```

## Gerar o app para Mac pelo GitHub

Cada `git push` na branch `main` roda o workflow **Gerar app** no GitHub Actions. Ele gera:
- `RefLab-mac-arm64.dmg` e `.zip` (Mac Apple Silicon);
- o instalador `.exe` (Windows).

Os arquivos ficam em **Actions** > execução > **Artifacts**. Para criar uma versão com página de download fixa, crie uma tag:

```bash
git tag v1.0.0
```

```bash
git push origin v1.0.0
```

## Lançar uma atualização

O app verifica as Releases do GitHub sozinho ao abrir. Também dá para verificar em **Ajustes > Buscar atualização**.
Quando existe versão nova, ele baixa, troca o app e reabre. Não é preciso baixar o `.dmg` de novo.

Para lançar uma versão nova depois de mudar o código:

```bash
npm version minor
```

```bash
git push --follow-tags
```

`npm version minor` sobe a versão (1.0.0 → 1.1.0), cria o commit e a tag `v1.1.0`. Use `patch` para correções pequenas (1.0.0 → 1.0.1).
O push da tag faz o GitHub gerar o app e publicar a Release. A partir daí os apps instalados já encontram a atualização.

## Estrutura

```
src/main/      processo principal (Node/Electron)
  tools.js     baixa e atualiza yt-dlp, ffmpeg, ffprobe e Deno
  jobs.js      fila de tarefas e downloads
  media.js     presets de edição, conversão e proxy (ffmpeg)
  study.js     detecção de cortes, XML/EDL/CSV, folha de contato, planos, frames
  updater.js   atualização do próprio app pelas Releases do GitHub
  audio.js     detector de momentos e batidas (BPM)
  clips.js     recortes de vários trechos e versão vertical
  moments.js   resultado do detector e marcadores
  transcribe.js transcrição com whisper.cpp e legenda do YouTube
  captions.js  legendas (.srt, YouTube, Reels) e legenda gravada (.ass)
  script.js    métricas do roteiro e capítulos
  montage.js   montagem pelo texto, vídeo final e remoção de silêncios
  decupagem.js roteiro AV e comparação de referências
  editors.js   abrir no Premiere / DaVinci
src/renderer/  interface
assets/        fonte das legendas (Anton, OFL) e modelo de detecção de voz (Silero)
.github/       workflow que gera o app de Mac e Windows
```
