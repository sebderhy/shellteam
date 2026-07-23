---
name: stt
description: Transcribe audio files to text. Supports mp3, wav, m4a, ogg, webm, mp4, flac. Returns accurate transcription with language detection.
---

Transcribe an audio file to text.

## Steps

1. Upload the audio file to the proxy endpoint:

```bash
curl -s -X POST {api_base}/internal/ai/stt \
  -H "Authorization: Bearer $SHELLTEAM_AI_TOKEN" \
  -H "X-Shellteam-User-Id: $SHELLTEAM_USER_ID" \
  -F "file=@/path/to/audio.mp3"
```

2. The response is JSON: `{"text": "transcribed text here", "language_code": "en"}`

3. Display the transcript text to the user.

## Supported Formats

mp3, wav, m4a, ogg, webm, mp4, flac
