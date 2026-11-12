# The logo is a nautilus; the name stays ShellTeam

Date: 2026-11-12. Ticket: SHE-172.

## Context

The logo since July 2026 was a gold scallop fan ("petal mark"). Seb raised that it
"feels a bit too close to Shell the oil company". A gold scallop is their picture.
The question of the name came up at the same time.

## Decisions

1. **The mark is a nautilus shell**, flat amber, no gradient. A full mark with four
   chambers (`frontend/static/logo.svg`) and a small mark with three
   (`favicon.svg` and the raster icons). Both come from `scripts/brand/nautilus.py`.
2. **The name stays ShellTeam.**
3. **Amber stays** as the brand colour.

## Why a nautilus

Seb rejected three rounds first: abstract marks (an angular S, a `~/` home path,
a boat with three heads). The S collided with Sublime Text's orange S; `~/` was
"very technical and cryptic"; the boat read as a smiling face close to Amazon's.
He then asked for research on what makes logos memorable before another round.

What the research said (sources in `~/reports/shellteam-logo-round7.html`):

- Recognisable real objects are learned faster than abstract shapes (Henderson and Cote 1998).
- Recall is better when the picture repeats the name.
- Descriptive logos help unknown brands most (Luffarelli et al. 2019, 597 logos).
- Simple but moderately detailed; round shapes read as warm (Jiang et al. 2016).
- Colour is the best-remembered attribute, so the colour should not change.

A nautilus is a shell (repeats the name), a spiral and not Shell's fan, and it
keeps what Seb liked in the scallop: separate chambers with even gaps. It grows by
adding a chamber and keeping the old ones, which fits one person running many
projects.

Look-alike check, by eye against about twenty logos from the Simple Icons set:
Shell (fan, straight ribs), Chrome and OBS Studio (circles cut in three), Debian
(thin swirl). None is a twin. This was not a trademark search, and nautilus
shells are used by companies outside that set (for example Nautilus fitness).

## Why the name stays

About 3,900 `.com` names were checked; no free one was better. The most
serious alternative was a free name close to a sibling product's. Against a rename: the
name appears about 2,200 times in 351 files, including the folder every install
creates, the service names and box addresses, and the sibling product has
search presence but no audience to lend. `shellteam.com` is held by a reseller at $1,595; not bought.

## What would make us revisit

- A trademark complaint, or evidence that people still read the mark as Shell.
- Ten paying customers who are mostly non-technical: reopen the name then.
- A human designer redrawing the nautilus is welcome; the idea is what was decided.

## Consequences

- Any new placement uses `logo.svg` (20 px and up) or `favicon.svg` (smaller).
- Change the mark only through `scripts/brand/nautilus.py`, then bump the `?v=`
  on the icon links.
- Not yet redone: the landing page's `og.png` and the product screenshots and
  videos, which still show the scallop.
