# Material identity repair

`scripts/identity-repair.ts` is an administrator-only maintenance command. It never starts a
collector, calls a provider/model, republishes an article, or sends a notification.

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

node --env-file=.env scripts/identity-repair.ts apply \
  --actor admin:42 --reason "approved by incident ticket PSY-123"

node --env-file=.env scripts/identity-repair.ts status --run 17
```

`--actor` and `--reason` are required for both modes. Dry-run writes only the run/checkpoint report
and audit row. Apply re-scans each candidate under the collector's URL/DOI advisory locks, then
tombstones one candidate per transaction. A failed transaction rolls back that candidate; a completed
candidate is recorded in `material_identity_repair_checkpoints`, so rerunning the same apply run
can resume after an outage.

The duplicate article row is never deleted. It receives `articles.duplicate_of`, and the original id
remains addressable for old links and receipts. Every revision, translation, translation attempt,
analysis, discovery, grouping decision, fact/article membership, story signal, publication/search
projection, selected state/ledger row, regroup/abstract lookup, embedding and other article-linked
record stays attached to the duplicate id. Public readers can resolve the tombstone through the
existing duplicate-aware publication layer. Manual override conflicts are skipped for operator review.
Every run and candidate is recorded in the repair tables and `audit_log`. Rollback is a reviewed
`UPDATE articles SET duplicate_of = NULL` using the checkpoint and audit evidence; because no linked
rows move, that restores the pre-apply graph exactly. Canonical deletion is outside this command.
