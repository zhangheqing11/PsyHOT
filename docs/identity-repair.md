# Material identity repair

`scripts/identity-repair.ts` is an administrator-only inspection command. It never starts a
collector, calls a provider/model, republishes an article, or sends a notification. The command
supports deterministic dry-runs and status inspection; its apply mode is retired. Approved legacy
repairs run through `scripts/repair-material-identities.ts --apply`.

## Candidate policy

The scanner groups only deterministic identities:

- an X/Twitter status id;
- an exact DOI extracted from the material URL; or
- the canonical URL produced by `identityKeyForUrl`.

Stored URL identities that retain a fragment remain fragment-specific. Titles, summaries, authors,
publication dates and model judgements are not similarity signals and can never create a candidate.
An operator must review the URL/DOI/X evidence in the dry-run report before applying a repair.

## Run and inspect

```bash
node --env-file=.env scripts/identity-repair.ts dry-run \
  --actor admin:42 --reason "review duplicate DOI candidates"

node --env-file=.env scripts/identity-repair.ts status --run 17

node --env-file=.env scripts/repair-material-identities.ts --apply \
  --actor admin:42 --reason "approved by incident ticket PSY-123"
```

`--actor` and `--reason` are required for a dry-run and for the legacy `--apply` script. Dry-run
writes only the run/checkpoint report and audit row. The legacy apply script first validates the
authenticated admin actor, then runs the historical consolidation and rebuild routines and records
their returned result in `audit_log` as `material.identity_repair.legacy_apply`. Running
`scripts/identity-repair.ts apply` fails with a message directing operators to that legacy script.

The legacy repair keeps the historical article rows and handles linked evidence, public projections,
selection state and rebuild checkpoints using the established repair implementation. Review the
dry-run evidence and the legacy script's audit row before running it; canonical deletion is outside
this command.
