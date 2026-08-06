# Provider capability matrix

No live provider adapter is selected. This document records what each platform's **official documentation** states about comment retrieval and replies, so the provider abstraction is justified by evidence rather than by assertion.

Everything below was read from vendor documentation on 4 August 2026 and is cited at the end. **None of it is verified by integration testing**, and several entries read "not stated" because the vendor genuinely does not document the behaviour. Where that is so, it is recorded as unknown rather than filled in with a plausible guess, because a capability matrix that quietly guesses is worse than none.

## Comment capabilities

| Platform           | List comments on your own post                                 | Reply to a comment                                             | Reply nesting                                                                               | Pagination                                     |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Facebook** Pages | `GET /{page-id}_{post-id}/comments`                            | Documented inconsistently — see below                          | Not stated                                                                                  | Opaque cursors (`after`/`before`), or `since`  |
| **Instagram**      | `GET /{ig-media-id}/comments`, max 50 per query                | `POST /{ig-comment-id}/replies`                                | **One level, enforced.** A reply to a reply is silently reattached to the top-level comment | Opaque cursors                                 |
| **LinkedIn**       | `GET /rest/socialActions/{urn}/comments`                       | `POST /rest/socialActions/{urn}/comments` with `parentComment` | Two levels implied by the data model; depth not stated                                      | Offset (`start`/`count`) — no cursor           |
| **X**              | No such endpoint. Search `conversation_id:{id}`, last 7 days   | `POST /2/tweets` with `reply.in_reply_to_tweet_id`             | **Arbitrarily deep**                                                                        | Opaque tokens (`next_token`)                   |
| **YouTube**        | `commentThreads.list` for threads, `comments.list` for replies | `comments.insert` with `snippet.parentId`                      | One level — "replies only for top-level comments"                                           | Opaque page tokens (`pageToken`), max 100/page |

| Platform      | Comment identifiers                                                                    | Access reality                                                                       | Adapter     |
| ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------- |
| **Facebook**  | Format and uniqueness not stated. IDs withheld entirely without the `MODERATE` task    | App Review, Business Verification, Page access token                                 | Planned     |
| **Instagram** | Not stated. `legacy_instagram_comment_id` shows one comment can carry several ID forms | Professional accounts only; App Review only for multi-business providers             | Planned     |
| **LinkedIn**  | `urn:li:comment:(thread,id)` — docs warn the URN is **"not a reliable identifier"**    | Vetted partners only; personal email addresses are rejected; 500 calls/day initially | Planned     |
| **X**         | **Globally unique** 64-bit snowflakes — the only platform that documents this          | Pay-per-use; ~$0.005 per post read, $0.015 per reply written                         | Planned     |
| **YouTube**   | "Uniquely identify the comment" — scope of that uniqueness not stated                  | OAuth `youtube.force-ssl`; 10,000 units/day, a reply costs 50                        | Planned     |
| **Fixture**   | Deterministic, unique per post                                                         | None — in-process                                                                    | Implemented |

## What the research changes

Four findings bear directly on decisions already made. Two support them; two do not, and are recorded here rather than quietly absorbed.

**The abstraction is justified — the platforms differ more than expected.** Reply nesting alone ranges from one level enforced server-side (Instagram, YouTube) through two levels (LinkedIn) to unbounded (X). X has no comment object at all: a comment is a Post, and there is no endpoint that lists replies to a post — retrieval is a _search_ over the last seven days, which is a different reliability and cost profile from a resource read. A design that assumed every platform exposes "the comments on a post" would have been wrong about the largest difference between them.

**One level is a normalisation, and it is lossy.** Instagram and YouTube enforce a single level themselves, and Instagram goes further by silently reattaching a reply-to-a-reply to the top-level comment, meaning the parent that comes back may not be the parent that was requested. X threads arbitrarily deep, and Facebook states no limit. [ADR-0014](decisions/0014-reply-depth.md) makes the choice explicit and enforces it: a reply to a reply is refused with `REPLY_DEPTH_EXCEEDED` rather than quietly building a tree the model cannot express. What is lost is real — on X, and potentially on Facebook and LinkedIn, a deeper conversation exists that this API does not expose. Instagram's silent reattachment remains unmodelled: the resolved parent can differ from the requested one and the contract has no field to say so.

**ADR-0010's uniqueness assumption was unsupported by four of the five vendors, and has been replaced.** Internal comment identity was derived from `(platform, externalId)`, which assumes provider comment identifiers are unique within a platform. Only X documents that its IDs are globally unique. YouTube, Facebook, and Instagram do not state their uniqueness scope at all, and LinkedIn explicitly warns that the composite URN it returns "is not a reliable identifier", naming `(object, id)` as the dependable key. [ADR-0013](decisions/0013-assigned-comment-identity.md) supersedes ADR-0010: identity is now assigned by persistence and deduplication keys on `(social_account_id, external_comment_id)`, which is scoped per connected account and does not depend on any vendor's uniqueness guarantee.

**Spec-013 persisted provider cursors, which Meta's documentation tells you not to do.** Snapshot completeness stores the provider's continuation token on the post. Facebook's pagination guide is blunt: _"Don't store cursors. Cursors can quickly become invalid if items are added or deleted."_ Instagram repeats the guidance. [Spec-014](../specs/014-read-path-completeness.md) resolved this by keeping the stored cursor but treating it as best-effort: a rejected continuation restarts the stream rather than failing the read, which is safe because re-reading deduplicates on `(social_account_id, external_comment_id)`. The public cursor no longer carries a provider token at all.

Two smaller traps worth carrying into any adapter. Facebook's comments edge defaults to `filter=toplevel`, so a naive read silently omits every reply, and its `live_filter` defaults to dropping low-quality comments. YouTube's comment threads return only a _subset_ of replies inline; the count must be compared against `totalReplyCount` and the remainder fetched separately.

## Why no live adapter is selected

The access requirements are not incidental to the design; they are the reason a fixture provider stands in.

LinkedIn's Community Management API is available "only to registered legal organizations for commercial use cases", rejects personal email addresses during vetting, requires a LinkedIn Page super-admin to verify the application, and grants 500 calls per day until a built integration passes a screencast review. X moved to pay-per-use pricing in February 2026 and its current documentation describes no free tier. Facebook and Instagram require App Review, and Facebook additionally requires Business Verification for advanced access.

Selecting one platform would have meant either fabricating credentials the assignment cannot supply, or building against whichever vendor happened to be easiest and calling that a multi-platform abstraction. The fixture provider implements the same `ProviderClient` contract a real adapter would, so the boundary is exercised without pretending to an integration that does not exist.

## Adapter onboarding

1. Confirm the provider's capabilities against its current documentation and record any difference in this matrix.
2. Implement a `ProviderClient` in `src/platforms/` that owns SDK types and external identifiers.
3. Wrap it with `AdaptiveProviderAdapter` and map every external record into the normalized `Comment` contract.
4. Resolve the credential from the `SocialConnection` supplied on each call (Spec-016). One adapter instance serves every tenant, so the authorised connection arrives per call rather than per instance, and the adapter exchanges the `credentialReference` for a token through the platform infrastructure that owns it (A-002). The reference is never a secret and must not enter a log or a response.
5. Register the adapter in composition code and add deterministic mapping and failure tests.
6. Document pagination, timestamps, rate limits, timeout behavior, and credential references before enabling production traffic.

A capability the provider lacks is a typed `UNSUPPORTED_CAPABILITY` error, never a silent emulation: the registry rejects an unconfigured platform, and the adapter's declared capability set is checked before any write reaches the provider.

## Sources

Facebook: [comments edge](https://developers.facebook.com/docs/graph-api/reference/page-post/comments/), [pagination](https://developers.facebook.com/docs/graph-api/results), [rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/), [permissions](https://developers.facebook.com/docs/permissions/).

Instagram: [comment moderation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation), [IG Comment replies](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies/), [IG Media comments](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/).

LinkedIn: [Comments API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api), [app review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review), [rate limits](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits), [pagination](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/pagination).

X: [conversation ID](https://docs.x.com/x-api/fundamentals/conversation-id), [recent search](https://docs.x.com/x-api/posts/search-recent-posts), [post creation](https://docs.x.com/x-api/posts/creation-of-a-post), [IDs](https://docs.x.com/fundamentals/x-ids), [pricing](https://docs.x.com/x-api/getting-started/pricing).

YouTube: [commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list), [comments.insert](https://developers.google.com/youtube/v3/docs/comments/insert), [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost), [implementation guide](https://developers.google.com/youtube/v3/guides/implementation/comments).
