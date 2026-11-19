"""Build the release downloads into dist/:

  fusion-<version>.zip        the theme: a fusion/ folder to drop into
                              <foobar2000 profile>\\webview-ui\\, plus
                              install.bat/install.ps1 (install/), which do it;
                              includes the artist info script
  fusion-tools-<version>.zip  the artist/genre information script

(The Picard plugins have their own repo and releases:
https://github.com/FooThemes/PicardPlugins)

The version comes from js/version.js. index.html is stamped first (see
stamp.py) so WebView2 never mixes cached old files with new ones.

    python dev/tools/release.py
"""
import pathlib
import re
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
DIST = ROOT / 'dist'


def version():
    m = re.search(r"VERSION = '([^']+)'", (ROOT / 'js' / 'version.js').read_text(encoding='utf-8'))
    if not m:
        sys.exit('No VERSION in js/version.js')
    return m.group(1)


def add_tree(z, src, arc):
    for p in sorted(src.rglob('*')):
        if p.is_file() and '__pycache__' not in p.parts:
            z.write(p, f'{arc}/{p.relative_to(src).as_posix()}')


def main():
    v = version()
    DIST.mkdir(exist_ok=True)
    subprocess.run([sys.executable, '-I', str(ROOT / 'dev' / 'tools' / 'stamp.py')], check=True)

    theme = DIST / f'fusion-{v}.zip'
    with zipfile.ZipFile(theme, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT / 'index.html', 'fusion/index.html')
        add_tree(z, ROOT / 'css', 'fusion/css')
        add_tree(z, ROOT / 'js', 'fusion/js')
        z.write(ROOT / 'LICENSE', 'fusion/LICENSE')
        z.write(ROOT / 'README.md', 'fusion/README.md')
        # The artist/genre information script, where Fusion looks for it
        # (data/artistscript.js), so it works without setting its path.
        z.write(ROOT / 'tools' / 'fusion-artist-info.py', 'fusion/tools/artist-info/fusion-artist-info.py')
        # Windows line endings for the installer, whatever git checked out.
        for name in ('install.bat', 'install.ps1'):
            text = (ROOT / 'install' / name).read_text(encoding='utf-8')
            z.writestr(name, text.replace('\r\n', '\n').replace('\n', '\r\n'))

    tools = DIST / f'fusion-tools-{v}.zip'
    with zipfile.ZipFile(tools, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT / 'tools' / 'fusion-artist-info.py', 'artist-info/fusion-artist-info.py')
        z.write(ROOT / 'LICENSE', 'LICENSE')

    for f in (theme, tools):
        print(f'{f.relative_to(ROOT)}  {f.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
