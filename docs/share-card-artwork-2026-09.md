# Share cards: whose artwork, and whose face

_September 2026 — written while polishing the composed OG card._

## What shipped, and what it actually did

The composed link-preview card landed a few days ago and the composition is
good: dark cinematic surface, accent edge, the wordmark, the creation type and
the creator's handle, a large title, the creator's outward-facing line, an
understated 18+ marker where one belongs. It replaced a route that drew the same
logo for every creation in the catalogue.

Then it drew almost the same card for every creation in the catalogue.

The reason is not a bug in the composition. Artwork appeared only where
`share_media_status = 'safe'`, every creation is born `unreviewed`, nothing in
this deployment classifies automatically (docs/share-media-review-2026-09.md
establishes that plainly), and a moderator queue is a queue. So the artless
fallback was not the exception it was designed to be — it was the entire
catalogue, and the difference between a clean scenario and a clean cast was two
lines of type on an otherwise identical panel.

## The question the rule was answering

`shareMedia` asks: **may this image leave Afterglow?** For an adult-focused
creation that is exactly the right question and the answer must stay
conservative. A stranger who clicks a shared link may not read that page at all;
nothing of its own may stand in for it outside, unless a person has looked at
the specific file and said so.

For a clean or adult-capable creation the same question protects nothing. The
artwork is already on a page that anonymous visitors and search engines read —
one click behind the very link the card is previewing. Withholding it from the
preview did not keep an image private. It made the preview useless.

So this release adds the other question, and asks it only where it applies:

**`openCardMedia` (src/lib/content-mode.ts): is this image already on a page a
stranger may open?**

Three things still hold inside it, and each is stated rather than assumed:

* An adult-focused creation is refused outright, by mode, before anything else
  is considered.
* A moderator's decision still binds. `adult` and `rejected` withhold the image
  exactly as they do for `shareMedia`. **`unreviewed` is the only status treated
  differently, and only for a page that is already public.** That is the seam an
  automated classifier would tighten later, and it needs no caller to change.
* Nomination still decides WHICH image, in the single order `nominatedMedia`
  defines: a dedicated share image, then a share URL, then the cover. A creator
  who chose a quieter picture for sharing gets that one.

## Why an adult-focused creation cannot reach the new path by mistake

Two independent guards, in two languages, either of which is sufficient:

1. **The SQL.** `public_creation_safe_landing` (migration 0039) gains four new
   columns — `open_share_image_path`, `open_share_image_url`,
   `open_avatar_path`, `open_avatar_url` — and each is wrapped in
   `CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE … END`, alongside an
   `art_presentation` that is blanked to `'{}'` the same way. A gated row
   *cannot express* its cover through them. This is the technique
   `public_creator_creations` already uses for the anonymous creator shelf.

2. **The rule.** `openCardMedia` refuses `adult_focused` before it looks at
   anything, so a database that predates 0039 is still safe.

The **classified** columns — `share_image_path`, `share_image_url`,
`avatar_path`, `avatar_url`, `share_media_status` — are untouched and still
travel for every mode. They are the only door an adult-focused creation has, and
it still requires `safe`. Two sets of columns because there are two questions,
and one of them must keep answering "no" for a gated creation whatever happens
to the other.

**Adult-capable is not quietly promoted to 18+.** Its page is public, so its card
carries its artwork exactly as a clean creation's does, and it carries no badge.
Media safety and roleplay capability stay separate questions — the separation
content modes exist to make. If automated moderation later decides that an
adult-capable cover deserves a stricter default, the place to say so is
`openCardMedia`, in one line, without any of this moving.

## Framing

The card used to crop every image at a hardcoded `50% 32%`. That is a reasonable
guess for a portrait character sheet and it is only a guess — and the product
already has the creator's answer, because `art_presentation` is exactly "here is
the part of this picture that must survive every crop". A creator who set a focal
point in the studio and then watched the share card behead their artwork would
conclude, correctly, that the control does not work where it matters most.

`art_presentation` now travels on the safe landing for the open modes, and the
model resolves `artworkPosition` through the same `objectPosition` helper every
other surface uses, at `16:9`. `50% 32%` survives as `defaultArtworkPosition` —
the answer for a creator who has said nothing, and nothing more.

Framing applies to the creation's **primary artwork only**. A separately
nominated share image is a different picture, and a focal point chosen for the
cover would crop it somewhere arbitrary.

## The corner: a creator, not an initial

The fallback card drew a large boxed letter taken from the creation's title. It
told a reader nothing they could not read six inches to its left, it looked like
a placeholder, and a gated creation could not have one at all — the only title to
derive it from is one that may not leave.

It is gone as a concept. `monogram` and `monogramFor` are deleted rather than
left as a dead abstraction, and tests/og-card.test.ts asserts that no initial is
derived or rendered anywhere in the card's three files.

In its place: **the creator's public profile picture**, bottom right, circular,
inside a ring in the creation's accent. It is public identity — the same picture
their profile page and every creation page already show — so it appears in every
mode including the gated one: the creation is 18+, the person who made it is not.

The safe landing gains exactly one field for this, `creator_avatar_path`, from a
join that already required a public handle. Not a bio, not a cover, not a
follower count, not an id. A test names the three permitted `creator_` columns so
that widening the narrowest public shape in the product has to be deliberate.

A creator with no picture gets **nothing** there. The letter is not a fallback to
return to; the composition reads as one column of copy, which it does well.

## The scrim, retuned

Worth recording because it is the kind of change that looks arbitrary later. The
original gradient was built when artwork was the rare case, so it was dense
enough to guarantee readability over a white photograph. With artwork as the
ordinary case, that same density flattened every dark upload into the branded
panel this card exists to stop being.

The horizontal scrim now clears to nothing by 90% across, the upward wash is
lighter over artwork than over the empty composition, and the copy carries a soft
halo (`textShadow`) only where there is a photograph to lose it against. The
halo is what holds the tagline — the smallest, faintest line, and the first to
disappear — over a bright crop, and it costs the picture almost nothing.

`OG_CARD_PREVIEW_DIR=/tmp/og npx vitest run tests/og-card-render.test.tsx` writes
every shape at 1200×630 and at 400×210, which is roughly what Discord and
Telegram paint. The thumbnail is the same PNG painted small, which is what those
clients do — not a second composition at a smaller size.

## The half that did not work: image formats

_Added after the release, because the section above turned out to be a claim
rather than a description._

0039 shipped, the card composed correctly, the creator's profile picture drew —
and public creations still shared cards with no artwork on them. Every layer
this document describes was doing its job. The failure was one step further
down, in the only place nobody had looked:

**The renderer behind `next/og` draws PNG and JPEG. `uploadImage` accepts PNG,
JPEG, WebP and GIF, and the storage buckets allow all four.**

So a creator whose cover was a WebP got a card with everything on it except the
picture. What made it survive a release is the failure mode, not the gap:
Satori does not throw on an image it cannot use, and it does not warn. It omits
the `<img>` and renders the rest of the composition perfectly. The output is a
valid 200, a valid PNG, and a card that is byte-for-byte what a creation with no
artwork at all would produce. From the outside there is no way to tell "the
artwork was dropped" from "there is no artwork" from "this creation is gated" —
which is exactly the deduction the previous round of debugging tried to make.

(A `data:` WebP is worse in a different way: that one throws, from inside the
response stream, after `new ImageResponse(...)` has already returned — so the
route's own try/catch never sees it either.)

`tests/og-artwork.test.tsx` pins all of this against the bundled renderer by
rendering the same neutral frame twice and comparing bytes, which is the only
way to distinguish "drew it" from "quietly skipped it". If a Next upgrade
changes what Satori can draw, that test fails and the supported list moves
deliberately.

### What changed

**Nothing is silent any more.** `src/lib/og-artwork.ts` fetches the picture
before the composition is built, identifies it from its magic bytes — not its
suffix, not its `Content-Type` — and returns one of a small set of named
outcomes: `absent`, `blocked_scheme`, `unreachable`, `no_response`, `oversized`,
`unsupported_format`, `ready`. Only `ready` draws.

* The bytes are handed to the renderer **inline**, so the check is binding: it
  cannot re-fetch its way into something else, and nothing unidentified can
  reach the code path that throws mid-stream.
* `/api/og/card` puts the outcome in `X-Og-Artwork` (and `X-Og-Artwork-Format`,
  and `X-Og-Avatar`). A production card can now be diagnosed with `curl -I`.
* `/api/admin/og-card-diagnostics?id=…`, behind the existing moderator gate,
  walks the whole chain for one creation — the row's columns, the `open_*`
  columns the SQL function returned, the view model, the card model, the render
  outcome — so "where did the artwork go" is a request rather than a deduction.
  It returns byte counts and media types, never image bytes.

**New uploads cannot land in this state.** `uploadImage(file, bucket, {
renderable: true })` re-encodes anything the card cannot draw, in the browser,
using the decoder it already has: PNG when the picture has transparency, JPEG
when it does not, longest edge capped at 2048. An animated GIF becomes its first
frame, which is what every crop in the product already shows. The file picker's
accept list is unchanged — a creator should not have to know any of this. The
flag is set on the four images that can become card artwork (cover, banner,
nominated share image, imported card art) plus the profile picture; gallery and
rich-content images are stored exactly as uploaded.

**Existing WebP and GIF artwork is named, not hidden.** The studio's share-image
field reads the stored object's suffix — which `avatarObjectPath` wrote, so it
is a fact for our own storage — and tells the creator that link previews cannot
draw that format and that re-uploading fixes it. It stays silent for anything it
cannot identify, such as an imported card's external URL.

### Why not transcode server-side

It would need an image codec in the runtime (`sharp` or equivalent), which is a
dependency, a build concern and a per-render cost, to solve a problem the
browser already has a decoder for. Converting at the door is cheaper, happens
once per upload instead of once per crawl, and leaves the stored asset and the
card showing the same picture. If a server-side transcode is ever wanted — to
repair the covers uploaded before this — it should write a new object and update
the row, not convert on the fly.

## If 0039 is not applied

Worth stating because the failure is silent and the symptom is confusing. The
new columns are read by name; a database still holding 0038's function returns
none of them, so `openCardMedia` sees empty strings, resolves to a fallback, and
the card is exactly the card that shipped last week. Nothing errors, nothing
logs, and every creation quietly keeps the artless preview.

**The same trap already exists one migration back, and is worth checking on any
deployment where framing looks like it did not save.** `ensureSchema` in
src/lib/db.ts adds `art_presentation`, `banner_path` and `banner_url` as
COLUMNS, because a plain PostgreSQL database has to be able to run the same code
paths. It does not define the public functions — those live only in
supabase/migrations. So a deployment running the application without having
applied 0037 has a working signed-in page (which reads the columns directly) and
an anonymous page still built from 0036's projection, which has no framing
columns in its result type at all. A creator setting a focal point would see it
take effect while signed in and see "the old presentation" the moment they
opened their own link logged out or checked a shared preview.

tests/helpers/public-functions.ts pins which migration currently defines each
public function, and the anonymous tests run those definitions verbatim — so the
suite now fails if a function's projection stops carrying something the view
model reads. It cannot tell you what a particular database has had applied to
it; only `\df public_creation_safe_landing` can do that.

## What this release deliberately does not do

* **No automated image moderation.** Not added, not stubbed, not depended on.
  `share_media_status` means exactly what it meant.
* **No new discovery category.** Adult-capable is not 18+ here or anywhere else.
* **No widening of the anonymous page.** `public_creation_page` and
  `public_creation_card` are unchanged and still refuse an adult-focused
  creation outright.
