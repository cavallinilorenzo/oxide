`jfk.pcm` is the 16 kHz mono signed little-endian 16-bit PCM audio extracted,
without resampling, from whisper.cpp v1.8.3 `samples/jfk.wav`:
https://github.com/ggml-org/whisper.cpp/blob/v1.8.3/samples/jfk.wav

The excerpt is John F. Kennedy's 1961 inaugural address, a US federal government
work in the public domain. whisper.cpp is distributed under MIT; the notice is
retained in `docs/licenses/whisper.txt`. This fixture is used by the opt-in
model smoke test and the explicit local performance check, without microphone
access. Bundled attribution is in `docs/licenses/dictation-fixture.txt`.

Source WAV SHA-256: `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`.
PCM SHA-256: `a29462b8ebd467318000e683b9117ade46230d3255ed2024e7db894abd9b38c9`.
