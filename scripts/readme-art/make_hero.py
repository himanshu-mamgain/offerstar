"""Generate Offerstar's animated README hero as a self-contained SVG.

All animation loops on a 9 s master cycle (or a divisor of it) so the
GIF export loops seamlessly.
"""
import random
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
W, H = 1280, 480
CYCLE = 9  # seconds

rnd = random.Random(7)

# Background stars: sparse on the text side, denser on the sky side.
stars = []
for _ in range(70):
    x = rnd.uniform(20, W - 20)
    y = rnd.uniform(18, H - 18)
    if x < 640 and rnd.random() < 0.65:
        continue  # keep the text side calm
    r = rnd.choice([0.8, 1.0, 1.1, 1.3, 1.6, 2.0])
    dur = rnd.choice([3, 4.5])
    delay = round(rnd.uniform(0, dur), 2)
    stars.append((x, y, r, dur, delay))

star_svg = "\n".join(
    f'    <circle class="tw" cx="{x:.1f}" cy="{y:.1f}" r="{r}" '
    f'style="animation-duration:{d}s;animation-delay:-{dl}s"/>'
    for x, y, r, d, dl in stars
)

# The route the guiding star travels: resume -> scan -> plan -> apply -> offer.
PATH = "M 772 352 C 806 350, 832 342, 852 328 S 902 262, 934 250 S 1004 230, 1034 216 S 1084 132, 1098 112"


def sparkle(cx, cy, cls):
    # A small four-point star used for waypoints.
    s = 7
    pts = f"{cx},{cy-s} {cx+2},{cy-2} {cx+s},{cy} {cx+2},{cy+2} {cx},{cy+s} {cx-2},{cy+2} {cx-s},{cy} {cx-2},{cy-2}"
    return f'<polygon class="node {cls}" points="{pts}"/>'


def five_point_star(r_out=17, r_in=7.2):
    import math
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        r = r_out if i % 2 == 0 else r_in
        pts.append(f"{r*math.cos(ang):.2f},{r*math.sin(ang):.2f}")
    return " ".join(pts)


svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">
  <title id="t">Offerstar</title>
  <desc id="d">A guiding star carries a resume through scan, plan and apply to an offer letter. Steer every application toward the offer.</desc>
  <style>
    .sans{{font-family:'Inter','Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif}}
    .mono{{font-family:'JetBrains Mono','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace}}
    .tw{{fill:#E9ECFF;opacity:.3;animation:tw 3s ease-in-out infinite}}
    @keyframes tw{{0%,100%{{opacity:.18}}50%{{opacity:.95}}}}
    .route{{fill:none;stroke:#7B86D6;stroke-width:2;stroke-linecap:round;stroke-dasharray:2 10;opacity:.55;animation:flow 1.5s linear infinite}}
    @keyframes flow{{to{{stroke-dashoffset:-24}}}}
    .trail{{fill:none;stroke:url(#trail);stroke-width:3;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:trail {CYCLE}s cubic-bezier(.45,.05,.35,1) infinite}}
    @keyframes trail{{0%{{stroke-dashoffset:1;opacity:1}}70%{{stroke-dashoffset:0;opacity:1}}86%,100%{{stroke-dashoffset:0;opacity:0}}}}
    .tara{{offset-path:path("{PATH}");offset-rotate:0deg;animation:fly {CYCLE}s cubic-bezier(.45,.05,.35,1) infinite}}
    @keyframes fly{{0%{{offset-distance:0%;opacity:0}}5%{{opacity:1}}70%{{offset-distance:100%;opacity:1}}82%,100%{{offset-distance:100%;opacity:0}}}}
    .spin{{animation:spin 4.5s linear infinite}}
    @keyframes spin{{to{{transform:rotate(360deg)}}}}
    .bob{{animation:bob 1.5s ease-in-out infinite alternate}}
    @keyframes bob{{from{{transform:translateY(-2px)}}to{{transform:translateY(2px)}}}}
    .node{{fill:#C9CEFF;opacity:.35;transform-box:fill-box;transform-origin:center}}
    .n1{{animation:n1 {CYCLE}s ease-out infinite}}
    .n2{{animation:n2 {CYCLE}s ease-out infinite}}
    .n3{{animation:n3 {CYCLE}s ease-out infinite}}
    @keyframes n1{{0%,15%{{opacity:.35;transform:scale(1)}}19%{{opacity:1;fill:#FFD66B;transform:scale(1.6)}}25%,90%{{opacity:1;fill:#FFD66B;transform:scale(1)}}100%{{opacity:.35;transform:scale(1)}}}}
    @keyframes n2{{0%,33%{{opacity:.35;transform:scale(1)}}37%{{opacity:1;fill:#FFD66B;transform:scale(1.6)}}43%,90%{{opacity:1;fill:#FFD66B;transform:scale(1)}}100%{{opacity:.35;transform:scale(1)}}}}
    @keyframes n3{{0%,49%{{opacity:.35;transform:scale(1)}}53%{{opacity:1;fill:#FFD66B;transform:scale(1.6)}}59%,90%{{opacity:1;fill:#FFD66B;transform:scale(1)}}100%{{opacity:.35;transform:scale(1)}}}}
    .lbl{{fill:#8D97DA;font-size:14px}}
    .ring{{fill:none;stroke:#FFD66B;stroke-width:2;transform-box:fill-box;transform-origin:center;animation:ring {CYCLE}s ease-out infinite}}
    .ring2{{animation-delay:.3s}}
    @keyframes ring{{0%,68%{{transform:scale(.5);opacity:0}}71%{{opacity:.9}}90%,100%{{transform:scale(2.2);opacity:0}}}}
    .badge{{transform-box:fill-box;transform-origin:center;animation:badge {CYCLE}s cubic-bezier(.2,.9,.25,1.35) infinite}}
    @keyframes badge{{0%,69%{{transform:scale(0)}}76%,95%{{transform:scale(1)}}100%{{transform:scale(0)}}}}
    .cmd{{opacity:0;animation:cmd {CYCLE}s steps(1) infinite}}
    .cmd2{{animation-delay:-6s}}
    .cmd3{{animation-delay:-3s}}
    @keyframes cmd{{0%{{opacity:1}}33.333%,100%{{opacity:0}}}}
    .type{{animation:type 3s steps(16,end) infinite}}
    @keyframes type{{0%{{transform:translateX(0)}}40%,100%{{transform:translateX(232px)}}}}
    .caret{{animation:blink 1s steps(1) infinite}}
    @keyframes blink{{50%{{opacity:0}}}}
    @media (prefers-reduced-motion:reduce){{*{{animation:none!important}}.cmd1{{opacity:1}}.type{{display:none}}}}
  </style>
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0A0F24"/>
      <stop offset=".55" stop-color="#121A3F"/>
      <stop offset="1" stop-color="#1B1A4A"/>
    </linearGradient>
    <radialGradient id="glow" cx="1060" cy="150" r="420" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4C3F9E" stop-opacity=".55"/>
      <stop offset="1" stop-color="#4C3F9E" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="trail" gradientUnits="userSpaceOnUse" x1="772" y1="352" x2="1098" y2="112">
      <stop offset="0" stop-color="#FFD66B" stop-opacity=".05"/>
      <stop offset="1" stop-color="#FFD66B" stop-opacity=".95"/>
    </linearGradient>
    <radialGradient id="gold" cx=".4" cy=".35" r=".8">
      <stop offset="0" stop-color="#FFF4C2"/>
      <stop offset=".55" stop-color="#FFD66B"/>
      <stop offset="1" stop-color="#F2A93B"/>
    </radialGradient>
    <filter id="halo" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
    <clipPath id="frame"><rect width="{W}" height="{H}" rx="24"/></clipPath>
    <clipPath id="pill"><rect x="40" y="6" width="390" height="46"/></clipPath>
  </defs>

  <g clip-path="url(#frame)">
    <rect width="{W}" height="{H}" fill="url(#sky)"/>
    <rect width="{W}" height="{H}" fill="url(#glow)"/>
{star_svg}

    <!-- route and waypoints -->
    <path class="route" d="{PATH}"/>
    <path class="trail" d="{PATH}" pathLength="1"/>
    {sparkle(852, 328, "n1")}
    {sparkle(934, 250, "n2")}
    {sparkle(1034, 216, "n3")}
    <text class="mono lbl" x="866" y="348">scan</text>
    <text class="mono lbl" x="946" y="274">plan</text>
    <text class="mono lbl" x="1044" y="242">apply</text>

    <!-- resume card -->
    <g transform="translate(706 318) rotate(-7)">
      <rect width="62" height="80" rx="7" fill="#EEF0FF"/>
      <rect x="10" y="12" width="26" height="6" rx="3" fill="#5A64B8"/>
      <rect x="10" y="26" width="42" height="4" rx="2" fill="#B9BFEA"/>
      <rect x="10" y="36" width="36" height="4" rx="2" fill="#B9BFEA"/>
      <rect x="10" y="46" width="42" height="4" rx="2" fill="#B9BFEA"/>
      <rect x="10" y="56" width="28" height="4" rx="2" fill="#B9BFEA"/>
    </g>

    <!-- offer letter -->
    <g transform="translate(1110 72)">
      <circle class="ring" cx="42" cy="34" r="30"/>
      <circle class="ring ring2" cx="42" cy="34" r="30"/>
      <rect width="84" height="60" rx="8" fill="#F6F2E6"/>
      <path d="M2 6 L42 36 L82 6" fill="none" stroke="#D7CDB4" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="42" cy="36" r="9" fill="#E8B23A"/>
      <g class="badge">
        <circle cx="80" cy="4" r="15" fill="#34D399"/>
        <path d="M73 4 l5 5 l9 -10" fill="none" stroke="#0A2A1F" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <text class="sans" x="42" y="86" text-anchor="middle" font-size="15" font-weight="700" fill="#F6F2E6" letter-spacing="2">OFFER</text>
    </g>

    <!-- Tara, the guiding star -->
    <g class="tara">
      <g class="bob">
        <circle r="20" fill="#FFD66B" opacity=".55" filter="url(#halo)"/>
        <g class="spin"><polygon points="{five_point_star()}" fill="url(#gold)" stroke="#F2A93B" stroke-width="1"/></g>
        <circle cx="-4" cy="-1" r="1.8" fill="#2A1E05"/>
        <circle cx="4" cy="-1" r="1.8" fill="#2A1E05"/>
      </g>
    </g>

    <!-- text side -->
    <text class="sans" x="88" y="196" font-size="112" font-weight="800" letter-spacing="-3" fill="#F6F2E6">Offerstar</text>
    <text class="sans" x="92" y="254" font-size="30" font-weight="500" fill="#B9C2FF">Steer every application toward the offer.</text>

    <g transform="translate(92 292)">
      <rect width="440" height="58" rx="12" fill="#060A1A" stroke="#28316A"/>
      <text class="mono" x="22" y="37" font-size="24" font-weight="700" fill="#FFD66B">&#8250;</text>
      <g class="mono" font-size="24" fill="#E8ECFF">
        <text class="cmd cmd1" x="48" y="37">offerstar scan</text>
        <text class="cmd cmd2" x="48" y="37">offerstar plan</text>
        <text class="cmd cmd3" x="48" y="37">/offerstar:apply</text>
      </g>
      <g clip-path="url(#pill)">
        <g class="type">
          <rect x="46" y="10" width="240" height="38" fill="#060A1A"/>
          <rect class="caret" x="46" y="16" width="12" height="26" fill="#FFD66B" opacity=".85"/>
        </g>
      </g>
    </g>

    <text class="sans" x="92" y="398" font-size="19" fill="#8790C9">A CLI with Claude Code skills. Your data is stored on your laptop.</text>
  </g>
</svg>
"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(svg)
print("wrote", OUT, len(svg), "bytes")
