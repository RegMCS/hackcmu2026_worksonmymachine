"""Build client/src/tracks/buggy.json: the CMU Buggy course as a closed, elevation-aware loop.
Street geometry: OpenStreetMap via Overpass (ODbL). Elevation: Open-Meteo. Needs internet."""
import json, math, heapq, sys, os, time, urllib.request, urllib.parse
OUT = os.path.join(os.path.dirname(__file__), '..', 'client', 'src', 'tracks', 'buggy.json')
QUERY = ('[out:json][timeout:40];(way["name"="Frew Street"](40.435,-79.952,40.447,-79.934);'
         'way["name"="Tech Street"](40.435,-79.952,40.447,-79.934);'
         'way["name"="Schenley Drive"](40.435,-79.952,40.447,-79.934););out geom;')
MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
           'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
d = None
for attempt in range(3):
    for m in MIRRORS:
        try:
            with urllib.request.urlopen(urllib.request.Request(m, data=urllib.parse.urlencode({'data': QUERY}).encode()), timeout=60) as r:
                body = r.read()
            if body[:1] == b'{': d = json.loads(body); break
        except Exception as e:
            print('overpass', m, e, file=sys.stderr)
        time.sleep(2)
    if d: break
if not d: sys.exit('Overpass unavailable, try again later')

# --- graph from OSM ways ---
nodes, adj = {}, {}
def hav(a, b):
    R = 6371000; la1, lo1 = map(math.radians, a); la2, lo2 = map(math.radians, b)
    h = math.sin((la2-la1)/2)**2 + math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))
for w in d['elements']:
    ids, geom = w['nodes'], w['geometry']
    for i, nid in enumerate(ids):
        nodes[nid] = (geom[i]['lat'], geom[i]['lon'])
    for a, b in zip(ids, ids[1:]):
        L = hav(nodes[a], nodes[b])
        adj.setdefault(a, []).append((b, L)); adj.setdefault(b, []).append((a, L))

def nearest(lat, lon):
    return min(nodes, key=lambda n: hav(nodes[n], (lat, lon )))
def dijkstra(src, dst):
    dist, prev, pq = {src: 0}, {}, [(0, src)]
    while pq:
        dd, u = heapq.heappop(pq)
        if u == dst: break
        if dd > dist[u]: continue
        for v, L in adj[u]:
            nd = dd + L
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    path = [dst]
    while path[-1] != src: path.append(prev[path[-1]])
    return path[::-1]

W = {  # waypoints in travel order
    'start': (40.4417574, -79.941566),   # top of Tech St by Hamerschlag
    'A':     (40.4404419, -79.9421518),  # Tech / Frew junction
    'B':     (40.4401478, -79.9422539),  # Tech / Schenley junction (Hill 2 turn)
    'W2':    (40.4386615, -79.9458),     # bottom of the Free Roll
    'W3':    (40.4407889, -79.9481911),  # Chute: Schenley onto Frew
}
N = {k: nearest(*v) for k, v in W.items()}
legs = [('start','A'), ('A','B'), ('B','W2'), ('W2','W3'), ('W3','A'), ('A','start')]
seq, marks = [], {}
for a, b in legs:
    p = dijkstra(N[a], N[b])
    if seq: p = p[1:]
    marks.setdefault(a, len(seq) if seq else 0)
    seq += p
marks['A2'] = len(seq) - len(dijkstra(N['A'], N['start'])) + 0  # second pass through A
marks['end'] = len(seq) - 1
print('legs ok; nodes in loop:', len(seq), 'marks:', marks, file=sys.stderr)

# --- to local metres (x east, y north) ---
lat0 = sum(nodes[n][0] for n in seq)/len(seq); lon0 = sum(nodes[n][1] for n in seq)/len(seq)
kx = 111320*math.cos(math.radians(lat0)); ky = 110574
def xy(n): la, lo = nodes[n]; return ((lo-lon0)*kx, (la-lat0)*ky)
pts = [xy(n) for n in seq]

def length(p):
    return sum(math.dist(p[i], p[i+1]) for i in range(len(p)-1))
def resample(p, step):
    out, acc = [p[0]], 0.0
    for a, b in zip(p, p[1:]):
        seg = math.dist(a, b)
        while acc + step <= seg:
            acc += step; t = acc/seg
            out.append((a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t))
        acc -= seg
    return out
def offset(p, off):  # shift polyline to the right of travel by `off` metres
    out = []
    for i, q in enumerate(p):
        a = p[max(0, i-1)]; b = p[min(len(p)-1, i+1)]
        dx, dy = b[0]-a[0], b[1]-a[1]; L = math.hypot(dx, dy) or 1
        out.append((q[0] + dy/L*off, q[1] - dx/L*off))
    return out

LANE = -5.5  # left of travel: Hill 1 on the east side of Tech St, the return on the west, so nothing crosses at Frew
hill1 = offset(pts[marks['start']:marks['A']+1], LANE)          # Tech St southbound
loop  = pts[marks['A']:marks['A2']+1]                             # Schenley + Frew, back to A
ret   = offset(pts[marks['A2']:marks['end']+1], LANE)            # Tech St northbound
print('real course (start->A on Tech, loop back to A):', round(length(pts[marks['start']:marks['A2']+1])), 'm', file=sys.stderr)

# hairpin at the top: extend both lanes 14 m past the start, join with a semicircle
def extend(p, from_end, dist):
    a, b = (p[-2], p[-1]) if from_end else (p[1], p[0])
    dx, dy = b[0]-a[0], b[1]-a[1]; L = math.hypot(dx, dy)
    return (b[0]+dx/L*dist, b[1]+dy/L*dist)
ret_top = extend(ret, True, 14); hill1_top = extend(hill1, False, 14)
cx, cy = (ret_top[0]+hill1_top[0])/2, (ret_top[1]+hill1_top[1])/2
r = math.dist(ret_top, hill1_top)/2
a0 = math.atan2(ret_top[1]-cy, ret_top[0]-cx)
# sweep so the arc bulges away from the course (away from junction A)
ax, ay = pts[marks['A']]
best = None
for sgn in (1, -1):
    arc = [(cx + r*math.cos(a0 + sgn*t), cy + r*math.sin(a0 + sgn*t)) for t in [k*math.pi/6 for k in range(1, 6)]]
    mid = arc[2]
    if best is None or math.dist(mid, (ax, ay)) > best[0]: best = (math.dist(mid, (ax, ay)), arc)
arc = best[1]

STEP = 6
h1 = resample([hill1_top] + hill1, STEP)
lp = resample(loop, STEP)
rt = resample(ret + [ret_top], STEP)
poly = h1 + lp[1:] + rt[1:] + arc
i_B  = len(h1) + min(range(len(lp)), key=lambda i: math.dist(lp[i], pts[marks['B']]))
i_W2 = len(h1) + min(range(len(lp)), key=lambda i: math.dist(lp[i], pts[marks['W2']]))
i_W3 = len(h1) + min(range(len(lp)), key=lambda i: math.dist(lp[i], pts[marks['W3']]))
i_A2 = len(h1) + len(lp) - 1

# light smoothing (window 3), leaving the hairpin arc alone
sm = list(poly)
for i in range(1, len(poly) - len(arc) - 1):
    sm[i] = tuple((poly[i-1][k] + poly[i][k] + poly[i+1][k])/3 for k in range(2))
poly = sm
# rotate so the start line sits 48 m down Hill 1, clear of the hairpin (grid forms behind it)
K = 8
poly = poly[K:] + poly[:K]
i_B -= K; i_W2 -= K; i_W3 -= K; i_A2 -= K
total = length(poly + [poly[0]])
cum = [0.0]
for a, b in zip(poly, poly[1:]): cum.append(cum[-1] + math.dist(a, b))
print('closed loop length:', round(total), 'm, control points:', len(poly), file=sys.stderr)

# --- elevation (Open-Meteo, batches of 100) ---
elev = []
for i in range(0, len(poly), 100):
    batch = poly[i:i+100]
    lats = ','.join(f'{lat0 + y/ky:.6f}' for x, y in batch)
    lons = ','.join(f'{lon0 + x/kx:.6f}' for x, y in batch)
    url = 'https://api.open-meteo.com/v1/elevation?' + urllib.parse.urlencode({'latitude': lats, 'longitude': lons})
    with urllib.request.urlopen(url, timeout=30) as r:
        elev += json.load(r)['elevation']
print('elevation raw range:', round(min(elev),1), '-', round(max(elev),1), 'm', file=sys.stderr)
# circular moving average so the loop closes smoothly
n = len(elev)
def circ_smooth(v, win):
    return [sum(v[(i+k) % n] for k in range(-win, win+1))/(2*win+1) for i in range(n)]
# The 90 m elevation grid steps where the road hugs a hillside; smooth wide, then cap the grade at 11 %
# (about the real Hill 3), sweeping both directions until stable.
smooth = circ_smooth(elev, 10)
MAX_GRADE = 0.11
for _ in range(20):
    changed = False
    for direction in (1, -1):
        for k in range(n):
            i = (k * direction) % n; j = (i + direction) % n
            d = math.dist(poly[i], poly[j]) or STEP
            lim = MAX_GRADE * d
            if smooth[j] - smooth[i] > lim: smooth[j] = smooth[i] + lim; changed = True
            elif smooth[i] - smooth[j] > lim: smooth[j] = smooth[i] - lim; changed = True
    if not changed: break
smooth = circ_smooth(smooth, 3)
base = min(smooth)
ys = [e - base for e in smooth]
mg = max(abs(ys[(i+1)%n]-ys[i])/(math.dist(poly[i], poly[(i+1)%n]) or STEP) for i in range(n))
print('max grade after limiter: %.1f%%' % (mg*100), file=sys.stderr)
print('elevation smoothed range: 0 -', round(max(ys),1), 'm', file=sys.stderr)

def at(i): return round(cum[i]/total, 4)
sections = [
    {'name': 'HILL 1', 'at': 0.0},
    {'name': 'HILL 2', 'at': at(max(0, i_B - 6))},
    {'name': 'FREE ROLL', 'at': at(i_B + 14)},
    {'name': 'THE CHUTE', 'at': at(i_W3 - 8)},
    {'name': 'HILL 3', 'at': at(i_W3 + 5)},
    {'name': 'HILL 4', 'at': at(i_W3 + 5 + (i_A2 - i_W3 - 5)//3)},
    {'name': 'HILL 5', 'at': at(i_W3 + 5 + 2*(i_A2 - i_W3 - 5)//3)},
    {'name': 'FINISH STRAIGHT', 'at': at(i_A2 - 4)},
    {'name': 'BACK TO THE GRID', 'at': at(i_A2 + 4)},
]
out = {
    'name': 'CMU Buggy Course',
    'source': 'OpenStreetMap (ODbL) street geometry, Open-Meteo elevation',
    'origin': {'lat': round(lat0, 7), 'lon': round(lon0, 7)},
    'lengthMeters': round(total),
    'roadWidth': 11,
    'finishAt': at(i_A2 - 2),
    'sections': sections,
    # game coords: x east, y up, z south (so a top-down view is a north-up map)
    'points': [[round(x, 2), round(y, 2), round(-n_, 2)] for (x, n_), y in zip(poly, ys)],
}
json.dump(out, open(OUT, 'w'))
print('wrote', OUT, file=sys.stderr)
print('sections:', [(s['name'], s['at']) for s in sections], file=sys.stderr)
print('hill profile (m above base) at sections:', [round(ys[min(len(ys)-1, int(s['at']*len(ys)))],1) for s in sections], file=sys.stderr)
