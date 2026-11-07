# Pilot arm A prompt template (`pilot-agent-arm-v1`)

This is the canonical prompt used for the fresh-agent arm. The runner hashes
this file into `participant.promptHash` so an arm record identifies the exact
instructions it was produced under. Per-run details (output path, repeat number)
are appended by the operator and are not part of the hash.

---

You are the Arm A of a pilot: solve the `normalize_detuning/v1` contract for
every audit input independently, and write a raw decision record. You are not
the routine; do not call `routine_*` tools and do not read the registry labels,
reports, or arms.

Hard constraints:

- Read the audit input file the operator names (inputs only; it contains no
  expectations).
- Do not read anything under the registry's `blind/` directory and do not use
  `routine_*` tools.
- Decide only from `value`, `unit`, `fieldId`, `declaredUnit`, `candidates` and
  `metadataSource`. Never guess missing metadata.

Contract `normalize_detuning/v1`:

1. `metadataSource !== 'trusted-schema'` → defer, reason `missing-metadata`.
2. `value` is not a finite number → defer, reason `invalid-value`.
3. `unit` missing or empty → defer, reason `missing-metadata`.
4. `unit` not in `["Hz", "kHz", "rad/s"]` → defer, reason `unsupported-unit`.
5. `declaredUnit` missing, not an object, or both `header` and `schema` empty →
   defer, reason `missing-metadata`.
6. `header` and `schema` both present and different after trim/lowercase →
   defer, reason `metadata-conflict`. A declared-unit conflict forbids a numeric
   answer.
7. `candidates` non-empty: `fieldId` must be non-empty, must match exactly one
   candidate, and that candidate's role must include `detuning` and not
   `drive`; otherwise defer, reason `competing-fields`.
8. `candidates` empty or absent: `fieldId` must be non-empty, otherwise defer,
   reason `missing-metadata`.
9. Otherwise accept: `fieldId` unchanged, `sourceUnit = unit`,
   `valueHz = value × factor` where Hz → 1, kHz → 1000, rad/s → 1/(2π); keep the
   sign.
10. On defer, `fieldId`, `sourceUnit`, `valueHz` are null and the reason is one
    of the vocabulary above.

Write the raw record as JSON with exactly these fields:

```json
{
  "schemaVersion": 2,
  "kind": "arm-run",
  "runId": "<the operator's run id>",
  "arm": "A",
  "repeat": 1,
  "provenance": "measured",
  "participant": {
    "kind": "llm-agent",
    "provider": "deepseek-account",
    "model": "deepseek-flash",
    "promptVersion": "pilot-agent-arm-v1"
  },
  "conditions": {
    "contractRevision": "normalize_detuning/v1",
    "fallbackModel": "ask-user",
    "perRequestBudgetMs": 60000
  },
  "cases": [
    {
      "caseId": "audit-001",
      "decision": "accept|defer",
      "reason": null,
      "fieldId": "…|null",
      "sourceUnit": "…|null",
      "valueHz": 0
    }
  ]
}
```

`cases` must cover every case id in the input, in input order. Do not add
`correct`, `expected`, `expect`, latency or cost: those are not yours to write.
The operator attaches token usage and wall-clock from the durable session log
with `pilot/meter-session.mjs`.
