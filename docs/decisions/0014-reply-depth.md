---
adr: 0014
title: Normalise reply depth to one level, and enforce it
status: accepted
---

# ADR-0014: Normalise reply depth to one level, and enforce it

## Context

Assumption A-005 states that replies are one level deep. Reading the vendor documentation showed that is true of some platforms and false of others:

- **Instagram and YouTube** enforce one level themselves. Instagram goes further and silently reattaches a reply-to-a-reply to the top-level comment, so the parent that comes back is not always the parent that was requested.
- **LinkedIn** implies two levels in its data model, though it does not state a depth limit.
- **Facebook** states no limit at all.
- **X** has no comment object. A reply is a Post, threads nest arbitrarily deep, and the flat `conversation_id` gives the thread while `referenced_tweets` gives the parent.

So A-005 is not a fact about the domain. It is a normalisation choice, and it is currently unstated as one.

Worse, nothing enforces it. Neither the service, the validator, nor the fixture rejects a reply to a reply, so the system every reviewer actually runs can build the arbitrarily deep tree the documentation says only X exhibits. An assumption that no code checks is a comment, not an invariant.

## Decision

**One level is a deliberate normalisation, enforced at the application boundary, and A-005 is reworded to say so.**

1. `replyToComment` rejects a parent that is itself a reply, with a typed error rather than a silent acceptance. The depth check belongs in the application layer, because it is a property of this service's model rather than of any provider.
2. A-005 is rewritten from "replies are one level deep" — which reads as a claim about platforms — to a statement that this service exposes one level, that platforms differ beneath it, and that a deeper thread is flattened rather than represented.
3. The normalisation's loss is recorded where the capability matrix already records the platform differences: on X, and potentially on Facebook and LinkedIn, a deeper conversation exists that this API does not expose.
4. Instagram's silent reattachment is treated as a distinct problem, not solved here. The resolved parent can differ from the requested one, and the model has no field to say so. That belongs with the domain-model work.

## Consequences

The invariant becomes real: a client cannot build a structure the model cannot express, and the failure is a clear typed error at the moment of the attempt rather than a shape that surfaces later.

The cost is that a genuinely threaded conversation on X is flattened, and this service cannot represent it. For a scheduling product replying on a customer's behalf, one level is very likely the right product scope — but it should be a decision someone made, not a side effect of what was easy.

Enforcing depth requires knowing whether the parent is itself a reply, which the stored comment already tells us. No extra round trip.

## Alternatives considered

**Support arbitrary depth.** Honest to X and Facebook, and the domain model could carry it. Rejected as scope the assignment does not ask for: the brief is retrieve and reply, and a threading model is a product decision with API, storage, and UI consequences well beyond it.

**Keep A-005 as an assumption and continue not enforcing it.** Rejected because an unenforced assumption is precisely what this repository has been finding and correcting: the documentation says one thing, the code permits another, and nobody notices until something depends on it.

**Enforce depth in the validator rather than the service.** Rejected because the check needs the stored parent, which the validator has no access to; a validator that cannot see the data it validates would have to be given a repository, which inverts the dependency.
