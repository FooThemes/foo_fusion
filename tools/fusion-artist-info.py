#!/usr/bin/env python3
"""
fusion-artist-info: fetch artist information for Fusion's artist pages.

For every artist in fusion-artists.json (Fusion: Settings > Export artist
list), writes into the artist's folder:

    artist.nfo   biography, genres, styles, moods, years (Kodi's format)
    artist.jpg   picture
    fanart.jpg   wide background picture
    logo.png     logo

The folder is <music root>\\<Artist> when that already exists, otherwise
<music root>\\_Artists\\<Artist> (change "artists_folder" in the settings file).

Sources: MusicBrainz (identifies the artist; free), Wikipedia (biography,
via the artist's MusicBrainz/Wikidata link), TheAudioDB (genre/style/mood,
years, pictures, and the biography when Wikipedia has none; free key "123",
30 requests a minute), fanart.tv (better pictures and logos; your own free
API key).

Nothing you already have is replaced: existing pictures are left alone, and
an existing artist.nfo is only rewritten if this script made it (and only with
--refresh). Progress is saved, so it can be stopped and started again.

Needs Python 3.9+ and nothing else. Run:

    python fusion-artist-info.py            fetch what's missing
    python fusion-artist-info.py --dry-run  show what would happen
    python fusion-artist-info.py --only "Adele"
    python fusion-artist-info.py --refresh  rewrite artist.nfo files it made

Settings: fusion-artist-info.ini next to this script (made on first run).
"""

import argparse
import configparser
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
SETTINGS = os.path.join(HERE, 'fusion-artist-info.ini')
STATE = os.path.join(HERE, 'fusion-artist-info.state.json')
MARK = '<!-- written by fusion-artist-info -->'
VERSION = '1.0'

DEFAULT_SETTINGS = """[fusion-artist-info]
; Where your music is: artists with a folder here get their files there.
music_root = E:\\Music
; Artists without their own folder go into this subfolder of music_root.
artists_folder = _Artists
; The list Fusion exports (Settings > Export artist list), in foobar2000's profile.
artist_list = C:\\path\\to\\foobar2000\\profile\\fusion-artists.json
; Your fanart.tv personal API key (https://fanart.tv/get-an-api-key/). Leave
; empty to use TheAudioDB's pictures only.
fanart_api_key =
; TheAudioDB key: 123 is the free test key (30 requests a minute).
audiodb_key = 123
; MusicBrainz asks every program to identify itself with a way to reach its
; user, e.g. an email address or a web page. Put yours here.
contact =
; Biography language (EN, DE, FR, ES, IT, JA, ...).
language = EN
; Where biographies come from, first that has one wins.
biography = wikipedia, audiodb
"""


def load_settings():
    if not os.path.exists(SETTINGS):
        with open(SETTINGS, 'w', encoding='utf-8') as f:
            f.write(DEFAULT_SETTINGS)
        print(f'Made {SETTINGS}.\nFill in music_root, artist_list, contact (and fanart_api_key), then run again.')
        sys.exit(1)
    cp = configparser.ConfigParser()
    cp.read(SETTINGS, encoding='utf-8')
    s = cp['fusion-artist-info']
    return {k: s.get(k, '').strip() for k in ['music_root', 'artists_folder', 'artist_list', 'fanart_api_key', 'audiodb_key', 'contact', 'language', 'biography']}


# --- web ----------------------------------------------------------------

class Web:
    """HTTP with per-host spacing (MusicBrainz: 1/s; TheAudioDB free: 30/min)."""

    def __init__(self, contact):
        self.agent = f'fusion-artist-info/{VERSION} ( {contact or "no contact given"} )'
        self.last = {}
        self.gap = {'musicbrainz.org': 1.1, 'www.theaudiodb.com': 2.1, 'theaudiodb.com': 2.1}

    def get(self, url, binary=False, tries=4):
        host = urllib.parse.urlparse(url).hostname or ''
        for attempt in range(tries):
            wait = self.gap.get(host, 0.2) - (time.time() - self.last.get(host, 0))
            if wait > 0:
                time.sleep(wait)
            self.last[host] = time.time()
            req = urllib.request.Request(url, headers={'User-Agent': self.agent, 'Accept': '*/*' if binary else 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                return data if binary else json.loads(data.decode('utf-8') or 'null')
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if e.code in (429, 503) and attempt < tries - 1:
                    time.sleep(30 if host.endswith('theaudiodb.com') else 5 * (attempt + 1))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError):
                if attempt < tries - 1:
                    time.sleep(3 * (attempt + 1))
                    continue
                raise
        return None


# --- sources ------------------------------------------------------------

def find_mbid(web, name):
    """MusicBrainz search; only an exact, confident name match is taken."""
    q = urllib.parse.quote(f'artist:"{name}"')
    res = web.get(f'https://musicbrainz.org/ws/2/artist/?query={q}&limit=5&fmt=json') or {}
    exact = [a for a in res.get('artists', []) if a.get('name', '').casefold() == name.casefold() and int(a.get('score', 0)) >= 95]
    if len(exact) == 1:
        return exact[0]['id']
    if len(exact) > 1 and int(exact[0].get('score', 0)) > int(exact[1].get('score', 0)):
        return exact[0]['id']
    return None


def musicbrainz(web, mbid):
    return web.get(f'https://musicbrainz.org/ws/2/artist/{mbid}?inc=url-rels+artist-rels+genres+aliases&fmt=json') or {}


def audiodb(web, key, mbid, name):
    res = None
    if mbid:
        res = web.get(f'https://www.theaudiodb.com/api/v1/json/{key}/artist-mb.php?i={mbid}')
    if not (res and res.get('artists')):
        res = web.get(f'https://www.theaudiodb.com/api/v1/json/{key}/search.php?s={urllib.parse.quote(name)}')
        hits = [a for a in (res or {}).get('artists') or [] if (a.get('strArtist') or '').casefold() == name.casefold()]
        # By name only when it's unambiguous, or the IDs agree.
        if mbid:
            hits = [a for a in hits if not a.get('strMusicBrainzID') or a.get('strMusicBrainzID') == mbid]
        return hits[0] if len(hits) == 1 else None
    return res['artists'][0]


def fanart(web, key, mbid):
    if not (key and mbid):
        return {}
    return web.get(f'https://webservice.fanart.tv/v3/music/{mbid}?api_key={key}') or {}


def wikipedia_intro(web, mb, lang='en'):
    """The Wikipedia article's introduction, found the way MusicBrainz's own
    "Wikipedia" box finds it: through the artist's Wikidata link (or a direct
    Wikipedia link) on MusicBrainz, so it's the right artist, not a namesake.
    Redirects aren't followed: an artist whose page redirects elsewhere (to a
    band or soundtrack article) gets no biography rather than the wrong one."""
    rels = mb.get('relations', [])
    title = None
    wd = next((r['url']['resource'] for r in rels if r.get('type') == 'wikidata'), None)
    if wd:
        qid = wd.rstrip('/').split('/')[-1]
        ent = web.get(f'https://www.wikidata.org/wiki/Special:EntityData/{qid}.json') or {}
        links = ent.get('entities', {}).get(qid, {}).get('sitelinks', {})
        title = links.get(f'{lang}wiki', {}).get('title')
    if not title:
        wp = next((r['url']['resource'] for r in rels if r.get('type') == 'wikipedia' and f'//{lang}.wikipedia.org/' in r['url']['resource']), None)
        if wp:
            title = urllib.parse.unquote(wp.rsplit('/wiki/', 1)[-1]).replace('_', ' ')
    if not title:
        return '', None
    q = urllib.parse.urlencode({'action': 'query', 'prop': 'extracts|info', 'inprop': 'url', 'exintro': 1, 'explaintext': 1, 'format': 'json', 'titles': title})
    pages = (web.get(f'https://{lang}.wikipedia.org/w/api.php?{q}') or {}).get('query', {}).get('pages', {})
    page = next(iter(pages.values()), {})
    text = clean_bio(page.get('extract', ''))
    return text, (page.get('fullurl') if text else None)


IPA = set('əɪʊˈˌːŋʃʒθðæɑɔɛʌɜɒɐɘɵɨʉɯɤɞɶɸβçʝɣχʁħʕɦɬɮɹɻɭʎʟɲɳɴɱʋɰⁿʲʷˤ̃')


def clean_bio(text):
    """Tidy a biography: no pronunciation guides, reference marks ([2],
    [citation needed]) or link/HTML formatting."""
    if not text:
        return ''
    t = re.sub(r'<[^>]+>', '', text)                         # HTML tags
    t = re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'\1', t)  # [text](url)
    t = re.sub(r'\[\[(?:[^|\]]*\|)?([^\]]+)\]\]', r'\1', t)      # [[link|text]]
    t = re.sub(r'\[\s*(?:\d+|[a-z]|citation needed|note \d+|nb \d+|clarification needed|when\?|who\?)\s*\]', '', t, flags=re.I)

    def tidy(m):
        parts = [p.strip() for p in m.group(1).split(';')]
        keep = []
        for p in parts:
            if not p or p in (',', '/'):
                continue
            if any(ch in IPA for ch in p):                       # IPA
                continue
            if re.fullmatch(r"(?:[a-zA-Z]*[A-Z]{2,}[a-zA-Z]*-?|[a-z]+-)+[a-zA-Z]*", p):  # respelling: ə-DEL, AD-kinz
                continue
            if re.match(r'(?i)^(listen|pronounced|pronunciation|[A-Z][a-z]+ pronunciation:?)\b', p):
                continue
            keep.append(p)
        return f" ({'; '.join(keep)})" if keep else ''

    # Pronunciation sits in the first bracket of the opening sentence.
    t = re.sub(r'\s*\(([^()]*)\)', tidy, t, count=1)
    t = re.sub(r'\(\s*[;,]\s*', '(', t)
    t = re.sub(r'[ \t]{2,}', ' ', t)
    t = re.sub(r' +([,.;:])', r'\1', t)
    return t.strip()


def best(images):
    """fanart.tv: the most-liked image's URL."""
    if not images:
        return None
    return max(images, key=lambda i: int(i.get('likes') or 0)).get('url')


# --- files --------------------------------------------------------------

def safe_folder_name(name):
    """As Fusion (and Kodi's export) name artist folders."""
    return re.sub(r'[\\/:*?"<>|]', '_', name).rstrip('. ')


def target_folder(cfg, name):
    own = os.path.join(cfg['music_root'], safe_folder_name(name))
    if os.path.isdir(own):
        return own
    return os.path.join(cfg['music_root'], cfg['artists_folder'] or '_Artists', safe_folder_name(name))


def existing(folder, base):
    if not os.path.isdir(folder):
        return None
    for f in os.listdir(folder):
        if os.path.splitext(f)[0].lower() == base:
            return f
    return None


def split_list(s):
    return [p.strip() for p in re.split(r'[/,;]', s or '') if p.strip()]


def full_date(value):
    """A date as precise as it's known: "2002-10-24", "1996-11" or "1971";
    '' for unknown ("0", "0000")."""
    m = re.match(r'\s*(\d{4})(-\d{2})?(-\d{2})?', str(value or ''))
    if not m or int(m.group(1)) == 0:
        return ''
    return ''.join(g for g in m.groups() if g)


def best_date(mb_value, adb_value):
    """MusicBrainz's date (often a full one), else TheAudioDB's year."""
    return full_date(mb_value) or year(adb_value)


def year(value):
    """A real year from a date or year field, else '' (TheAudioDB uses "0"
    for unknown)."""
    m = re.match(r'\s*(\d{4})', str(value or ''))
    return m.group(1) if m and int(m.group(1)) > 0 else ''


# MusicBrainz's special-purpose artists: placeholders, not people or bands.
# Their Wikidata links point at the concept ("[dialogue]" -> Dialogue).
SPECIAL_MBIDS = {
    '89ad4ac3-39f7-470e-963a-56509c546377',  # Various Artists
    '125ec42a-7229-4250-afc5-e057484327fe',  # [unknown]
    'f731ccc4-e22a-43af-a747-64213329e088',  # [anonymous]
    '314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc',  # [dialogue]
    '33cf029c-63b0-41a0-9855-be2a3665fb3b',  # [data]
    'eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61',  # [no artist]
    '9be7f096-97ec-4615-8957-8d40b5dcbc41',  # [traditional]
    'a0ef7e1d-44ff-4039-9435-7d5fefdeecc9',  # [theatre]
    '80a8851f-444c-4539-892b-ad2a49292aa9',  # [language instruction]
    '66ea0139-149f-4a0c-8fbf-5ea9ec4a6e49',  # [Disney]
    '90068774-4cc8-4155-9e2b-2a1c4e9c4c8b',  # [church chimes]
}


def is_placeholder(name, mbid):
    return (mbid or '').lower() in SPECIAL_MBIDS or bool(re.fullmatch(r'\[.+\]', name.strip())) or name.strip().casefold() == 'various artists'


def non_latin(text):
    import unicodedata
    return any(c.isalpha() and 'LATIN' not in unicodedata.name(c, 'LATIN') for c in text or '')


def name_versions(orig, mb):
    """English and romanised versions of a non-Latin artist name, from
    MusicBrainz: the primary English alias, and the sort name ("Utada,
    Hikaru" -> "Utada Hikaru", MusicBrainz's romanisation in native order)."""
    if not non_latin(orig):
        return '', ''
    best = None
    for a in mb.get('aliases') or []:
        loc = (a.get('locale') or '').lower()
        if (loc == 'en' or loc.startswith('en_')) and a.get('type') in (None, 'Artist name', 'Legal name') and a.get('name'):
            rank = (bool(a.get('primary')), loc == 'en', a.get('type') == 'Artist name')
            if best is None or rank > best[0]:
                best = (rank, a['name'])
    en = best[1] if best and best[1] != orig else ''
    sort = mb.get('sort-name') or ''
    rom = '' if non_latin(sort) else re.sub(r'\s*,\s*', ' ', sort).strip()
    return en, rom if rom != orig else ''


def build_nfo(name, mbid, adb, mb, bio, wiki_url=None):
    adb = adb or {}
    tags = []

    def add(tag, value):
        if value:
            tags.append(f'    <{tag}>{escape(str(value))}</{tag}>')

    add('musicBrainzArtistID', mbid)
    # The name as MusicBrainz credits it (matches the tags), not TheAudioDB's
    # often-English one.
    orig = mb.get('name') or adb.get('strArtist') or name
    add('name', orig)
    add('sortname', mb.get('sort-name'))
    add('type', mb.get('type'))  # Kodi's field: Person, Group, Orchestra, Choir…
    # English and romanised names (not Kodi fields; Fusion shows them like
    # the _EN / _ROM tags).
    en, rom = name_versions(orig, mb)
    add('name_en', en)
    add('name_rom', rom)
    genres = split_list(adb.get('strGenre')) or [g['name'] for g in sorted(mb.get('genres', []), key=lambda g: -g.get('count', 0))[:3]]
    for g in genres:
        add('genre', g)
    for s in split_list(adb.get('strStyle')):
        add('style', s)
    for m in split_list(adb.get('strMood')):
        add('mood', m)
    life = mb.get('life-span') or {}
    person = mb.get('type') == 'Person' or (not mb.get('type') and adb.get('intMembers') == '1')
    # Full dates where MusicBrainz has them ("2002-10-24"), else the year.
    begin, end = life.get('begin'), life.get('end')
    # People are born and die; bands form and split (TheAudioDB sometimes
    # puts a band's formed year in its "born" field).
    if person:
        formed, disbanded = '', ''
        born = best_date(begin, adb.get('intBornYear'))
        died = best_date(end, adb.get('intDiedYear'))
    else:
        born, died = '', ''
        formed = best_date(begin, adb.get('intFormedYear') or adb.get('intBornYear'))
        disbanded = best_date(end, adb.get('strDisbanded') or adb.get('intDiedYear'))
    add('formed', '' if person else formed)
    add('born', born)
    add('died', died)
    add('disbanded', disbanded)
    add('biography', bio)
    # Not Kodi fields (Kodi ignores them); Fusion shows them on the artist page.
    add('wikipedia', wiki_url)
    rels = mb.get('relations') or []
    add('website', next((r['url']['resource'] for r in rels if r.get('type') == 'official homepage' and r.get('url')), None))
    # Bands this artist is (or was) in, and a band's members, with their
    # MusicBrainz IDs: <memberof mbid="…">Nickelback</memberof>.
    seen = set()
    for r in rels:
        other = r.get('artist') or {}
        if r.get('type') != 'member of band' or not other.get('name') or other.get('id') in seen:
            continue
        seen.add(other.get('id'))
        tag = 'memberof' if r.get('direction') == 'forward' else 'member'
        attrs = f' mbid="{escape(other.get("id") or "")}"' + (' ended="true"' if r.get('ended') else '')
        tags.append(f'    <{tag}{attrs}>{escape(other["name"])}</{tag}>')
    body = '\n'.join(tags)
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n{MARK}\n<artist>\n{body}\n</artist>\n'


# Fields that can appear more than once: added only when the file has none.
REPEATED = {'genre', 'style', 'mood', 'memberof', 'member'}
DATES = {'born', 'formed', 'died', 'disbanded'}


def merge_into(path, fresh, dry_run):
    """Fill in an artist.nfo this script didn't write: add the fields it
    lacks, and make a date more precise when the new one agrees with it
    ("1974" -> "1974-11-15"). Nothing already there is changed or removed.
    Returns the names of the fields added or updated."""
    import xml.etree.ElementTree as ET
    try:
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
        tree = ET.parse(path, parser)
    except (ET.ParseError, OSError) as e:
        raise RuntimeError(f"can't read its artist.nfo to update it ({e})")
    root = tree.getroot()
    if root.tag != 'artist':
        return []
    new = ET.fromstring(fresh.split('\n', 2)[2] if fresh.startswith('<?xml') else fresh)
    have = {child.tag for child in root if isinstance(child.tag, str)}
    changed = []
    for el in new:
        if not isinstance(el.tag, str):
            continue
        if el.tag not in have:
            root.append(el)
            if el.tag not in changed:
                changed.append(el.tag)
        elif el.tag in DATES:
            old = root.find(el.tag)
            text = (old.text or '').strip()
            if len(el.text or '') > len(text) and (el.text or '').startswith(text) and re.fullmatch(r'\d{4}(-\d{2})?', text):
                old.text = el.text
                changed.append(el.tag)
    if changed and not dry_run:
        ET.indent(tree, space='    ')
        # Keep the file's own start (its declaration and any comment) as it was.
        with open(path, encoding='utf-8', errors='replace') as f:
            original = f.read()
        start = original.find('<artist')
        head = original[:start] if start > 0 else '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            f.write(head + ET.tostring(root, encoding='unicode') + '\n')
        os.replace(tmp, path)
    return changed


# --- main ---------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description='Fetch artist information for Fusion.')
    ap.add_argument('--dry-run', action='store_true', help="show what would be done; don't download or write")
    ap.add_argument('--refresh', action='store_true', help='rewrite artist.nfo files this script made, fill in missing fields in other artist.nfo files, and retry artists marked done')
    ap.add_argument('--only', help='just this artist (exact name)')
    ap.add_argument('--limit', type=int, default=0, help='stop after this many artists')
    args = ap.parse_args()

    cfg = load_settings()
    for k in ('music_root', 'artist_list'):
        if not cfg[k] or not os.path.exists(cfg[k]):
            sys.exit(f'Settings: {k} = "{cfg[k]}" not found. Edit {SETTINGS}.')
    if not cfg['contact']:
        sys.exit(f'Settings: please fill in "contact" in {SETTINGS} (MusicBrainz asks for it).')

    with open(cfg['artist_list'], encoding='utf-8') as f:
        artists = json.load(f)['artists']
    if args.only:
        artists = [a for a in artists if a['name'].casefold() == args.only.casefold()] or [{'name': args.only, 'mbid': None}]
    state = {}
    if os.path.exists(STATE):
        with open(STATE, encoding='utf-8') as f:
            state = json.load(f)

    web = Web(cfg['contact'])
    lang = (cfg['language'] or 'EN').upper()
    order = [x.strip().lower() for x in (cfg.get('biography') or 'wikipedia, audiodb').split(',') if x.strip()]
    done = 0
    stats = {'new': 0, 'skipped': 0, 'not found': 0, 'failed': 0}
    log = open(os.path.join(HERE, 'fusion-artist-info.log'), 'a', encoding='utf-8')

    def note(msg):
        print(msg)
        log.write(time.strftime('%Y-%m-%d %H:%M:%S ') + msg + '\n')
        log.flush()

    note(f'--- {len(artists)} artists' + (' (dry run)' if args.dry_run else ''))
    try:
        for a in artists:
            name = a['name']
            if args.limit and done >= args.limit:
                break
            if is_placeholder(name, a.get('mbid')):
                stats['skipped'] += 1
                note(f'{name}: MusicBrainz placeholder, not an artist; skipped')
                continue
            folder = target_folder(cfg, name)
            have = {b: existing(folder, b) for b in ('artist', 'fanart', 'logo')}
            nfo_path = os.path.join(folder, 'artist.nfo')
            nfo_mine = os.path.exists(nfo_path) and MARK in open(nfo_path, encoding='utf-8', errors='ignore').read(400)
            # Other tools' (or hand-made) artist.nfo files are only added to,
            # and only with --refresh.
            merge_nfo = args.refresh and os.path.exists(nfo_path) and not nfo_mine
            want_nfo = not os.path.exists(nfo_path) or (args.refresh and nfo_mine) or merge_nfo
            if not want_nfo and all(have.values()):
                stats['skipped'] += 1
                continue
            if state.get(name, {}).get('status') in ('done', 'not found') and not args.refresh:
                stats['skipped'] += 1
                continue
            done += 1
            try:
                mbid = a.get('mbid') or find_mbid(web, name)
                mb = musicbrainz(web, mbid) if mbid else {}
                adb = audiodb(web, cfg['audiodb_key'] or '123', mbid, name)
                if not mbid and adb and adb.get('strMusicBrainzID'):
                    mbid = adb['strMusicBrainzID']
                    mb = musicbrainz(web, mbid)
                fa = fanart(web, cfg['fanart_api_key'], mbid)
                if not (mbid or adb):
                    note(f'?  {name}: not found (no MusicBrainz match)')
                    state[name] = {'status': 'not found', 'when': int(time.time())}
                    stats['not found'] += 1
                    continue
                pictures = {
                    'artist': best(fa.get('artistthumb')) or (adb or {}).get('strArtistThumb'),
                    'fanart': best(fa.get('artistbackground')) or (adb or {}).get('strArtistFanart'),
                    'logo': best(fa.get('hdmusiclogo')) or best(fa.get('musiclogo')) or (adb or {}).get('strArtistLogo'),
                }
                wrote = []
                if not args.dry_run:
                    os.makedirs(folder, exist_ok=True)
                for base, url in pictures.items():
                    if have[base] or not url:
                        continue
                    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower() or ('.png' if base == 'logo' else '.jpg')
                    if args.dry_run:
                        wrote.append(base + ext)
                        continue
                    data = web.get(url, binary=True)
                    if data:
                        with open(os.path.join(folder, base + ext), 'wb') as f:
                            f.write(data)
                        wrote.append(base + ext)
                if want_nfo:
                    # Wikipedia first (current, and what MusicBrainz shows),
                    # then TheAudioDB's text (often an older Wikipedia copy).
                    bio = ''
                    wiki_url = None
                    for source in order:
                        if source == 'wikipedia' and mb:
                            bio, wiki_url = wikipedia_intro(web, mb, lang.lower())
                        elif source == 'audiodb' and adb:
                            bio = clean_bio(adb.get(f'strBiography{lang}') or (adb.get('strBiography') if lang == 'EN' else '') or '')
                        if bio:
                            break
                    if not wiki_url and mb:
                        # Link the article even when the biography came from elsewhere.
                        _, wiki_url = wikipedia_intro(web, mb, lang.lower()) if 'wikipedia' not in order else ('', None)
                    fresh = build_nfo(name, mbid, adb, mb, bio, wiki_url)
                    if merge_nfo:
                        added = merge_into(nfo_path, fresh, args.dry_run)
                        if added:
                            wrote.append('artist.nfo (added ' + ', '.join(added) + ')')
                    else:
                        if not args.dry_run:
                            with open(nfo_path, 'w', encoding='utf-8', newline='\n') as f:
                                f.write(fresh)
                        wrote.append('artist.nfo')
                where = os.path.relpath(folder, cfg['music_root'])
                note(f'+  {name} -> {where}: {", ".join(wrote) or "nothing new"}')
                state[name] = {'status': 'done', 'mbid': mbid, 'when': int(time.time())}
                stats['new'] += 1
            except Exception as e:  # keep going; it's logged and retried next run
                note(f'!  {name}: {e}')
                state[name] = {'status': 'failed', 'error': str(e), 'when': int(time.time())}
                stats['failed'] += 1
            if not args.dry_run and done % 10 == 0:
                save_state(state)
    except KeyboardInterrupt:
        note('Stopped; run again to carry on.')
    if not args.dry_run:
        save_state(state)
    note('--- ' + ', '.join(f'{v} {k}' for k, v in stats.items()))


def save_state(state):
    tmp = STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=0)
    os.replace(tmp, STATE)


if __name__ == '__main__':
    main()
