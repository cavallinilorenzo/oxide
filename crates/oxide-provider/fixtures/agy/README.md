# agy fixtures

Replayed by `fake_agy.py`. `init.json` and `turn_error.jsonl` were recorded from the real
`agy` 1.4.5 (`-p ... --output-format stream-json`; the account was out of quota, hence the
error turn). `turn_response.jsonl` and `turn_tools.jsonl` follow the documented stream schema
(https://antigravity.google/docs/cli/headless) because no successful turn could be recorded;
re-record it once quota allows.
