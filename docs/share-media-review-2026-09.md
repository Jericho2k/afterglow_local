# Share media review: what exists, and what does not

_September 2026 — written while closing the safe-media workflow._

## The question that had to be answered first

`share_media_status` has four values (`unreviewed | safe | adult | rejected`)
and only `safe` lets a creator's artwork appear in an external link preview.
Nothing in the product wrote `safe`. That is not a bug in one function — it is a
missing workflow, and the sprint asked whether this repository or deployment
already has an image-moderation capability that could fill it before any new
external dependency is introduced.

**It does not: there is no image-moderation capability in this repository or
this deployment.** The finding, stated plainly so it is not rediscovered:

* **No image classifier, of any kind.** The inference providers configured here
  — DeepSeek and OpenRouter, in `src/lib/deepseek.ts`, `src/lib/openrouter.ts`
  and `src/lib/provider.ts` — are used exclusively for text chat completions.
  There is no vision model, no moderation endpoint, and no environment variable
  for one anywhere in the codebase.
* **No storage-side scanning.** Supabase Storage holds the images
  (`character-avatars`, `profile-avatars`, `world-covers`). The buckets and
  their policies decide who may write and read an object; nothing inspects one.
* **No third-party service.** Nothing in `package.json`, the Dockerfile or the
  Railway configuration talks to a classification API.
* **What DOES exist is human moderation.** `moderationAdminRequired` in
  `src/lib/session.ts` gates a moderator surface; `character_reports` and the
  immutable `moderation_actions` log are already the product's record of
  moderation decisions; `AdminReports` is already the queue a person works.

So the choice was between adding a vision provider — a new dependency, a
per-image bill, a data-processing relationship, and a decision about what a
classifier's answer even means for "is this suitable as an unrestricted preview
of an erotic story" — and using the review capability that already exists. The
first is a product decision with a cost attached and is not something to slip
into a fix. This release does the second.

## What was built

**Creator side — nomination.** `ShareImageField` in
`src/components/studio/MediaFields.tsx`, shown in the Publish step of a public
creation. A creator chooses which image is put forward: their cover, their
desktop banner, or another image uploaded for this purpose alone. It writes
`share_image_path` / `share_image_url` and nothing else. The copy states, in the
creator's own terms, that Afterglow decides whether the image may be used
outside the site and that changing the image sends it back for review.

**Platform side — classification.** `/api/admin/share-media` (GET queue, POST
decision), behind `moderationAdminRequired`, with the moderator surface at
`src/components/admin/ShareMediaReview.tsx`. A decision writes
`share_media_status` and inserts a `classify_share_media` row into
`moderation_actions`, which is insert-only, so an approval has a moderator and a
timestamp attached to it forever. The queue is limited to PUBLIC creations whose
nominated image is unclassified: a private creation has no external preview to
authorise, and asking a person to look at pictures for no reason is how a review
queue stops being worked.

**The invariant that makes an approval mean something.** A classification
approves an IMAGE, not a creation. Two halves enforce that:

* The character update resets `share_media_status` to `unreviewed` whenever the
  nominated image changes, in the same statement that writes the change (see
  `src/app/api/characters/[id]/route.ts`). Without it, a creator could have
  their cover approved and then swap in anything at all — the row would still
  say `safe`.
* A moderator's decision names the image it is about, and the server refuses it
  with a 409 if the creator has re-nominated in the meantime. An approval always
  means "somebody looked at this file".

The comparison is of the ONE image that would actually be published — a
dedicated share image, then a share URL, then the cover, which is the order
`nominatedMedia` resolves. Re-cropping a cover that nothing nominates therefore
does not cost a creator the approval of their separate share image.

**What did not change.** `share_media_status` is still absent from
`characterSchema`: no creation payload can set it, from the studio, the import
path or a restored backup. `content_mode = 'clean'` is emphatically NOT treated
as safe artwork — the two answer different questions, and conflating them is the
mistake content modes exist to end. The Clean / Adult-capable / Adult-focused
access rules are untouched.

> **Superseded in part, later in September 2026.** The sentence above about `clean` still
> holds for what `shareMedia` releases — a classification is still a
> classification, and nothing here treats a content mode as one. But the
> question a share card asks turned out to be a different one: an open
> creation's artwork is on a page anonymous readers already see, so the card now
> composites it without waiting for a review, while a moderator's `adult` or
> `rejected` still withholds it and an adult-focused creation still gets nothing
> but classified media. See docs/share-card-artwork-2026-09.md.

## While the queue is empty

The branded fallback is not a placeholder to be tolerated until review catches
up. `/api/og/card` composes a Creation-specific card — safe title, creator
handle, creation type, the creator's outward-facing line, the creation's accent
— so an unreviewed creation still gets a preview that says which creation it is.
Approval upgrades that card by compositing the artwork INTO it; it is not the
difference between a preview and no preview.

**What we learned by shipping it:** in practice the queue is not merely empty,
it is empty for every creation at once, so "an unreviewed creation still gets a
preview that says which creation it is" was true and the preview was still the
same artless card for the whole catalogue. The fix was not to work the queue
harder — it was to notice that the rule was answering the wrong question for two
of the three modes. Again: docs/share-card-artwork-2026-09.md.

## If an automated classifier is added later

The shape to keep: it writes `share_media_status` through the same path a
moderator does, records its decision in `moderation_actions` with its own
identity, and is subject to the same re-nomination reset. It should narrow the
human queue rather than replace it — a classifier can answer "does this contain
explicit nudity" and cannot answer "is this suitable as an unrestricted preview
of an erotic story on somebody's work machine", which is the question this
status actually asks.
