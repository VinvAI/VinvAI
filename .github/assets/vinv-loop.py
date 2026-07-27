"""The real Vinv loop, rendered to PNG. 2x supersampled, deck-quality.

Regenerate after editing the copy below:

    uv run --with pillow .github/assets/vinv-loop.py

Writes vinv-loop.png next to this file. That PNG is the source of truth
mirrored to images.vinv.ai/vinv-loop.png, which every README references.
"""

import math
import os
from PIL import Image, ImageDraw, ImageFont

S = 2                     # supersample factor
W, H = 2400, 1500
CX, CY = W // 2, 800
R = 396                   # ring radius
NR = 78                   # stage-node radius
LABEL_R = 486             # radial caption radius
AGENT_R = 172

BG = (10, 10, 12)
ACCENT = (209, 89, 74)
NODE_STROKE = (92, 98, 108)
NODE_FILL = (16, 16, 21)
TEXT = (233, 233, 236)
MUTED = (134, 140, 150)
FAINT = (92, 98, 108)

MENLO = "/System/Library/Fonts/Menlo.ttc"


def font(size, bold=False):
    return ImageFont.truetype(MENLO, size * S, index=1 if bold else 0)


# (stage, what it actually does, which engine) — clockwise from the top.
STAGES = [
    ("BRING UP", "discover · setup · start", "bringup"),
    ("TRACE",    "real args · returns · effects", "tracelens"),
    ("INDEX",    "code graph · embeddings", "index + embedder"),
    ("MAP",      "entry points · call trees", "identification"),
    ("EXERCISE", "drive it · 7 oracles", "exerciser"),
    ("FIND",     "clustered · evidence-backed", "issues + baselines"),
    ("DISPATCH", "context pack → agent", "harness"),
    ("VERIFY",   "replay · tests · oracle", "acceptance gate"),
    ("LEARN",    "bandit · policy · OPE", "reward engine"),
]
N = len(STAGES)
STEP = 360.0 / N
START = -90.0

img = Image.new("RGB", (W * S, H * S), BG)
d = ImageDraw.Draw(img, "RGBA")


def pol(a_deg, radius):
    a = math.radians(a_deg)
    return CX + radius * math.cos(a), CY + radius * math.sin(a)


def circle(cx, cy, r, fill=None, outline=None, width=2):
    box = [(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S]
    d.ellipse(box, fill=fill, outline=outline, width=int(width * S))


def text(x, y, s, f, fill, anchor="mm", spacing=0.0):
    """Draw text; `spacing` adds per-character letter-spacing in px."""
    if not spacing:
        d.text((x * S, y * S), s, font=f, fill=fill, anchor=anchor)
        return
    widths = [d.textlength(ch, font=f) + spacing * S for ch in s]
    total = sum(widths) - spacing * S
    if anchor[0] == "m":
        cx = x * S - total / 2
    elif anchor[0] == "r":
        cx = x * S - total
    else:
        cx = x * S
    for ch, w in zip(s, widths):
        d.text((cx, y * S), ch, font=f, fill=fill, anchor="l" + anchor[1])
        cx += w


def dashed_circle(cx, cy, r, color, width, dash=9, gap=9):
    circ = 2 * math.pi * r
    step = (dash + gap) / circ * 360
    a = 0.0
    while a < 360:
        a2 = min(360, a + dash / circ * 360)
        d.arc([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S],
              a, a2, fill=color, width=int(width * S))
        a += step


def arrow_arc(a0, a1, radius, color, width=3, head=17):
    """Arc from a0 to a1 with an arrowhead at the a1 end."""
    d.arc([(CX - radius) * S, (CY - radius) * S, (CX + radius) * S, (CY + radius) * S],
          a0, a1, fill=color, width=int(width * S))
    # arrowhead: tangent direction at a1
    tipx, tipy = pol(a1, radius)
    tan = math.radians(a1 + 90)
    tx, ty = math.cos(tan), math.sin(tan)
    nx, ny = -ty, tx
    bx, by = tipx - tx * head, tipy - ty * head
    d.polygon([(tipx * S, tipy * S),
               ((bx + nx * head * 0.46) * S, (by + ny * head * 0.46) * S),
               ((bx - nx * head * 0.46) * S, (by - ny * head * 0.46) * S)], fill=color)


# ---- centre glow ----------------------------------------------------------
for i in range(26):
    rr = R - 46 - i * 7
    if rr <= AGENT_R:
        break
    circle(CX, CY, rr, fill=(ACCENT[0], ACCENT[1], ACCENT[2], 1))

# ---- title ----------------------------------------------------------------
text(CX, 88, "FROM COLD REPO TO PRODUCTION-READY", font(42, True), TEXT, "mm", 7)
text(CX, 142, "you run one command — Vinv drives the other eight stages",
     font(22), MUTED, "mm", 2.5)

# ---- the ring -------------------------------------------------------------
dashed_circle(CX, CY, R, (ACCENT[0], ACCENT[1], ACCENT[2], 34), 1.6, dash=3, gap=10)

gap_deg = math.degrees(math.asin(min(1.0, (NR + 15) / R)))
for i in range(N):
    arrow_arc(START + i * STEP + gap_deg,
              START + (i + 1) * STEP - gap_deg,
              R, ACCENT, width=3, head=18)

# ---- the agent, at the centre of the loop ---------------------------------
circle(CX, CY, AGENT_R, fill=NODE_FILL)
dashed_circle(CX, CY, AGENT_R, ACCENT, 2.2, dash=11, gap=10)
text(CX, CY - 52, "YOUR", font(17), MUTED, "mm", 4)
text(CX, CY - 8, "CODING", font(32, True), TEXT, "mm", 2.5)
text(CX, CY + 34, "AGENT", font(32, True), TEXT, "mm", 2.5)
text(CX, CY + 84, "Claude Code · Cursor", font(16), FAINT, "mm", 1.2)

# ---- stage nodes ----------------------------------------------------------
for i, (name, sub, engine) in enumerate(STAGES):
    ang = START + i * STEP
    x, y = pol(ang, R)

    circle(x, y, NR, fill=NODE_FILL, outline=NODE_STROKE, width=2.4)
    circle(x, y, NR, outline=(ACCENT[0], ACCENT[1], ACCENT[2], 92), width=2.4)
    text(x, y, name, font(21 if len(name) <= 8 else 19, True), TEXT, "mm", 1.6)

    c, sn = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    if abs(c) < 0.30:                       # top or bottom
        anchor, lx = "m", x
        ly = y - NR - 58 if sn < 0 else y + NR + 40
    elif c > 0:                             # right half
        anchor, lx, ly = "l", x + NR + 26, y
    else:                                   # left half
        anchor, lx, ly = "r", x - NR - 26, y
    text(lx, ly, sub, font(18), MUTED, anchor + "m", 0.6)
    text(lx, ly + 28, engine, font(15), FAINT, anchor + "m", 0.6)

# ---- footer ---------------------------------------------------------------
fy = H - 92
d.line([(360 * S, (fy - 46) * S), ((W - 360) * S, (fy - 46) * S)],
       fill=(NODE_STROKE[0], NODE_STROKE[1], NODE_STROKE[2], 90), width=int(1 * S))

f19 = font(20)
f19b = font(20, True)
left = "Agents guess what to change.  "
mid = "Vinv observes, finds, verifies, and learns"
right = "  — so the loop closes without you."
tw = (d.textlength(left, font=f19) + d.textlength(mid, font=f19b)
      + d.textlength(right, font=f19))
cx = CX * S - tw / 2
d.text((cx, fy * S), left, font=f19, fill=MUTED, anchor="lm")
cx += d.textlength(left, font=f19)
d.text((cx, fy * S), mid, font=f19b, fill=ACCENT, anchor="lm")
cx += d.textlength(mid, font=f19b)
d.text((cx, fy * S), right, font=f19, fill=MUTED, anchor="lm")

text(CX, fy + 38,
     "every arrow is evidence, not a guess  ·  the agent never grades its own work",
     font(16), FAINT, "mm", 1.1)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vinv-loop.png")
img.resize((W, H), Image.LANCZOS).save(out, "PNG")
print("wrote", out, img.size, "->", (W, H))
