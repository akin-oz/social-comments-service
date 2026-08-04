# principal-review — seed tasks

Opening assignments per reviewer. These are the questions worth asking first, not the whole review — follow what you find. Each is a place where the design made a real choice that deserves to be defended or overturned.

## review-principal-architect

1. Delete each abstraction mentally and record what breaks: the provider registry, the `Database` port, the logger and metrics ports, `RequestContext`, `NormalizedComment`. Any that break nothing are the finding.
2. Judge whether `.ai/`, `specs/`, `docs/decisions/`, and the hooks are proportionate to a two-operation service, and whether the README justifies that machinery where a reader first meets it.
3. Three approved documents were corrected by implementation after the fact — ADR-0010, ADR-0012, and Spec-008 twice. Decide whether the gate is catching design errors before they land or mostly generating paperwork afterwards, and say which.
4. Assess whether the in-memory and PostgreSQL compositions are genuinely interchangeable or whether the in-memory path has quietly become the one that is actually exercised.
5. Ask what a second consumer, a webhook ingest, or a background sync would force. Which of those extends cleanly and which forces a rewrite?
6. Judge whether the layering survived the last four milestones or whether seams were added where convenient.

## review-reliability

1. Enumerate the failure windows in `replyToComment`: between claim and provider call, between provider call and upsert, between upsert and complete. For each, say what a crash leaves and whether the next request recovers.
2. Construct the interleaving for two concurrent requests with the same idempotency key and confirm the claim actually serialises them, including under the in-memory adapter.
3. Assess the timeout path specifically: the provider may have published. Judge whether marking the key terminal is the right call and whether the client can tell that outcome apart from a definite failure.
4. Judge the stored `provider_cursor` against Meta's documented guidance that cursors must not be stored, and say what the adapter must do when one is rejected.
5. Ask what happens when two comments share a `publishedAt` timestamp, and whether keyset pagination still terminates and covers.
6. Check whether every network call is bounded by a timeout, and whether the retry policy could produce a storm against a rate-limited provider.
7. Judge whether the log and the `reply_operations` record together let an operator reconstruct an ambiguous failure, or only observe that one happened.

## review-domain-model

1. Read `src/shared/types.ts` and `src/comments/contracts.ts` cold and write down what you think each type means before reading any document that explains it.
2. List what the model cannot represent: edits, deletions, moderation states, hidden comments, reactions, attachments, page-versus-person authors, threading beyond one level. For each, decide oversight or recorded scope choice.
3. Judge whether `NormalizedComment` is a domain concept or a persistence detail with a domain name, and whether `ReplyOperation` is an operation, an audit record, or a lock.
4. Assess the reply-as-comment-with-parent conflation against the capability matrix: Instagram silently reattaches replies, and X has no comment object at all.
5. Find every optional or nullable field and say which hides a real distinction, particularly "no parent" versus "parent unknown".
6. Name every illegal state the types still permit, and which of those a runtime validator is compensating for.

## review-api-contract

1. Write the pseudo-code a client must write to page through every comment on a post, and note each point where the contract left you guessing.
2. Write the pseudo-code a client must write to reply safely, including after a timeout, and judge whether the idempotency rules are discoverable from the contract alone.
3. Assess `IDEMPOTENCY_CONFLICT` carrying three distinct situations, and decide whether message-only distinction is sufficient for a client to act correctly.
4. Judge a page that returns fewer items than `limit` while reporting `hasMore: true`: is the loop a client should write obvious from the document?
5. Decide what a client can conclude about freshness, given the response is a snapshot that may lag the provider and the payload says nothing about it.
6. Read `docs/openapi.json` as a code generator would and judge whether the generated client would be usable.
7. Say what can be added to this API without breaking a client, and whether `/v2` is doing any real work.

## review-data-model

1. Tabulate every query in `src/repositories/postgres.ts` against the index that serves it, with the access pattern for each. Do this before judging anything.
2. Judge the identifier derivation, which is per platform, against the `(social_account_id, external_comment_id)` constraint, which is per social account. Say what breaks first if a provider repeats an identifier across accounts.
3. Assess each migration for lock behaviour on a populated table, and whether the ordering and recording would survive a real release.
4. Reason about the tables after a year of unbounded comment growth with no retention: which query degrades first, and at what size?
5. Check that every invariant the application assumes is enforced by a constraint, and name those that are not.
6. Judge `upsertMany`, which inserts row by row in a loop, against a set-based alternative, and say whether it matters at the page sizes this service uses.
7. Look for columns and tables nothing reads, and for anything the schema forces the application to do that the database should be doing.
