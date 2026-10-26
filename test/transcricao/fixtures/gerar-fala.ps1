# Gera a fala de referência (pt-BR) usada nos testes sintéticos de transcrição.
# Usa a voz "Microsoft Maria" do Windows e registra o instante em que cada
# palavra começa (evento SpeakProgress), que vira o gabarito de tempos.
#
# Uso (no Windows, na pasta do projeto):
#   powershell -ExecutionPolicy Bypass -File test/transcricao/fixtures/gerar-fala.ps1
#
# Saída: fala-ptbr.wav (16 kHz, mono, 16 bits) e fala-ptbr.json (texto e tempos).
# Os arquivos gerados ficam versionados no repositório; só é preciso rodar de
# novo se o texto mudar.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$texto = 'Ana Beatriz e Rafael, hoje vocês prometem diante de todos cuidar um do outro. ' +
  'Na alegria e na tristeza, na saúde e na doença. ' +
  'O padre Antônio abençoa a união na Igreja Matriz de Santa Rita.'

$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$wav = Join-Path $pasta 'fala-ptbr.wav'
$json = Join-Path $pasta 'fala-ptbr.json'

$voz = New-Object System.Speech.Synthesis.SpeechSynthesizer
$maria = $voz.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1
if (-not $maria) { throw 'Nenhuma voz pt-BR instalada no Windows.' }
$voz.SelectVoice($maria.VoiceInfo.Name)
$voz.Rate = 0

$formato = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voz.SetOutputToWaveFile($wav, $formato)

$palavras = New-Object System.Collections.ArrayList
$voz.add_SpeakProgress({
  param($origem, $e)
  [void]$palavras.Add([ordered]@{ w = $e.Text; start = [math]::Round($e.AudioPosition.TotalSeconds, 3) })
})
$voz.Speak($texto)
$voz.SetOutputToNull()
$voz.Dispose()

$saida = [ordered]@{
  descricao = 'Fala sintética pt-BR (voz ' + $maria.VoiceInfo.Name + '). Tempos = início de cada palavra informado pelo sintetizador.'
  voz = $maria.VoiceInfo.Name
  texto = $texto
  palavras = $palavras
}
# UTF-8 sem BOM
[System.IO.File]::WriteAllText($json, ($saida | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("Gerado: {0} palavras" -f $palavras.Count)
