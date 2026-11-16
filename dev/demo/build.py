"""Download the demo library used for the README screenshots.

The albums are Creative Commons and public-domain releases from the Internet
Archive's netlabel collections, listed (with their licences) in
docs/screenshots/CREDITS.md. This reads that list, fetches each album's track
list and cover, and writes:

    dev/demo/data/library.json   albums and their tracks
    dev/demo/data/covers/<id>.jpg

The data folder isn't committed; run this again to get it back:

    python dev/demo/build.py

Then open index.html?demo in a browser (see demo.js).
"""

import io
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / 'data'
COVERS = OUT / 'covers'
AUDIO = ('VBR MP3', '320Kbps MP3', '256Kbps MP3', '128Kbps MP3', '64Kbps MP3', 'MP3', 'Flac', 'Ogg Vorbis')


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'fusion-demo-build/1.0'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retry anything
            if i == tries - 1:
                raise
            print(f'  retry {url}: {e}', file=sys.stderr)
            time.sleep(2 * (i + 1))


def albums_from_credits():
    """(album, artist, licence url, archive id) from the credits table."""
    text = (ROOT / 'docs/screenshots/CREDITS.md').read_text(encoding='utf-8')
    section = text.split('## Albums', 1)[1].split('\n## ', 1)[0]
    out = []
    for line in section.splitlines():
        m = re.match(r'\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*\[[^\]]*\]\(([^)]*)\)\s*\|\s*\[archive\.org\]\(https://archive\.org/details/([^)]+)\)', line)
        if m:
            album, artist, lic, ident = m.groups()
            out.append((album.replace('\\|', '|'), artist.replace('\\|', '|'), lic, ident))
    return out


def seconds(v):
    if v is None:
        return 0
    v = str(v)
    if ':' in v:
        parts = [float(x) for x in v.split(':')]
        return int(round(sum(p * 60 ** i for i, p in enumerate(reversed(parts)))))
    try:
        return int(round(float(v)))
    except ValueError:
        return 0


# The Archive's subjects mix genres with label and netlabel names: only these
# count as genres (with a few spellings folded together).
GENRES = {
    'ambient': 'Ambient', 'dark ambient': 'Dark Ambient', 'drone': 'Drone', 'electronic': 'Electronic', 'electronica': 'Electronic',
    'experimental': 'Experimental', 'idm': 'IDM', 'techno': 'Techno', 'minimal': 'Minimal', 'minimal techno': 'Minimal',
    'trance': 'Trance', 'genetic trance': 'Trance', 'psytrance': 'Trance', 'noise': 'Noise', 'lo-fi': 'Lo-Fi', 'lofi': 'Lo-Fi',
    'post-punk': 'Post-Punk', 'punk': 'Punk', 'rock': 'Rock', 'indie': 'Indie Rock', 'indie rock': 'Indie Rock', 'metal': 'Metal',
    'open metal': 'Metal', 'hip-hop': 'Hip-Hop', 'hip hop': 'Hip-Hop', 'rap': 'Hip-Hop', 'classical': 'Classical',
    'instrumental': 'Instrumental', 'improvisation': 'Improvisation', 'jazz': 'Jazz', 'downtempo': 'Downtempo',
    'chillout': 'Downtempo', 'house': 'House', 'dub': 'Dub', 'breakcore': 'Breakcore', 'chiptune': 'Chiptune',
    '8bit': 'Chiptune', 'glitch': 'Glitch', 'folk': 'Folk', 'acoustic': 'Folk', 'pop': 'Pop', 'soundtrack': 'Soundtrack',
    'trip-hop': 'Trip-Hop', 'trip hop': 'Trip-Hop', 'dubstep': 'Dubstep', 'drum and bass': 'Drum & Bass', 'dnb': 'Drum & Bass',
    'electro': 'Electro', 'industrial': 'Industrial', 'spoken word': 'Spoken Word', 'field recordings': 'Field Recordings',
}


def genres_of(subject, collection=None):
    """Up to two genres from the item's subjects (else its collection's), joined by '; '."""
    words = []
    for v in (subject if isinstance(subject, list) else [subject or '']):
        words += [w.strip().lower() for w in re.split(r'[;,]', v) if w.strip()]
    found = []
    for w in words:
        g = GENRES.get(w)
        if g and g not in found:
            found.append(g)
    if not found:
        # Netlabel collections are mostly electronic.
        coll = ' '.join(collection if isinstance(collection, list) else [collection or '']).lower()
        found = ['Ambient'] if 'ambient' in coll else ['Electronic']
    return '; '.join(found[:2])


def fix_encoding(s):
    """Cyrillic tags read as Latin-1 ("Ïåñíÿ"): back to what they were."""
    if not s or not re.search(r'[\u00c0-\u00ff]{3}', s):
        return s
    try:
        fixed = s.encode('latin-1').decode('cp1251')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s
    return fixed if re.search(r'[\u0400-\u04ff]', fixed) else s


def clean_title(title, n):
    """Titles that are file names: no catalogue code, no track number."""
    t = re.sub(r'^[a-z]{1,4}\d{2,4}[\s_-]+', '', title, flags=re.I)  # "hr101 01 Song"
    t = re.sub(rf'^0*{n}(?:\s*[-_.]\s*|\s+|(?=[A-Z]))', '', t)  # "01 - Song", "02Song"
    t = t.replace('_', ' ').strip()
    if ' ' not in t and len(t) > 12:
        t = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', t)  # "TheAmbientCat" -> "The Ambient Cat"
    return t or title


def track_no(v, fallback):
    m = re.match(r'\d+', str(v or ''))
    return int(m.group()) if m else fallback


def fetch_album(row):
    album, artist, lic, ident = row
    meta = json.loads(get(f'https://archive.org/metadata/{ident}'))
    m = meta.get('metadata', {})
    files = meta.get('files', [])
    # The original upload's audio files, in the format that has the most of them.
    originals = [f for f in files if f.get('source') == 'original' and f.get('format') in AUDIO]
    fmt = max(AUDIO, key=lambda a: sum(1 for f in originals if f.get('format') == a))
    audio = [f for f in originals if f.get('format') == fmt] or [f for f in files if f.get('format') in AUDIO]
    tracks = []
    for i, f in enumerate(sorted(audio, key=lambda f: (track_no(f.get('track'), 999), f['name']))):
        name = f['name'].rsplit('/', 1)[-1]
        title = fix_encoding(f.get('title') or name.rsplit('.', 1)[0])
        tracks.append({
            'title': title,
            'artist': fix_encoding(f.get('creator') or f.get('artist') or artist),
            'track': track_no(f.get('track'), i + 1),
            'length': seconds(f.get('length')),
        })
    # The same song more than once (copies of the upload, spelled differently):
    # once, by its title without numbers, spaces or case.
    seen, unique = set(), []
    for t in tracks:
        k = re.sub(r'^[a-z]{1,4}\d{2,4}', '', t['title'].lower())
        k = re.sub(r'^\d+', '', re.sub(r'[^a-z0-9\u0400-\u04ff]', '', k))
        if k and k not in seen:
            seen.add(k)
            unique.append(t)
    tracks = unique or tracks
    # Number them 1..n in order (some uploads skip or repeat numbers).
    for i, t in enumerate(tracks):
        t['track'] = i + 1
        t['title'] = clean_title(t['title'], i + 1)
    date = str(m.get('date') or m.get('year') or '')[:10]
    if not re.match(r'\d{4}', date):
        date = str(2003 + sum(map(ord, ident)) % 12)  # none given: a plausible year, the same every run
    return_genre = genres_of(m.get('subject'), m.get('collection'))
    # The cover: one marked as such, the large one first, else the item image.
    images = [f for f in files if f.get('format') in ('JPEG', 'PNG') and 'thumb' not in f['name'].lower()]
    covers = [f for f in images if 'cover' in (f.get('title') or '').lower() or re.search(r'cover|front|folder', f['name'], re.I)]
    covers.sort(key=lambda f: ('large' not in (f.get('title') or '' + f['name']).lower(), -int(f.get('size') or 0)))
    pick = covers[0] if covers else (sorted(images, key=lambda f: -int(f.get('size') or 0))[0] if images else None)
    url = f'https://archive.org/download/{ident}/{urllib.request.quote(pick["name"])}' if pick else f'https://archive.org/services/img/{ident}'
    dest = COVERS / f'{ident}.jpg'
    if not dest.exists():
        im = Image.open(io.BytesIO(get(url))).convert('RGB')
        im.thumbnail((700, 700))
        im.save(dest, quality=88)
    return {'id': ident, 'album': fix_encoding(album), 'artist': fix_encoding(artist), 'licence': lic, 'genre': return_genre, 'date': date, 'tracks': tracks}


def harbour_cover():
    """The cover of "Night Ferry" by Harbour Lights, an album made up for the
    demo (it has lyrics, for the lyrics screenshot): lights on dark water."""
    import random
    from PIL import ImageDraw, ImageFilter
    dest = COVERS / 'harbour-lights.jpg'
    if dest.exists():
        return
    W = 700
    rnd = random.Random(7)
    im = Image.new('RGB', (W, W))
    d = ImageDraw.Draw(im)
    for y in range(W):  # night sky to water
        t = y / W
        d.line([(0, y), (W, y)], fill=(int(14 + 30 * t), int(18 + 22 * t), int(48 + 40 * (1 - abs(t - 0.55) * 1.6))))
    glow = Image.new('RGB', (W, W))
    g = ImageDraw.Draw(glow)
    shore = 390
    for _ in range(70):  # harbour lights along the shore, and their reflections
        x = rnd.uniform(20, W - 20)
        y = shore + rnd.uniform(-30, 8)
        r = rnd.uniform(3, 9)
        c = rnd.choice([(255, 196, 92), (255, 160, 70), (250, 230, 170), (120, 190, 255)])
        g.ellipse([x - r, y - r, x + r, y + r], fill=c)
        for k in range(1, 9):
            ry = shore + 30 + k * rnd.uniform(14, 22)
            if ry < W:
                g.ellipse([x - r * 0.8, ry - 2, x + r * 0.8, ry + 2], fill=tuple(int(v * (1 - k / 10)) for v in c))
    from PIL import ImageChops
    im = ImageChops.lighter(im, glow)  # the lights themselves
    im = ImageChops.add(im, glow.filter(ImageFilter.GaussianBlur(14)))  # and their glow
    im = ImageChops.add(im, glow.filter(ImageFilter.GaussianBlur(40)))
    d = ImageDraw.Draw(im)
    d.rectangle([0, shore + 4, W, shore + 7], fill=(10, 12, 30))
    im.filter(ImageFilter.GaussianBlur(1.2)).save(dest, quality=90)


def main():
    COVERS.mkdir(parents=True, exist_ok=True)
    harbour_cover()
    rows = albums_from_credits()
    print(f'{len(rows)} albums in the credits')
    out, failed = [], []
    with ThreadPoolExecutor(6) as pool:
        for row, res in zip(rows, pool.map(lambda r: _safe(fetch_album, r), rows)):
            if isinstance(res, Exception):
                failed.append((row[3], res))
            elif res['tracks']:
                out.append(res)
            else:
                failed.append((row[3], 'no tracks'))
    (OUT / 'library.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'{len(out)} albums, {sum(len(a["tracks"]) for a in out)} tracks -> {OUT}')
    for ident, err in failed:
        print(f'  failed: {ident}: {err}')


def _safe(fn, arg):
    try:
        return fn(arg)
    except Exception as e:  # noqa: BLE001
        return e


if __name__ == '__main__':
    main()
