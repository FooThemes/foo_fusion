PLUGIN_NAME = 'Genre Tidy'
PLUGIN_AUTHOR = 'Steven'
PLUGIN_DESCRIPTION = '''
Standardises genres as they're written, so one genre is spelt one way across
the library: "jpop", "J Pop" and "j-pop" all become "J-Pop"; "Rock Music"
becomes "Rock"; duplicates are dropped.
<br><br>
It works on what's actually about to be saved, after MusicBrainz, scripts and
plugins that add genres later (Wikidata Genre, Last.fm) have all had their
say, which a track-metadata plugin such as Genre Mapper can't see.
<br><br>
Settings (Options &gt; Plugins &gt; Genre Tidy):
<ul>
<li><b>Spellings</b>: how each genre should be written. Anything that differs
only in capitals, spaces, hyphens, "&amp;"/"and" or a trailing "music" is
changed to it.</li>
<li><b>Replacements</b>: <i>from=to</i> lines for real renames (rap=Hip Hop,
ost=Soundtrack). * and ? are wildcards; with "regular expressions" ticked,
<i>from</i> is a regex and <i>to</i> may use \\1. An empty <i>to</i> removes the
genre.</li>
<li>Removing a trailing " music", except for the names listed to keep.</li>
<li>Capitalising genres it has no spelling for (R&amp;B, IDM and small words
like "and" kept as they should be).</li>
</ul>
'''
PLUGIN_VERSION = '1.0'
PLUGIN_API_VERSIONS = ['2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10', '2.11', '2.12', '2.13']
PLUGIN_LICENSE = 'GPL-2.0-or-later'
PLUGIN_LICENSE_URL = 'https://www.gnu.org/licenses/gpl-2.0.html'

import fnmatch
import re

from PyQt5 import QtWidgets

from picard import config, log
from picard.file import File, register_file_post_addition_to_track_processor
from picard.ui.options import OptionsPage, register_options_page

KEY = 'genre_tidy_'

DEFAULT_SPELLINGS = '''J-Pop, J-Rock, K-Pop, C-Pop, Mandopop, Cantopop, Anison, VOCALOID, Touhou,
Hip Hop, R&B, Rhythm and Blues, Neo-Soul, Trip Hop, Soul, Funk, Disco,
Electronic, Electronic Dance Music, Electropop, Synth-Pop, Drum and Bass, Dubstep, IDM, Downtempo, Chillout, Lo-Fi, Lo-Fi Hip Hop, House, French House, Techno, Trance, Psy-Trance, Goa Trance, Ambient, Industrial,
Rock, Rock and Roll, Hard Rock, Classic Rock, Alternative Rock, Indie Rock, Psychedelic Rock, Progressive Rock, Progressive Metal, Post-Rock, Post-Punk, Pop Punk, Pop Rock, Punk, Shoegaze, Dream Pop, Space Rock, Symphonic Rock, Folk Rock, Experimental Rock, Heavy Metal, Metal, Nu Metal, Kawaii Metal, Rapcore, New Wave,
Pop, Dance, Dance-Pop, Folk, Indie Folk, Country, Blues, Jazz, Bossa Nova, Reggae, Latin, Celtic, Gospel, New Age, Easy Listening, Experimental, Singer-Songwriter, Chanson,
Classical, Opera, Choral, Orchestral, Chamber Music, Soundtrack, Film Score, Video Game Music, Christmas Music, Church Music, Children's Music, World Music, Comedy, Acoustic'''

DEFAULT_REPLACEMENTS = '''rnb=R&B
r'n'b=R&B
dnb=Drum and Bass
d&b=Drum and Bass
rap=Hip Hop
ost=Soundtrack
original soundtrack=Soundtrack
soundtracks=Soundtrack
score=Film Score
film music=Film Score
game=Video Game Music
game music=Video Game Music
vgm=Video Game Music
anime song=Anison
anime songs=Anison
anisong=Anison
electronica=Electronic
psych=Psychedelic Rock
psychedelic=Psychedelic Rock
prog=Progressive Rock
progressive=Progressive Rock
singer/songwriter=Singer-Songwriter
christmas=Christmas Music
xmas=Christmas Music
chamber=Chamber Music
chanson française=Chanson
folk, world, & country=Folk
other='''

DEFAULT_KEEP_MUSIC = "Chamber Music, Christmas Music, Church Music, Children's Music, Video Game Music, World Music, Electronic Dance Music"

SMALL = {'a', 'an', 'and', 'as', 'at', 'by', 'de', 'des', 'du', 'et', 'for', 'from', 'in', 'la', 'le', 'les', 'n', 'of', 'on', 'or', 'the', 'to', 'with', 'y'}
UPPER = {'r&b', 'rnb', 'idm', 'edm', 'ebm', 'uk', 'us', 'usa', 'dj', 'mc', 'ost', 'vgm', 'dnb', 'lgbt', 'j', 'k', 'c', 'acg', 'nwobhm', 'ii', 'iii', 'iv'}


def setting(name):
    return config.setting[KEY + name]


def split_list(text):
    return [p.strip() for p in re.split(r'[,\n]+', text or '') if p.strip()]


def loose(name):
    """What two spellings of one genre have in common: letters and digits,
    '&' read as 'and', any trailing 'music' dropped."""
    s = name.casefold().replace('&', ' and ').replace("'n'", ' and ').replace(' n ', ' and ')
    s = re.sub(r'[^0-9a-zÀ-￿]+', '', s)
    return s[:-5] if s.endswith('music') and len(s) > 5 else s


def smart_title(name):
    words = re.split(r'(\s+|-|/)', name)
    out = []
    for i, w in enumerate(words):
        low = w.lower()
        if not w.strip() or w in ('-', '/'):
            out.append(w)
        elif low in UPPER:
            out.append(w.upper() if low != 'r&b' else 'R&B')
        elif i and low in SMALL:
            out.append(low)
        elif w[:1].isalpha() and w == w.lower():
            out.append(w[:1].upper() + w[1:])
        else:
            out.append(w)  # already has capitals of its own (VOCALOID, iDOL)
    return ''.join(out)


class Rules:
    """The settings, compiled (refreshed whenever they change)."""

    sig = None

    @classmethod
    def get(cls):
        sig = tuple(setting(k) for k in ('spellings', 'replacements', 'regex', 'strip_music', 'keep_music', 'capitalise'))
        if sig != cls.sig:
            cls.sig = sig
            cls.spell = {loose(s): s for s in split_list(setting('spellings'))}
            cls.keep = {s.casefold() for s in split_list(setting('keep_music'))}
            cls.pairs = []
            for line in (setting('replacements') or '').splitlines():
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                src, dst = (p.strip() for p in line.split('=', 1))
                try:
                    pattern = re.compile(src if setting('regex') else fnmatch.translate(src), re.IGNORECASE)
                except re.error as e:
                    log.error('%s: bad pattern %r: %s', PLUGIN_NAME, src, e)
                    continue
                cls.pairs.append((pattern, dst))
        return cls


def tidy_one(name, rules):
    name = ' '.join(name.split())
    if not name:
        return ''
    for pattern, dst in rules.pairs:
        m = pattern.fullmatch(name)
        if m:
            name = m.expand(dst).strip() if setting('regex') else dst
            break
    if not name:
        return ''
    # A spelling given for it ("jpop" -> "J-Pop", "Rock Music" -> "Rock").
    hit = rules.spell.get(loose(name))
    if hit:
        return hit
    if setting('strip_music') and name.casefold() not in rules.keep:
        stripped = re.sub(r'\s+music$', '', name, flags=re.IGNORECASE)
        if stripped and stripped != name:
            name = rules.spell.get(loose(stripped), stripped)
    return smart_title(name) if setting('capitalise') else name


def tidy(file):
    try:
        if not setting('active'):
            return
    except KeyError:
        return
    md = file.metadata
    values = md.getall('genre')
    if not values:
        return
    rules = Rules.get()
    join = config.setting['join_genres'] or ''
    parts = []
    for v in values:
        parts.extend(v.split(join) if join and join in v else [v])
    if setting('split'):
        # Not genres with a slash of their own ("Singer/Songwriter"), nor any
        # whole value a spelling or replacement already covers.
        def whole(v):
            return loose(v) in rules.spell or any(p.fullmatch(v.strip()) for p, _ in rules.pairs)
        parts = [p for v in parts for p in ([v] if whole(v) else re.split(r'\s*[;/]\s*', v))]
    out, seen = [], set()
    for p in parts:
        g = tidy_one(p, rules)
        if g and loose(g) not in seen:
            seen.add(loose(g))
            out.append(g)
    new = [join.join(out)] if join and out else out
    if new != values:
        if new:
            md['genre'] = new
        else:
            md.delete('genre')


# --- hooks: just before saving, and whenever a file gets a track's metadata ---

_save = File.save
_copy_metadata = File.copy_metadata


def save(self):
    try:
        tidy(self)
    except Exception as e:  # never stop a save because of this plugin
        log.error('%s: %r', PLUGIN_NAME, e)
    return _save(self)


def copy_metadata(self, metadata, *args, **kwargs):
    result = _copy_metadata(self, metadata, *args, **kwargs)
    try:
        tidy(self)
    except Exception as e:
        log.error('%s: %r', PLUGIN_NAME, e)
    return result


def on_added_to_track(track, file):
    tidy(file)
    file.update(signal=True)


File.save = save
File.copy_metadata = copy_metadata
register_file_post_addition_to_track_processor(on_added_to_track)


# --- options ------------------------------------------------------------------

class GenreTidyOptions(OptionsPage):
    NAME = 'genre_tidy'
    TITLE = 'Genre Tidy'
    PARENT = 'plugins'

    options = [
        config.BoolOption('setting', KEY + 'active', True),
        config.TextOption('setting', KEY + 'spellings', DEFAULT_SPELLINGS),
        config.TextOption('setting', KEY + 'replacements', DEFAULT_REPLACEMENTS),
        config.BoolOption('setting', KEY + 'regex', False),
        config.BoolOption('setting', KEY + 'strip_music', True),
        config.TextOption('setting', KEY + 'keep_music', DEFAULT_KEEP_MUSIC),
        config.BoolOption('setting', KEY + 'capitalise', True),
        config.BoolOption('setting', KEY + 'split', True),
    ]

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QtWidgets.QVBoxLayout(self)
        self.active = QtWidgets.QCheckBox('Tidy genres when saving')
        layout.addWidget(self.active)
        layout.addWidget(QtWidgets.QLabel('<b>Spellings</b>: how each genre is written. A genre that differs only in capitals, spaces, hyphens, &amp;/and or a trailing "music" is written this way.'))
        self.spellings = QtWidgets.QPlainTextEdit()
        layout.addWidget(self.spellings, 2)
        layout.addWidget(QtWidgets.QLabel('<b>Replacements</b>: one <i>from=to</i> per line, first match wins (* and ? are wildcards; empty <i>to</i> removes the genre; # starts a comment).'))
        self.replacements = QtWidgets.QPlainTextEdit()
        layout.addWidget(self.replacements, 2)
        self.regex = QtWidgets.QCheckBox('Replacements are regular expressions (to may use \\1, \\2 …)')
        layout.addWidget(self.regex)
        self.strip_music = QtWidgets.QCheckBox('Remove a trailing " music" ("Rock Music" → "Rock"), except:')
        layout.addWidget(self.strip_music)
        self.keep_music = QtWidgets.QLineEdit()
        layout.addWidget(self.keep_music)
        self.capitalise = QtWidgets.QCheckBox('Capitalise other genres ("dream pop" → "Dream Pop", keeping R&B, IDM, "and")')
        layout.addWidget(self.capitalise)
        self.split = QtWidgets.QCheckBox('Split genres written as one ("Pop; Rock", "Pop/Rock")')
        layout.addWidget(self.split)
        self.active.toggled.connect(self.update_enabled)

    def update_enabled(self, on):
        for w in (self.spellings, self.replacements, self.regex, self.strip_music, self.keep_music, self.capitalise, self.split):
            w.setEnabled(on)

    def load(self):
        self.active.setChecked(setting('active'))
        self.spellings.setPlainText(setting('spellings'))
        self.replacements.setPlainText(setting('replacements'))
        self.regex.setChecked(setting('regex'))
        self.strip_music.setChecked(setting('strip_music'))
        self.keep_music.setText(setting('keep_music'))
        self.capitalise.setChecked(setting('capitalise'))
        self.split.setChecked(setting('split'))
        self.update_enabled(self.active.isChecked())

    def save(self):
        config.setting[KEY + 'active'] = self.active.isChecked()
        config.setting[KEY + 'spellings'] = self.spellings.toPlainText()
        config.setting[KEY + 'replacements'] = self.replacements.toPlainText()
        config.setting[KEY + 'regex'] = self.regex.isChecked()
        config.setting[KEY + 'strip_music'] = self.strip_music.isChecked()
        config.setting[KEY + 'keep_music'] = self.keep_music.text()
        config.setting[KEY + 'capitalise'] = self.capitalise.isChecked()
        config.setting[KEY + 'split'] = self.split.isChecked()


register_options_page(GenreTidyOptions)
