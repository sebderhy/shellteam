"""The morning report of one night of memory (K21): per level, in plain words.

One self-contained page in ~/reports. A second run on the same day gets its
own file; the first report is never written over.
"""

from __future__ import annotations

import html
import logging
from datetime import datetime
from pathlib import Path

from api.services.memory_exam_report import CSS, _font_css

log = logging.getLogger("shellteam.memory")

PAGE_CSS = """
.alert{border:1px solid var(--wrong);border-left:6px solid var(--wrong);background:var(--card);
 padding:12px 16px;margin:22px 0 0;font-size:15px;max-width:52em}
.alert b{color:var(--wrong)}
h3{margin:30px 0 4px;font-size:15px;font-family:"Libre Franklin",system-ui,sans-serif;
 letter-spacing:.1em;text-transform:uppercase;color:var(--soft)}
h3 span{color:var(--ink)}
ul.facts{list-style:none;margin:0;padding:0;max-width:60em}
ul.facts li{padding:9px 0;border-top:1px dotted var(--rule);font-size:15px}
ul.facts .was{display:block;color:var(--soft);text-decoration:line-through;font-size:14px}
ul.facts .why{display:block;color:var(--soft);font-size:13px;margin-top:2px}
.tag{font-size:11px;letter-spacing:.1em;text-transform:uppercase;border:1.5px solid var(--ink);
 padding:0 6px;margin-left:8px;white-space:nowrap}
.quiet{color:var(--soft);font-size:15px;margin:10px 0 0}
code{font-family:"Spline Sans Mono",ui-monospace,monospace;font-size:13px;background:var(--card);
 border:1px solid var(--rule);padding:1px 5px;word-break:break-all}
"""

# What happened to facts, in the order the report shows it: key, heading.
GROUPS = (
    ("added", "Added"), ("replaced", "Replaced"), ("confirmed", "Confirmed"),
    ("merged", "Merged"), ("moved", "Moved"), ("retired", "Retired"),
    ("card_on", "Put on the card"), ("card_off", "Taken off the card"),
    ("expired", "Left the card: not confirmed for 30 days"),
    ("taken_off_to_fit", "Left the card: it was over its limit"),
    ("not_kept", "Not kept"),
)
COUNTED = (("added", "added"), ("replaced", "replaced"), ("confirmed", "confirmed"),
           ("merged", "merged"), ("moved", "moved"), ("retired", "retired"))


def _e(text: object) -> str:
    return html.escape(str(text))


def _name(level: str) -> str:
    return "The owner" if level == "owner" else f"~/{level}"


def in_words(summary: dict) -> str:
    """The night in one sentence, the way the PRD's example reads."""
    parts = []
    for level, info in sorted(summary["levels"].items()):
        counts = [f"{len(info[key])} {word}" for key, word in COUNTED if info[key]]
        if info["untouched"]:
            counts.append("left untouched")
        if (info.get("split") or {}).get("folder"):
            counts.append(f"~/{info['split']['folder']} got its own card")
        if counts:
            parts.append(f"{_name(level)}: {', '.join(counts)}")
    not_kept = sum(len(info["not_kept"]) for info in summary["levels"].values())
    if not_kept:
        parts.append(f"{not_kept} not kept")
    parts += [f"{s} not read" for s in summary["not_read"]["sources"]]
    parts.append(_duration(summary.get("seconds", 0)))
    return "; ".join(parts) + "."


def _duration(seconds: int) -> str:
    return f"{seconds} seconds" if seconds < 120 else f"{seconds // 60} min {seconds % 60} s"


def _item(key: str, item: object) -> str:
    if isinstance(item, str):
        return f"<li>{_e(item)}</li>"
    text = _e(item.get("text", ""))
    if key == "added":
        return f'<li>{text}<span class="tag">{"card" if item.get("card") else "record"}</span></li>'
    if key == "replaced":
        return f'<li><span class="was">{_e(item["old"])}</span>{text}</li>'
    if key == "merged":
        others = "".join(f'<span class="was">{_e(o)}</span>' for o in item["others"])
        return f"<li>{others}{text}</li>"
    if key == "moved":
        return f'<li>{text}<span class="why">now under {_e(item["to"])}</span></li>'
    if key == "not_kept":
        return f'<li>{text}<span class="why">{_e(item.get("why", ""))}</span></li>'
    return f"<li>{text}</li>"


def _level_html(level: str, info: dict) -> str:
    out = [f"<h2>{_e(_name(level))}</h2>"]
    if info.get("limit"):
        out.append(f'<p class="note">Card: {info["card"]:,} of {info["limit"]:,} characters.</p>')
    for u in info["untouched"]:
        out.append(f'<div class="alert"><b>Left untouched</b> for {u["candidates"]} candidate(s): '
                   f'{_e(u["why"])}. They are kept for the next night.</div>')
    split = info.get("split") or {}
    if split.get("folder"):
        essentials = "".join(f"<li>{_e(t)}</li>" for t in split["essentials"])
        out.append(f'<h3>New card for ~/{_e(split["folder"])}</h3>'
                   f'<p>The card was full. {split["facts"]} facts only about ~/{_e(split["folder"])} '
                   f'moved to a card of their own ({split["card"]} of them were on this card). '
                   f'{_e(split["why"])}</p>'
                   + (f'<p class="quiet">Lines of this card that chats in ~/{_e(split["folder"])} also '
                      f'receive, above their own card:</p><ul class="facts">{essentials}</ul>' if essentials else "")
                   + f'<p class="quiet">Undo it on its own from the Knowledge tab, or with the whole night.</p>')
    elif split.get("failed"):
        out.append(f'<div class="alert"><b>Split check failed</b>, nothing moved: {_e(split["failed"])}</div>')
    if info["over_by_pins"]:
        out.append(f'<div class="alert"><b>Over its limit</b> because of pinned lines: '
                   f'{_e(" and ".join(info["over_by_pins"]))}. Nothing was cut.</div>')
    shown = False
    for key, title in GROUPS:
        items = info[key]
        if not items:
            continue
        shown = True
        out.append(f"<h3>{_e(title)} <span>{len(items)}</span></h3>"
                   f'<ul class="facts">{"".join(_item(key, i) for i in items)}</ul>')
    if info["waiting"]:
        out.append(f'<p class="quiet">{info["waiting"]} candidate(s) wait for the next night.</p>')
    if not shown and not info["untouched"] and not split.get("folder"):
        out.append('<p class="quiet">Nothing changed.</p>')
    return "".join(out)


def render(summary: dict) -> str:
    when = datetime.strptime(summary["run"], "%Y%m%d-%H%M%S")
    levels = summary["levels"]
    read, not_read = summary["read"], summary["not_read"]

    def total(key: str) -> int:
        return sum(len(info[key]) for info in levels.values())

    def tile(number: object, label: str) -> str:
        return f'<div class="arm"><div class="num">{number}</div><p>{_e(label)}</p></div>'

    alerts = []
    if summary["status"] == "failed":
        alerts.append("<b>The night failed.</b> No batch of conversation could be read by the model. "
                      "Nothing was lost: the text stays behind its bookmarks for the next night.")
    for f in summary["failures"]:
        alerts.append(f'<b>One batch failed</b> ({_e(_name(f["node"] or "owner"))}, {f.get("chars", 0):,} '
                      f'characters): {_e(f["error"])}. It is read again next night.')
    backlog = summary.get("backlog")
    if backlog:
        late = backlog["days"] >= 3
        alerts.append(
            f'<b>{"Reading is falling behind." if late else "Not everything was read."}</b> '
            f'{backlog["chars"]:,} characters from {backlog["conversations"]} conversation(s) wait for '
            f'the next night; the oldest is from {_e(backlog["oldest"])}. Reading has been behind '
            f'since {_e(backlog["since"])}.'
            + (" Raise <code>night_chars</code> in the memory settings, or run the job again today."
               if late else ""))
    moved = summary.get("moved_in")
    if moved:
        alerts.append(f'<b>First night.</b> The old memory files were moved in: {moved["old_lines"]:,} old '
                      f'line(s), {moved["kept"]:,} kept, {moved["retired"]:,} kept as no longer true, '
                      f'{moved["dropped"]:,} left out; {moved["active"]:,} facts in memory now. '
                      'The old files are kept, untouched, for 30 days.')
    edits = summary.get("owner_edits") or []
    hygiene = summary.get("hygiene") or {}
    tmp = hygiene.get("tmp") or {}

    skipped = [f"<li>{_e(s)}</li>" for s in not_read["sources"]]
    if not_read["automated"]:
        skipped.append(f"<li>{not_read['automated']} scheduled run(s): one message, not a cockpit "
                       "tab, the same opening as another run</li>")
    if not_read["hidden"]:
        skipped.append(f"<li>{not_read['hidden']} run(s) under a hidden folder (the job's own, the exam's)</li>")
    skipped.append("<li>Sub-agents, compaction summaries and tool output, always</li>")

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory: the night of {when:%-d %b %Y}</title><style>{_font_css()}{CSS}{PAGE_CSS}</style></head><body><main>
<p class="kicker">ShellTeam memory · night report · {when:%-d %b %Y, %H:%M}{' · preview, nothing written' if summary.get('preview') else ''}</p>
<h1>What memory learned</h1>
<p class="lede">{_e(in_words(summary))}</p>
<p class="meta">Read: {read['conversations']} conversation(s), {read['messages']:,} messages,
{read['chars']:,} characters, in {read['batches']} batch(es). Model: {_e(summary['model'])}.</p>
{''.join(f'<div class="alert">{a}</div>' for a in alerts)}
<div class="arms">
{tile(total('added') + total('replaced'), 'new facts')}
{tile(total('confirmed'), 'already known, confirmed')}
{tile(total('merged') + total('retired'), 'merged or retired')}
{tile(total('not_kept'), 'not kept')}
{tile(_duration(summary.get('seconds', 0)).replace(' seconds', ' s'), 'run time')}
</div>
{''.join(_level_html(level, info) for level, info in sorted(levels.items()))
 or '<h2>Nothing to place</h2><p class="quiet">No new conversation text since the last night.</p>'}
{f'<h2>Your own edits, taken in</h2><ul class="facts">' + ''.join(
    f"<li>{_e(e.get('text') or e.get('line') or e)}<span class='why'>{_e(e.get('what', ''))}</span></li>"
    for e in edits) + '</ul>' if edits else ''}
<h2>Not read</h2>
<ul class="facts">{''.join(skipped)}</ul>
<h2>Undo</h2>
<p class="note">Every level goes back to how it was before this night with:<br>
<code>python -m api.services.memory.nightly undo {summary['run']}</code><br>
The model's prompts and answers are kept in <code>~/.shellteam/dream/runs/{summary['run']}/</code>.</p>
<h2>Housekeeping</h2>
<p class="note">{len(hygiene.get('stale_tabs', []))} cockpit tab(s) idle for more than a week.
{tmp.get('stale_files', 0)} old file(s) in ~/tmp ({tmp.get('stale_mb', 0)} MB). Nothing was deleted.</p>
</main></body></html>"""


def write_report(home: Path, summary: dict) -> Path:
    reports = home / "reports"
    reports.mkdir(exist_ok=True)
    day = datetime.strptime(summary["run"], "%Y%m%d-%H%M%S").strftime("%Y-%m-%d")
    path, n = reports / f"memory-night-{day}.html", 1
    while path.exists():
        n += 1
        path = reports / f"memory-night-{day}-{n}.html"
    path.write_text(render(summary))
    log.info("Memory night report written: %s", path)
    return path
