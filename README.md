# RefLab

Baixador e laboratório de referências para editores de vídeo (Premiere Pro e DaVinci Resolve).
Baixa vídeos já em formatos que abrem no editor sem travar e tem ferramentas para estudar a edição.
Feito para uso pessoal e estudo.

## O que ele faz

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
- **Ferramentas:** converter arquivo local, gerar proxy ProRes, extrair frames.
- **Histórico** com busca.
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

## Estrutura

```
src/main/      processo principal (Node/Electron)
  tools.js     baixa e atualiza yt-dlp, ffmpeg, ffprobe e Deno
  jobs.js      fila de tarefas e downloads
  media.js     presets de edição, conversão e proxy (ffmpeg)
  study.js     detecção de cortes, XML/EDL/CSV, folha de contato, planos, frames
src/renderer/  interface
.github/       workflow que gera o app de Mac e Windows
```
