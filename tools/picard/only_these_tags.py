PLUGIN_NAME = 'Only These Tags'
PLUGIN_AUTHOR = 'Steven'
PLUGIN_DESCRIPTION = '''
While enabled, Picard writes <b>only the tags you list</b> (Options &gt; Plugins
&gt; Only These Tags). Every other tag in the file is left exactly as it was,
whatever Picard's other settings say: "Clear existing tags", tagger scripts,
other plugins and MusicBrainz data can't change them.
<br><br>
Tag names are Picard's (genre, mood, albumartist, musicbrainz_albumid …),
one per line or comma separated; * and ? work as wildcards (musicbrainz_*,
lyrics:*). "coverart" in the list lets Picard change the embedded cover art;
without it the file keeps the art it has.
<br><br>
Optionally it also keeps files where they are (no renaming or moving) and
stops cover art files being saved, so a pass changes nothing but those tags.
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

KEY = 'only_these_tags_'
DEFAULT_TAGS = 'genre'


def setting(name):
    return config.setting[KEY + name]


def active():
    try:
        return bool(setting('active'))
    except KeyError:
        return False


def patterns():
    text = setting('tags') or ''
    return [p.strip().lower() for p in re.split(r'[,\n;]+', text) if p.strip()]


def allowed(name, pats):
    name = name.lower().rstrip(':')
    return any(fnmatch.fnmatchcase(name, p) for p in pats)


def restrict(file, saving=False):
    """Put every tag the list doesn't allow back to what the file has."""
    if not active():
        return
    pats = patterns()
    new, old = file.metadata, file.orig_metadata
    # Tags Picard would set or change: back to the file's own value (or gone,
    # when the file never had them). Hidden ~ variables aren't tags.
    for name in list(new):
        if name.startswith('~') or allowed(name, pats):
            continue
        if name in old:
            new[name] = old.getall(name)
        else:
            new.unset(name)
    # Tags Picard would remove ("Clear existing tags", $delete, other
    # plugins): kept.
    for name in list(old):
        if name.startswith('~') or allowed(name, pats):
            continue
        if name not in new:
            new[name] = old.getall(name)
    for name in list(new.deleted_tags):
        if not allowed(name, pats):
            new.deleted_tags.discard(name)
    # Embedded cover art: unchanged unless "coverart" is in the list.
    if not allowed('coverart', pats) and new.images != old.images:
        new.images = old.images.copy()
    # Saving without "Clear existing tags": leave those tags out altogether,
    # so they aren't even rewritten (Picard would store some under its own
    # names, e.g. a Vorbis COMMENT as DESCRIPTION). With it on, they must be
    # written back, or Picard would clear them.
    if saving and not config.setting['clear_existing_tags']:
        for name in list(new):
            if not name.startswith('~') and not allowed(name, pats) and new.getall(name) == old.getall(name):
                new.unset(name)


# --- hooks ----------------------------------------------------------------

def on_added_to_track(track, file):
    # As soon as a file is matched, so the tag view shows what will be saved.
    restrict(file)
    file.update(signal=True)


register_file_post_addition_to_track_processor(on_added_to_track)

# And just before every save, whatever changed the file's metadata since
# (album reloads, edits, scripts): the last word.
_save = File.save
_copy_metadata = File.copy_metadata
_rename = File._rename
_save_images = File._save_images
_move_additional = File._move_additional_files


def save(self):
    try:
        restrict(self, saving=True)
    except Exception as e:  # never stop a save because of this plugin
        log.error('%s: %r', PLUGIN_NAME, e)
    return _save(self)


def copy_metadata(self, metadata, *args, **kwargs):
    result = _copy_metadata(self, metadata, *args, **kwargs)
    try:
        if self.parent is not None and getattr(self.parent, 'album', None) is not None:
            restrict(self)
    except Exception as e:
        log.error('%s: %r', PLUGIN_NAME, e)
    return result


def rename(self, old_filename, metadata, settings=None):
    if active() and setting('keep_place'):
        return old_filename
    return _rename(self, old_filename, metadata, settings)


def save_images(self, dirname, metadata):
    if active() and setting('no_art_files'):
        return
    return _save_images(self, dirname, metadata)


def move_additional(self, old_filename, new_filename, cfg):
    if active() and setting('keep_place'):
        return
    return _move_additional(self, old_filename, new_filename, cfg)


File.save = save
File.copy_metadata = copy_metadata
File._rename = rename
File._save_images = save_images
File._move_additional_files = move_additional


# --- options ----------------------------------------------------------------

class OnlyTheseTagsOptions(OptionsPage):
    NAME = 'only_these_tags'
    TITLE = 'Only These Tags'
    PARENT = 'plugins'

    options = [
        config.BoolOption('setting', KEY + 'active', True),
        config.TextOption('setting', KEY + 'tags', DEFAULT_TAGS),
        config.BoolOption('setting', KEY + 'keep_place', True),
        config.BoolOption('setting', KEY + 'no_art_files', True),
    ]

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QtWidgets.QVBoxLayout(self)
        self.active = QtWidgets.QCheckBox('Write only the tags listed below (all other tags stay as they are)')
        layout.addWidget(self.active)
        layout.addWidget(QtWidgets.QLabel('Tags to write, one per line or comma separated. * and ? are wildcards (e.g. musicbrainz_*). Add "coverart" to allow changing embedded cover art.'))
        self.tags = QtWidgets.QPlainTextEdit()
        self.tags.setPlaceholderText('genre\nmood\nmusicbrainz_*')
        layout.addWidget(self.tags, 1)
        quick = QtWidgets.QHBoxLayout()
        quick.addWidget(QtWidgets.QLabel('Add:'))
        for label, value in [('Genre', 'genre'), ('Mood', 'mood'), ('MusicBrainz IDs', 'musicbrainz_*'), ('Language versions', '*_orig, *_en, *_rom'), ('Cover art', 'coverart')]:
            button = QtWidgets.QPushButton(label)
            button.clicked.connect(lambda _=False, v=value: self.add(v))
            quick.addWidget(button)
        quick.addStretch(1)
        layout.addLayout(quick)
        self.keep_place = QtWidgets.QCheckBox("Don't rename or move files (whatever File Naming says)")
        self.no_art_files = QtWidgets.QCheckBox("Don't save cover art files (whatever Cover Art says)")
        layout.addWidget(self.keep_place)
        layout.addWidget(self.no_art_files)
        self.active.toggled.connect(self.update_enabled)

    def add(self, value):
        have = [p.strip() for p in re.split(r'[,\n;]+', self.tags.toPlainText()) if p.strip()]
        for v in [x.strip() for x in value.split(',')]:
            if v.lower() not in (h.lower() for h in have):
                have.append(v)
        self.tags.setPlainText('\n'.join(have))

    def update_enabled(self, on):
        for w in (self.tags, self.keep_place, self.no_art_files):
            w.setEnabled(on)

    def load(self):
        self.active.setChecked(setting('active'))
        self.tags.setPlainText('\n'.join(p.strip() for p in re.split(r'[,\n;]+', setting('tags') or '') if p.strip()))
        self.keep_place.setChecked(setting('keep_place'))
        self.no_art_files.setChecked(setting('no_art_files'))
        self.update_enabled(self.active.isChecked())

    def save(self):
        config.setting[KEY + 'active'] = self.active.isChecked()
        config.setting[KEY + 'tags'] = ', '.join(p.strip() for p in re.split(r'[,\n;]+', self.tags.toPlainText()) if p.strip())
        config.setting[KEY + 'keep_place'] = self.keep_place.isChecked()
        config.setting[KEY + 'no_art_files'] = self.no_art_files.isChecked()


register_options_page(OnlyTheseTagsOptions)
