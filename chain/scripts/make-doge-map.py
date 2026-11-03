import json, math, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

random.seed(7)
W, H = 1600, 1147          # final size (same ratio as the original 1035x742)
S = 2                       # supersampling
w, h = W * S, H * S

nodes = json.loads(subprocess.check_output(
    ['node', '-e', "const GE=require('E:/Gry/WoL-Doge/public/gameEngine.js');console.log(JSON.stringify((GE.createDefaultMapNodes||GE.GameEngine.createDefaultMapNodes)()))"]))
P = {n['id']: (n['x'] / 100 * w, n['y'] / 100 * h, n['type']) for n in nodes}

GREEN = (143, 222, 98)
img = Image.new('RGB', (w, h), GREEN)
d = ImageDraw.Draw(img)

def blob(draw, cx, cy, rx, ry, fill, n=14, jitter=0.18):
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        k = 1 + random.uniform(-jitter, jitter)
        pts.append((cx + math.cos(a) * rx * k, cy + math.sin(a) * ry * k))
    draw.polygon(pts, fill=fill)

# grass: big soft lighter/darker patches
for _ in range(90):
    cx, cy = random.uniform(0, w), random.uniform(0, h)
    r = random.uniform(120, 340) * S / 2
    col = random.choice([(158, 232, 112), (128, 210, 88), (150, 226, 104), (170, 238, 124)])
    blob(d, cx, cy, r, r * 0.7, col)
img = img.filter(ImageFilter.GaussianBlur(26 * S / 2))
d = ImageDraw.Draw(img)

# little grass tufts and flowers
for _ in range(1400):
    x, y = random.uniform(0, w), random.uniform(0, h)
    c = (96, 180, 66)
    d.line([(x, y), (x - 4 * S, y - 9 * S)], fill=c, width=2 * S)
    d.line([(x, y), (x + 4 * S, y - 9 * S)], fill=c, width=2 * S)
    d.line([(x, y), (x, y - 11 * S)], fill=c, width=2 * S)
for _ in range(260):
    x, y = random.uniform(0, w), random.uniform(0, h)
    col = random.choice([(255, 255, 255), (255, 214, 64), (255, 140, 186), (255, 255, 255)])
    d.ellipse([x - 3 * S, y - 3 * S, x + 3 * S, y + 3 * S], fill=col)

# lakes
def lake(cx, cy, rx, ry):
    for grow, col in ((26, (60, 120, 70)), (14, (250, 236, 170)), (0, (74, 168, 255))):
        random.seed(int(cx) + grow)
        blob(d, cx, cy, rx + grow * S, ry + grow * S, col, n=18, jitter=0.12)
    random.seed(int(cx))
    blob(d, cx, cy, rx * 0.82, ry * 0.8, (110, 196, 255), n=16, jitter=0.1)
    for i in range(6):
        x = cx + random.uniform(-rx * 0.5, rx * 0.5)
        y = cy + random.uniform(-ry * 0.5, ry * 0.5)
        d.arc([x - 30 * S, y - 8 * S, x + 30 * S, y + 8 * S], 200, 340, fill=(235, 248, 255), width=3 * S)
lakes = [(60 * S, 30 * S, 170 * S, 120 * S), (w - 40 * S, h - 70 * S, 190 * S, 140 * S), (w - 20 * S, 40 * S, 90 * S, 70 * S)]
for l in lakes:
    lake(*l)

# roads
edges = []
rows = [['W1', 'W2', 'W3'], ['W4', 'W5', 'W6', 'W7'], ['W8', 'W9', 'W10']]
for r in rows:
    for a, b in zip(r, r[1:]):
        edges.append((a, b))
for a, b in [('W1', 'W4'), ('W1', 'W5'), ('W2', 'W5'), ('W2', 'W6'), ('W3', 'W6'), ('W3', 'W7'),
             ('W4', 'W8'), ('W5', 'W8'), ('W5', 'W9'), ('W6', 'W9'), ('W6', 'W10'), ('W7', 'W10')]:
    edges.append((a, b))
for i in range(1, 11):
    edges.append((f'W{i}', f'A{i}'))
    edges.append((f'W{i}', f'B{i}'))
# roads leaving the map
exits = [('W1', (0.30 * w, -20)), ('W2', (0.52 * w, -20)), ('W3', (0.76 * w, -20)), ('W4', (-20, 0.47 * h)), ('W7', (w + 20, 0.5 * h)),
         ('W8', (0.20 * w, h + 20)), ('W9', (0.47 * w, h + 20)), ('W10', (0.72 * w, h + 20))]

def curve(p, q, bend):
    mx, my = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
    dx, dy = q[0] - p[0], q[1] - p[1]
    L = math.hypot(dx, dy) or 1
    cx, cy = mx - dy / L * bend, my + dx / L * bend
    return [((1 - t) ** 2 * p[0] + 2 * (1 - t) * t * cx + t * t * q[0], (1 - t) ** 2 * p[1] + 2 * (1 - t) * t * cy + t * t * q[1]) for t in [i / 24 for i in range(25)]]

road_paths = []
for a, b in edges:
    pa, pb = P[a][:2], P[b][:2]
    road_paths.append((curve(pa, pb, random.uniform(-26, 26) * S), 30 if a.startswith('W') and b.startswith('W') else 20))
for a, q in exits:
    road_paths.append((curve(P[a][:2], q, random.uniform(-30, 30) * S), 28))
for pts, wd in road_paths:
    d.line(pts, fill=(176, 120, 52), width=int((wd + 8) * S), joint='curve')
for pts, wd in road_paths:
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - (wd + 8) * S / 2, p[1] - (wd + 8) * S / 2, p[0] + (wd + 8) * S / 2, p[1] + (wd + 8) * S / 2], fill=(176, 120, 52))
for pts, wd in road_paths:
    d.line(pts, fill=(247, 214, 128), width=int(wd * S), joint='curve')
    for p in (pts[0], pts[-1]):
        d.ellipse([p[0] - wd * S / 2, p[1] - wd * S / 2, p[0] + wd * S / 2, p[1] + wd * S / 2], fill=(247, 214, 128))
    # pebbles
    for _ in range(int(len(pts) * 1.2)):
        p = random.choice(pts)
        x, y = p[0] + random.uniform(-wd / 2.4, wd / 2.4) * S, p[1] + random.uniform(-wd / 2.4, wd / 2.4) * S
        d.ellipse([x - 2 * S, y - 2 * S, x + 2 * S, y + 2 * S], fill=(222, 182, 98))

# mask of "no trees" areas (roads, lakes, villages)
mask = Image.new('L', (w // 4, h // 4), 0)
md = ImageDraw.Draw(mask)
for pts, wd in road_paths:
    md.line([(x / 4, y / 4) for x, y in pts], fill=255, width=int((wd + 34) * S / 4))
for l in lakes:
    md.ellipse([(l[0] - l[2] - 40 * S) / 4, (l[1] - l[3] - 40 * S) / 4, (l[0] + l[2] + 40 * S) / 4, (l[1] + l[3] + 40 * S) / 4], fill=255)
for k, (x, y, t) in P.items():
    r = (78 if t == 'main' else 56) * S / 4
    md.ellipse([x / 4 - r, y / 4 - r, x / 4 + r, y / 4 + r], fill=255)

def free(x, y):
    xi, yi = int(x / 4), int(y / 4)
    return 0 <= xi < mask.width and 0 <= yi < mask.height and mask.getpixel((xi, yi)) == 0

items = []   # (y, kind, x, y, size)
# trees (poisson-ish)
placed = []
tries = 0
while len(placed) < 300 and tries < 40000:
    tries += 1
    x, y = random.uniform(0, w), random.uniform(0, h)
    if not free(x, y):
        continue
    r = random.uniform(24, 38) * S
    if any(math.hypot(x - px, y - py) < (r + pr) * 0.78 for px, py, pr in placed):
        continue
    placed.append((x, y, r))
    items.append((y, random.choice(['tree'] * 6 + ['pine'] * 2 + ['bush'] * 2), x, y, r))
# rocks
for _ in range(34):
    for _t in range(50):
        x, y = random.uniform(0, w), random.uniform(0, h)
        if free(x, y):
            items.append((y, 'rock', x, y, random.uniform(18, 34) * S))
            break
# villages and coins
for k, (x, y, t) in P.items():
    items.append((y + 30 * S, 'house_' + t, x, y, 1))
    if t == 'main':
        items.append((y + 52 * S, 'coin', x + 62 * S, y + 36 * S, 15 * S))

OUT = (62, 40, 20)
def tree(x, y, r):
    d.ellipse([x - r * 0.9, y + r * 0.45, x + r * 0.9, y + r * 0.95], fill=(86, 160, 62))
    d.rectangle([x - r * 0.14, y + r * 0.3, x + r * 0.14, y + r * 0.85], fill=(139, 90, 43), outline=OUT, width=2 * S)
    col = random.choice([(58, 170, 76), (46, 150, 68), (74, 186, 84), (52, 162, 72)])
    d.ellipse([x - r, y - r * 0.9, x + r, y + r * 0.6], fill=col, outline=OUT, width=3 * S)
    d.ellipse([x - r * 0.62, y - r * 0.7, x - r * 0.05, y - r * 0.18], fill=tuple(min(255, c + 36) for c in col))
    if random.random() < 0.18:
        for _ in range(3):
            fx, fy = x + random.uniform(-r * 0.5, r * 0.5), y + random.uniform(-r * 0.5, r * 0.3)
            d.ellipse([fx - 3 * S, fy - 3 * S, fx + 3 * S, fy + 3 * S], fill=(255, 120, 150))

def pine(x, y, r):
    d.ellipse([x - r * 0.7, y + r * 0.55, x + r * 0.7, y + r * 0.95], fill=(86, 160, 62))
    d.rectangle([x - r * 0.12, y + r * 0.45, x + r * 0.12, y + r * 0.9], fill=(139, 90, 43), outline=OUT, width=2 * S)
    for i, (k, c) in enumerate([(1.0, (38, 140, 78)), (0.78, (46, 156, 86)), (0.55, (60, 172, 96))]):
        top = y - r * (1.35 - i * 0.5)
        d.polygon([(x, top), (x - r * k, top + r * 0.95), (x + r * k, top + r * 0.95)], fill=c, outline=OUT)
        d.line([(x, top), (x - r * k, top + r * 0.95), (x + r * k, top + r * 0.95), (x, top)], fill=OUT, width=3 * S)

def bush(x, y, r):
    r *= 0.7
    for dx in (-0.55, 0.55, 0):
        d.ellipse([x + dx * r - r * 0.7, y - r * 0.7, x + dx * r + r * 0.7, y + r * 0.5], fill=(66, 178, 80), outline=OUT, width=3 * S)
    for _ in range(3):
        fx, fy = x + random.uniform(-r, r), y + random.uniform(-r * 0.5, r * 0.2)
        d.ellipse([fx - 3 * S, fy - 3 * S, fx + 3 * S, fy + 3 * S], fill=random.choice([(255, 80, 110), (255, 220, 70)]))

def rock(x, y, r):
    d.ellipse([x - r, y + r * 0.2, x + r, y + r * 0.8], fill=(80, 130, 60))
    for dx, dy, k in ((-0.5, 0.0, 0.75), (0.45, 0.1, 0.65), (0, -0.25, 0.85)):
        d.ellipse([x + dx * r - r * k, y + dy * r - r * k * 0.8, x + dx * r + r * k, y + dy * r + r * k * 0.6], fill=(176, 182, 196), outline=OUT, width=3 * S)
        d.ellipse([x + dx * r - r * k * 0.6, y + dy * r - r * k * 0.7, x + dx * r - r * k * 0.05, y + dy * r - r * k * 0.2], fill=(214, 220, 232))

def house(x, y, main):
    k = 1.0 if main else 0.72
    bw, bh = 62 * k * S, 40 * k * S
    # dirt patch
    d.ellipse([x - 84 * k * S, y - 16 * k * S, x + 84 * k * S, y + 64 * k * S], fill=(176, 120, 52))
    d.ellipse([x - 78 * k * S, y - 12 * k * S, x + 78 * k * S, y + 58 * k * S], fill=(243, 208, 120))
    if main:   # little fence
        for i in range(-5, 6):
            fx = x + i * 14 * S
            fy = y + 54 * S - abs(i) * 1.2 * S
            d.rectangle([fx - 3 * S, fy - 14 * S, fx + 3 * S, fy], fill=(250, 240, 220), outline=OUT, width=2 * S)
    # body
    x0, y0, x1, y1 = x - bw / 2, y + 4 * S, x + bw / 2, y + 4 * S + bh
    d.rectangle([x0, y0, x1, y1], fill=(236, 178, 104), outline=OUT, width=3 * S)
    for i in range(1, 4):
        d.line([(x0, y0 + bh * i / 4), (x1, y0 + bh * i / 4)], fill=(196, 140, 74), width=2 * S)
    # door
    dw, dh = 20 * k * S, 26 * k * S
    d.rectangle([x - dw / 2, y1 - dh, x + dw / 2, y1], fill=(70, 40, 24))
    d.ellipse([x - dw / 2, y1 - dh - dw / 2, x + dw / 2, y1 - dh + dw / 2], fill=(70, 40, 24))
    # roof
    roof = (226, 74, 74) if main else (70, 130, 232)
    rl = (255, 120, 110) if main else (130, 180, 255)
    pts = [(x - bw * 0.68, y0 + 3 * S), (x, y0 - 36 * k * S), (x + bw * 0.68, y0 + 3 * S)]
    d.polygon(pts, fill=roof, outline=OUT)
    d.line(pts + [pts[0]], fill=OUT, width=3 * S)
    d.polygon([pts[0], (x, y0 - 36 * k * S), (x - bw * 0.1, y0 - 22 * k * S), (x - bw * 0.4, y0 + 3 * S)], fill=rl)
    # bone sign
    bx, by = x, y0 - 14 * k * S
    d.line([(bx - 8 * k * S, by), (bx + 8 * k * S, by)], fill=(255, 255, 255), width=max(2, int(4 * k * S)))
    for sx in (-8, 8):
        for sy in (-2.4, 2.4):
            d.ellipse([bx + sx * k * S - 3 * k * S, by + sy * k * S - 3 * k * S, bx + sx * k * S + 3 * k * S, by + sy * k * S + 3 * k * S], fill=(255, 255, 255))
    if main:   # flag
        px, py = x + bw * 0.62, y0 - 4 * S
        d.line([(px, py + 6 * S), (px, py - 52 * S)], fill=OUT, width=4 * S)
        d.polygon([(px, py - 52 * S), (px + 34 * S, py - 44 * S), (px, py - 34 * S)], fill=(60, 120, 230), outline=OUT)
        d.ellipse([px + 6 * S, py - 48 * S, px + 16 * S, py - 38 * S], fill=(255, 214, 64))

def coin(x, y, r):
    d.ellipse([x - r, y + r * 0.1, x + r, y + r * 1.2], fill=(120, 80, 20))
    d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 205, 50), outline=OUT, width=2 * S)
    d.ellipse([x - r * 0.72, y - r * 0.72, x + r * 0.72, y + r * 0.72], outline=(214, 150, 20), width=2 * S)
    try:
        f = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', int(r * 1.2))
        d.text((x, y), 'D', fill=(150, 90, 10), font=f, anchor='mm')
    except Exception:
        pass

for it in sorted(items, key=lambda t: t[0]):
    _, kind, x, y, s = it
    if kind == 'tree': tree(x, y, s)
    elif kind == 'pine': pine(x, y, s)
    elif kind == 'bush': bush(x, y, s)
    elif kind == 'rock': rock(x, y, s)
    elif kind == 'house_main': house(x, y, True)
    elif kind == 'house_sub': house(x, y, False)
    elif kind == 'coin': coin(x, y, s)

out = img.resize((W, H), Image.LANCZOS)
out.save('E:/Gry/WoL-Doge/public/assets/doge-map.jpg', quality=90)
out.resize((800, 574)).save('E:/Gry/WoL-Doge/runtime/mapa/doge-map-preview.png')
print('ok')
