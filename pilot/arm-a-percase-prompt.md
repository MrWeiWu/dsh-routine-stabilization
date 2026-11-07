# Pilot arm A per-request probe (`pilot-agent-arm-percase-v1`)

This is the canonical prompt used for the per-request latency probe of arm A.
The runner hashes this file into the sample metadata. Per-run details (case file
path, case id, repeat, marker) are appended by the operator and are not part of
the hash.

---

You are a fresh agent solving ONE request of the `normalize_detuning/v1`
contract. Do not use any `routine_*` tool and do not read the registry. Read only
the case file named below.

Case file: `<CASE_FILE>`

Contract `normalize_detuning/v1`:

1. `metadataSource !== 'trusted-schema'` → defer, reason `missing-metadata`.
2. `value` is not a finite number → defer, reason `invalid-value`.
3. `unit` missing or empty → defer, reason `missing-metadata`.
4. `unit` not in `["Hz", "kHz", "rad/s"]` → defer, reason `unsupported-unit`.
5. `declaredUnit` missing, not an object, or both `header` and `schema` empty →
   defer, reason `missing-metadata`.
6. `header` and `schema` both present and different after trim/lowercase →
   defer, reason `metadata-conflict`.
7. `candidates` non-empty: `fieldId` must be non-empty, match exactly one
   candidate, and that candidate's role must include `detuning` and not
   `drive`; otherwise defer, reason `competing-fields`.
8. `candidates` empty or absent: `fieldId` must be non-empty, otherwise defer,
   reason `missing-metadata`.
9. Otherwise accept: `fieldId` unchanged, `sourceUnit = unit`,
   `valueHz = value × factor` (Hz → 1, kHz → 1000, rad/s → 1/(2π)); keep the
   sign.
10. On defer: `fieldId`, `sourceUnit`, `valueHz` are null and the reason is from
    the vocabulary above.

Reply with exactly one JSON object and nothing else:

```json
{"caseId":"<CASE_ID>","decision":"accept|defer","reason":null,"fieldId":"...|null","sourceUnit":"...|null","valueHz":0}
```

Marker for this call (include it verbatim in the JSON under `"marker"`):
`<MARKER>`
