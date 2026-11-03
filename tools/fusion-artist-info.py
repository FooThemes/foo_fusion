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

Sources: MusicBrainz (identifies the artist; free), TheAudioDB (biography,
genre/style/mood, years, pictures; free key "123", 30 requests a minute),
fanart.tv (better pictures and logos; your own free API key), Wikipedia
(biography when TheAudioDB has none).

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
; Biography language for TheAudioDB (EN, DE, FR, ES, IT, JP, ...).
language = EN
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
    return {k: s.get(k, '').strip() for k in ['music_root', 'artists_folder', 'artist_list', 'fanart_api_key', 'audiodb_key', 'contact', 'language']}


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
    return web.get(f'https://musicbrainz.org/ws/2/artist/{mbid}?inc=url-rels+genres&fmt=json') or {}


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


def wikipedia_intro(web, mb):
    """English Wikipedia intro via the artist's Wikidata link on MusicBrainz.
    Redirects aren't followed: an artist whose page redirects elsewhere (to a
    band or soundtrack article) gets no biography rather than the wrong one."""
    wd = next((r['url']['resource'] for r in mb.get('relations', []) if r.get('type') == 'wikidata'), None)
    if not wd:
        return ''
    qid = wd.rstrip('/').split('/')[-1]
    ent = web.get(f'https://www.wikidata.org/wiki/Special:EntityData/{qid}.json') or {}
    title = ent.get('entities', {}).get(qid, {}).get('sitelinks', {}).get('enwiki', {}).get('title')
    if not title:
        return ''
    q = urllib.parse.urlencode({'action': 'query', 'prop': 'extracts', 'exintro': 1, 'explaintext': 1, 'format': 'json', 'titles': title})
    pages = (web.get(f'https://en.wikipedia.org/w/api.php?{q}') or {}).get('query', {}).get('pages', {})
    return next((p.get('extract', '') for p in pages.values()), '').strip()


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


def build_nfo(name, mbid, adb, mb, bio):
    adb = adb or {}
    tags = []

    def add(tag, value):
        if value:
            tags.append(f'    <{tag}>{escape(str(value))}</{tag}>')

    add('musicBrainzArtistID', mbid)
    add('name', adb.get('strArtist') or mb.get('name') or name)
    genres = split_list(adb.get('strGenre')) or [g['name'] for g in sorted(mb.get('genres', []), key=lambda g: -g.get('count', 0))[:3]]
    for g in genres:
        add('genre', g)
    for s in split_list(adb.get('strStyle')):
        add('style', s)
    for m in split_list(adb.get('strMood')):
        add('mood', m)
    life = mb.get('life-span') or {}
    person = mb.get('type') == 'Person' or (not mb.get('type') and adb.get('intMembers') == '1')
    formed = adb.get('intFormedYear') or (life.get('begin') or '')[:4]
    born = adb.get('intBornYear') or ((life.get('begin') or '')[:4] if person else '')
    died = adb.get('intDiedYear') or ((life.get('end') or '')[:4] if person else '')
    disbanded = adb.get('strDisbanded') or ((life.get('end') or '')[:4] if not person else '')
    add('formed', '' if person else formed)
    add('born', born)
    add('died', died)
    add('disbanded', disbanded)
    add('biography', bio)
    body = '\n'.join(tags)
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n{MARK}\n<artist>\n{body}\n</artist>\n'


# --- main ---------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description='Fetch artist information for Fusion.')
    ap.add_argument('--dry-run', action='store_true', help="show what would be done; don't download or write")
    ap.add_argument('--refresh', action='store_true', help='rewrite artist.nfo files this script made, and retry artists marked done')
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
            folder = target_folder(cfg, name)
            have = {b: existing(folder, b) for b in ('artist', 'fanart', 'logo')}
            nfo_path = os.path.join(folder, 'artist.nfo')
            nfo_mine = os.path.exists(nfo_path) and MARK in open(nfo_path, encoding='utf-8', errors='ignore').read(400)
            want_nfo = not os.path.exists(nfo_path) or (args.refresh and nfo_mine)
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
                    adb_bio = (adb or {}).get(f'strBiography{lang}') or ((adb or {}).get('strBiography') if lang == 'EN' else '') or ''
                    bio = adb_bio.strip() or (wikipedia_intro(web, mb) if mb else '')
                    if not args.dry_run:
                        with open(nfo_path, 'w', encoding='utf-8', newline='\n') as f:
                            f.write(build_nfo(name, mbid, adb, mb, bio))
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
