"""The recall exam's report page: one self-contained HTML file in ~/reports.

Self-contained on purpose (fonts inlined, no script, no outside request): the
file view is sandboxed, and a page that needs the network there comes out
unstyled.
"""

from __future__ import annotations

import base64
import json
import html
import logging
from pathlib import Path

from api.services.memory_exam import score

log = logging.getLogger("shellteam.exam")

FONTS = Path(__file__).resolve().parents[2] / "frontend" / "static" / "vendor" / "fonts"
_FACES = (
    ("Zilla Slab", 600, "normal", "zilla-slab-600-latin.woff2"),
    ("Zilla Slab", 400, "italic", "zilla-slab-400-italic-latin.woff2"),
    ("Libre Franklin", 500, "normal", "libre-franklin-500-latin.woff2"),
    ("Libre Franklin", 600, "normal", "libre-franklin-600-latin.woff2"),
)

KINDS = (
    ("recent", "Recent facts", 85, "Something said or decided in the last two weeks."),
    ("changed", "Changed facts", 70, "The answer changed; giving the old one is wrong."),
    ("lookup", "Needs a lookup", 70, "A detail too small for a summary; the agent has to go and look."),
    ("should_not_know", "Should not know", 100,
     "Another project's detail. Scored on the launch text: it must not be there."),
)
VERDICTS = (
    ("right", "Right"), ("clean", "Not in the launch text"), ("partly", "Partly"),
    ("unknown", "Did not know"), ("wrong", "Wrong"), ("leak", "In the launch text"),
)
AGENT_NAMES = {"claude": "Claude Code", "codex": "Codex"}
NOT_RUN = ("Antigravity and OpenCode were not run: neither is set up to answer unattended "
           "on this box yet.")

CSS = """
:root{--paper:#f5f0e6;--card:#fbf8f1;--ink:#1c1a17;--soft:#6b655b;--rule:#d9d1c1;
 --right:#2c6a4d;--partly:#c79a1e;--unknown:#cfc6b3;--wrong:#c4432b}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
 font:500 16px/1.55 "Libre Franklin",system-ui,sans-serif;
 background-image:repeating-linear-gradient(0deg,transparent 0 31px,rgba(28,26,23,.035) 31px 32px)}
main{max-width:1040px;margin:0 auto;padding:56px 28px 96px}
h1,h2,h3,.num{font-family:"Zilla Slab",Georgia,serif;font-weight:600}
h1{font-size:clamp(40px,7vw,68px);line-height:1;margin:0 0 14px;letter-spacing:-.01em}
h2{font-size:28px;margin:64px 0 6px;padding-top:18px;border-top:3px solid var(--ink)}
h3{font-size:21px;margin:0}
.kicker{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft);margin:0 0 18px}
.lede{font-family:"Zilla Slab",Georgia,serif;font-style:italic;font-weight:400;font-size:21px;
 line-height:1.4;max-width:46em;margin:0 0 8px}
.meta,.note{color:var(--soft);font-size:14px;max-width:52em}
.arms{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:34px 0 0}
.arm{background:var(--card);border:1px solid var(--rule);border-top:5px solid var(--ink);padding:14px 16px 16px}
.arm .who{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--soft)}
.arm .num{font-size:52px;line-height:1.05;margin:6px 0 2px}
.arm .num small{font-size:22px}
.arm p{margin:0;font-size:14px;line-height:1.35}
.kind{display:grid;grid-template-columns:230px 1fr;gap:10px 30px;padding:26px 0;border-bottom:1px solid var(--rule)}
.kind p{margin:6px 0 0;font-size:14px;color:var(--soft)}
.target{display:inline-block;margin-top:10px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;
 border:1.5px solid var(--ink);padding:2px 8px}
.row{display:grid;grid-template-columns:170px 1fr 54px;gap:12px;align-items:center;margin:0 0 9px;font-size:14px}
.row .label b{font-weight:600}.row .label span{color:var(--soft)}
.bar{position:relative;height:22px;background:rgba(28,26,23,.06);display:flex}
.bar i{display:block;height:100%}
.right,.clean{background:var(--right)}.partly{background:var(--partly)}
.unknown{background:var(--unknown)}.wrong,.leak{background:var(--wrong)}
.bar .goal{position:absolute;top:-5px;bottom:-5px;width:0;border-left:2px dashed var(--ink)}
.row .pct{font-family:"Zilla Slab",Georgia,serif;font-weight:600;font-size:20px;text-align:right}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--soft);margin:18px 0 0}
.legend i{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-1px}
.legend .goalkey{border-left:2px dashed var(--ink);width:0;height:14px;margin-right:8px}
.scroll{overflow-x:auto;margin-top:16px}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:640px}
th,td{text-align:left;padding:9px 12px 9px 0;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--soft);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td:first-child{min-width:210px}td:first-child b{display:block}td:nth-child(2){white-space:nowrap}
details{border-bottom:1px solid var(--rule)}
summary{cursor:pointer;padding:14px 0;font-family:"Zilla Slab",Georgia,serif;font-weight:600;font-size:19px}
.check{display:grid;grid-template-columns:92px 1fr;gap:4px 16px;padding:12px 0;border-top:1px dotted var(--rule);font-size:14px}
.check .v{font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
.check .q{font-weight:600}.check .k{color:var(--soft)}
.v.right{background:none;color:var(--right)}.v.partly{background:none;color:#8a6a0c}
.v.unknown{background:none;color:var(--soft)}.v.wrong{background:none;color:var(--wrong)}
@media (max-width:720px){main{padding:36px 18px 72px}.kind{grid-template-columns:1fr}
 .row{grid-template-columns:1fr 46px}.row .label{grid-column:1/-1;margin-bottom:-6px}
 .check{grid-template-columns:1fr}h2{font-size:24px}}
"""


def _font_css() -> str:
    faces = []
    for family, weight, style, name in _FACES:
        data = base64.b64encode((FONTS / name).read_bytes()).decode()
        faces.append(
            f'@font-face{{font-family:"{family}";font-weight:{weight};font-style:{style};'
            f'src:url(data:font/woff2;base64,{data}) format("woff2")}}')
    return "".join(faces)


def _e(text: object) -> str:
    return html.escape(str(text))


def _arm_label(arm: dict) -> str:
    return f"<b>{_e(AGENT_NAMES.get(arm['agent'], arm['agent']))}</b> <span>{_e(arm['what'])}</span>"


def _overall(arm: dict) -> tuple[int | None, int]:
    """Share right over the questions the agent answered (the launch-text
    check is a different thing and is shown on its own)."""
    kinds = [k for name, k in arm["kinds"].items() if name != "should_not_know"]
    n = sum(k["n"] for k in kinds)
    return (round(100 * sum(k.get("right", 0) for k in kinds) / n) if n else None), n


def _asked(arm: dict, n: int) -> str:
    if arm["asked"] < arm["to_ask"]:
        return f"{arm['asked']} of {arm['to_ask']} questions asked so far"
    return f"{n} questions"


def _bar(kind: dict, target: int) -> str:
    parts = "".join(
        f'<i class="{v}" style="width:{100 * kind.get(v, 0) / kind["n"]:.2f}%" '
        f'title="{_e(label)}: {kind.get(v, 0)} of {kind["n"]}"></i>'
        for v, label in VERDICTS if kind.get(v))
    goal = f'<span class="goal" style="left:{target}%"></span>' if target < 100 else ""
    return f'<div class="bar">{parts}{goal}</div>'


def _kinds_html(arms: list[dict]) -> str:
    out = []
    for name, title, target, what in KINDS:
        rows = []
        for arm in arms:
            kind = arm["kinds"].get(name)
            if not kind:
                continue
            rows.append(
                f'<div class="row"><div class="label">{_arm_label(arm)}</div>'
                f'{_bar(kind, target)}<div class="pct">{score(kind)}%</div></div>')
        if not rows:
            continue
        n = max(arm["kinds"].get(name, {}).get("n", 0) for arm in arms)
        out.append(
            f'<section class="kind"><div><h3>{_e(title)}</h3><p>{_e(what)}</p>'
            f'<span class="target">Target {target}% · {n} questions</span></div>'
            f'<div>{"".join(rows)}</div></section>')
    return "".join(out)


def _minutes(seconds: float | None) -> str:
    return "n/a" if seconds is None else f"{seconds / 60:.0f} min"


def _numbers_html(arms: list[dict]) -> str:
    rows = []
    for arm in arms:
        sizes = arm["launch_chars"].values()
        size = (f"{min(sizes):,} to {max(sizes):,}" if sizes and min(sizes) != max(sizes)
                else f"{max(sizes, default=0):,}")
        cost = "n/a" if arm["notional_cost_usd"] is None else f"${arm['notional_cost_usd']:,.2f}"
        rows.append(
            f"<tr><td>{_arm_label(arm)}</td><td>{_e(arm['model'])}</td>"
            f"<td>{'on' if arm['own_memory'] else 'off'}</td>"
            f"<td class=n>{size}</td><td class=n>{arm['lookups_per_question']}</td>"
            f"<td class=n>{arm['seconds_per_question']} s</td>"
            f"<td class=n>{_minutes(arm['wall_seconds'])}</td><td class=n>{cost}</td>"
            f"<td class=n>{arm['no_answer']}</td><td class=n>{arm['refused_calls']}</td>"
            f"<td class=n>{arm['contaminated']}</td></tr>")
    return (
        '<div class="scroll"><table><tr><th>Arm</th><th>Model</th><th>Own memory</th>'
        '<th class=n>Launch text, characters</th><th class=n>Tool calls per question</th>'
        '<th class=n>Time per question</th><th class=n>Whole arm</th>'
        '<th class=n>Notional cost</th><th class=n>No answer</th>'
        '<th class=n>Calls refused</th><th class=n>Read a conversation</th></tr>'
        + "".join(rows) + "</table></div>")


def _launch_html(arms: list[dict]) -> str:
    folders = sorted({f for arm in arms for f in arm["launch_chars"]})
    seen, columns = set(), []
    for arm in arms:  # the launch text is the same for every agent: one column per memory
        if arm["shellteam_memory"] not in seen:
            seen.add(arm["shellteam_memory"])
            columns.append(arm)
    names = {"off": "No memory", "tree": "Knowledge tree"}
    head = "".join(f"<th class=n>{_e(names.get(a['shellteam_memory'], 'ShellTeam memory today'))}</th>"
                   for a in columns)
    rows = "".join(
        f"<tr><td>{_e(f)}</td>"
        + "".join(f"<td class=n>{a['launch_chars'].get(f, 0):,}</td>" for a in columns) + "</tr>"
        for f in folders)
    return f'<div class="scroll"><table><tr><th>Chat started in</th>{head}</tr>{rows}</table></div>'


# The hand check holds questions with their keys and answers. It is written
# encoded and drawn by the page, so an agent sitting a later exam that greps
# ~/reports does not read the answer key (it did once, 14 Nov 2026).
_HAND_CHECK_JS = """
document.querySelectorAll('[data-checks]').forEach(function (box) {
  var bytes = Uint8Array.from(atob(box.dataset.checks), function (c) { return c.charCodeAt(0); });
  var arms = JSON.parse(new TextDecoder().decode(bytes));
  var labels = JSON.parse(box.dataset.labels);
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; return e; }
  arms.forEach(function (checks, n) {
    var d = el('details'); d.appendChild(el('summary', '', labels[n]));
    checks.forEach(function (c) {
      var row = el('div', 'check'); row.appendChild(el('div', 'v ' + c.verdict, c.verdict_label));
      var body = el('div'); var q = el('div', 'q', c.question + ' ');
      q.appendChild(el('span', 'k', '(' + c.folder + ')')); body.appendChild(q);
      body.appendChild(el('div', 'k', 'Key: ' + c.key));
      if (c.answer) body.appendChild(el('div', '', c.answer.slice(0, 600)));
      else { var none = el('div'); none.appendChild(el('i', '', 'no answer')); body.appendChild(none); }
      body.appendChild(el('div', 'k', c.note)); row.appendChild(body); d.appendChild(row);
    });
    box.appendChild(d);
  });
});
"""


def _hand_check_html(arms: list[dict]) -> str:
    checks = [[{**c, "verdict_label": dict(VERDICTS).get(c["verdict"], c["verdict"])} for c in arm["hand_check"]]
              for arm in arms]
    labels = [f"{AGENT_NAMES.get(arm['agent'], arm['agent'])}: {arm['what']} ({len(arm['hand_check'])} answers)"
              for arm in arms]
    blob = base64.b64encode(json.dumps(checks).encode()).decode()
    return (f'<div data-checks="{blob}" data-labels="{_e(json.dumps(labels))}"></div>'
            f"<script>{_HAND_CHECK_JS}</script>")


def render(summary: dict) -> str:
    arms = sorted(summary["arms"], key=lambda a: (a["agent"], a["arm"]))
    cards = []
    for arm in arms:
        pct, n = _overall(arm)
        cards.append(
            f'<div class="arm"><div class="who">{_e(AGENT_NAMES.get(arm["agent"], arm["agent"]))}</div>'
            f'<div class="num">{"n/a" if pct is None else pct}<small>%</small></div>'
            f'<p>{_e(arm["what"])}<br><span class="note">{_asked(arm, n)}</span></p></div>')
    legend = "".join(
        f'<span><i class="{v}"></i>{_e(label)}</span>'
        for v, label in (("right", "Right"), ("partly", "Partly right"),
                         ("unknown", "Said it did not know"), ("wrong", "Wrong, stated as fact")))
    sets = sorted({a["set"] for a in arms})
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recall exam: {_e(summary['run'])}</title><style>{_font_css()}{CSS}</style></head><body><main>
<p class="kicker">ShellTeam memory · recall exam · run “{_e(summary['run'])}”</p>
<h1>What does a fresh agent know?</h1>
<p class="lede">Each question comes from a real conversation of the last two weeks. A newly
opened agent answers it in the folder it belongs to, with no access to the conversation itself.</p>
<p class="meta">Question set {_e(', '.join(sets))} · written {_e(summary['written'][:16].replace('T', ' '))}.
 {_e(summary['margin'])}</p>
<div class="arms">{''.join(cards)}</div>
<p class="note">The large number is the share answered right across recent, changed and lookup questions.</p>

<h2>Score by kind of question</h2>
<div class="legend">{legend}<span><i class="goalkey"></i>Target</span></div>
{_kinds_html(arms)}

<h2>What each arm cost</h2>
<p class="note">Cost is what the calls would have cost on a metered key; they ran on the owner's
subscription. Codex does not report one. “Calls refused” counts attempts to reach a conversation
store, write a file or use an outside tool, all closed during an exam.</p>
{_numbers_html(arms)}

<h2>Size of the launch text</h2>
<p class="note">Everything the cockpit hands an agent at start (its instructions plus memory), per folder.</p>
{_launch_html(arms)}

<h2>Check the grader by hand</h2>
<p class="note">Twenty graded answers per arm, picked at random. {_e(NOT_RUN)}</p>
{_hand_check_html(arms)}
</main></body></html>"""


def write_report(home: Path, summary: dict) -> Path:
    reports = home / "reports"
    reports.mkdir(exist_ok=True)
    path = reports / f"memory-exam-{summary['run']}.html"
    path.write_text(render(summary))
    log.info("Exam report written: %s", path)
    return path
