"""Generate Offerstar's animated command route for the README.

Six command stars light up in order along a constellation line on a 9 s loop.
"""
import random
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
W, H = 1280, 260
CYCLE = 9

# (command, caption, built yet). Unbuilt steps are marked "coming soon".
steps = [
    ("setup", "Build your profile", True),
    ("scan", "Find new jobs", True),
    ("plan", "Rank the best fits", True),
    ("apply", "Tailor, check, approve", True),
    ("track", "Record every reply", False),
    ("retro", "Learn what gets calls", False),
]
xs = [130 + i * 204 for i in range(len(steps))]
Y = 104

rnd = random.Random(11)
bg = "\n".join(
    f'    <circle class="tw" cx="{rnd.uniform(16, W-16):.1f}" cy="{rnd.uniform(14, H-14):.1f}" r="{rnd.choice([0.8,1,1.2,1.5])}" '
    f'style="animation-duration:{rnd.choice([3,4.5])}s;animation-delay:-{rnd.uniform(0,4.5):.2f}s"/>'
    for _ in range(46)
)

# The progress line reaches node i at this fraction of the cycle.
reach = [0.04 + i * 0.13 for i in range(len(steps))]  # last node at 0.69


def pct(f):
    return f"{f*100:.1f}%"


node_kf = []
for i, f in enumerate(reach):
    node_kf.append(
        f"@keyframes lit{i}{{0%,{pct(f)}{{fill:#1A2150;stroke:#3A4478}}"
        f"{pct(f+0.02)}{{fill:#FFD66B;stroke:#FFE7A3;transform:scale(1.35)}}"
        f"{pct(f+0.05)},90%{{fill:#FFD66B;stroke:#FFE7A3;transform:scale(1)}}"
        f"96%,100%{{fill:#1A2150;stroke:#3A4478;transform:scale(1)}}}}"
    )
    node_kf.append(
        f"@keyframes cap{i}{{0%,{pct(f)}{{fill:#7F89C8}}{pct(f+0.03)},90%{{fill:#F4F1E8}}96%,100%{{fill:#7F89C8}}}}"
    )
node_css = "\n    ".join(node_kf)

line_start, line_end = xs[0], xs[-1]
prog_end = reach[-1]

nodes = []
for i, ((cmd, cap, built), x) in enumerate(zip(steps, xs)):
    accent = ' fill="#FFD66B"' if cmd == "apply" else ' fill="#C9CEFF"'
    soon = "" if built else f'\n      <text class="sans" x="{x}" y="{Y+112}" text-anchor="middle" font-size="13" fill="#6F79B8">coming soon</text>'
    nodes.append(f"""    <g>
      <circle class="node" style="animation:lit{i} {CYCLE}s ease-out infinite" cx="{x}" cy="{Y}" r="15" stroke-width="2"/>
      <circle cx="{x}" cy="{Y}" r="4.5" fill="#F6F2E6"/>
      <text class="mono" x="{x}" y="{Y+56}" text-anchor="middle" font-size="25" font-weight="700"{accent}>{cmd}</text>
      <text class="sans cap" style="animation:cap{i} {CYCLE}s ease-out infinite" x="{x}" y="{Y+86}" text-anchor="middle" font-size="17">{cap}</text>{soon}
    </g>""")
nodes_svg = "\n".join(nodes)

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="rt rd">
  <title id="rt">The Offerstar workflow</title>
  <desc id="rd">Six steps in order: setup builds your profile, scan finds new jobs, plan ranks the best fits, apply tailors and checks a resume for your approval, then, coming soon, track records every reply and retro learns what gets calls.</desc>
  <style>
    .sans{{font-family:'Inter','Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif}}
    .mono{{font-family:'JetBrains Mono','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace}}
    .tw{{fill:#E9ECFF;animation:tw 3s ease-in-out infinite}}
    @keyframes tw{{0%,100%{{opacity:.15}}50%{{opacity:.8}}}}
    .base{{stroke:#3A4478;stroke-width:2;stroke-dasharray:2 9;stroke-linecap:round}}
    .prog{{stroke:#FFD66B;stroke-width:3;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:prog {CYCLE}s linear infinite}}
    @keyframes prog{{0%,{pct(reach[0])}{{stroke-dashoffset:1;opacity:1}}{pct(prog_end)},90%{{stroke-dashoffset:0;opacity:1}}96%,100%{{stroke-dashoffset:0;opacity:0}}}}
    .node{{transform-box:fill-box;transform-origin:center;fill:#1A2150;stroke:#3A4478}}
    .cap{{fill:#7F89C8}}
    {node_css}
    @media (prefers-reduced-motion:reduce){{*{{animation:none!important}}.prog{{stroke-dashoffset:0}}.node{{fill:#FFD66B;stroke:#FFE7A3}}.cap{{fill:#F4F1E8}}}}
  </style>
  <defs>
    <linearGradient id="rsky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0A0F24"/>
      <stop offset=".6" stop-color="#121A3F"/>
      <stop offset="1" stop-color="#1B1A4A"/>
    </linearGradient>
    <radialGradient id="rglow" cx="742" cy="0" r="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4C3F9E" stop-opacity=".45"/>
      <stop offset="1" stop-color="#4C3F9E" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="rframe"><rect width="{W}" height="{H}" rx="24"/></clipPath>
  </defs>
  <g clip-path="url(#rframe)">
    <rect width="{W}" height="{H}" fill="url(#rsky)"/>
    <rect width="{W}" height="{H}" fill="url(#rglow)"/>
{bg}
    <text class="mono" x="40" y="40" font-size="15" fill="#6F79B8">the offerstar workflow</text>
    <line class="base" x1="{line_start}" y1="{Y}" x2="{line_end}" y2="{Y}"/>
    <line class="prog" x1="{line_start}" y1="{Y}" x2="{line_end}" y2="{Y}" pathLength="1"/>
{nodes_svg}
  </g>
</svg>
"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(svg)
print("wrote", OUT, len(svg), "bytes")
