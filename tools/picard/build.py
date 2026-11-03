"""Build dist/language_variants.zip, the file to install in Picard
(Options > Plugins > Install plugin...).

The zip holds the plugin package and, in language_variants/vendor/, the
libraries it uses for romanisation: pykakasi (GPL-3.0-or-later) and its
dependency jaconv (MIT) for Japanese, pypinyin (MIT) for Chinese. They are
downloaded from PyPI at the pinned versions below and only unpacked, never
run here. pykakasi's other dependency, `deprecated`, is only used for
warnings on old APIs, so a two-line stand-in is bundled instead.

    python build.py
"""

import io
import os
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = 'language_variants'
PINNED = ['pykakasi==2.3.0', 'jaconv==0.5.0', 'pypinyin==0.55.0']
KEEP = ('pykakasi/', 'jaconv/', 'pypinyin/')
LICENCES = ('COPYING', 'LICENSE', 'LICENSE.txt', 'AUTHORS')
DEPRECATED_SHIM = '''"""Stand-in for the `deprecated` package (pykakasi only uses it for
warnings on its old API, which this plugin doesn't call)."""


def deprecated(*args, **kwargs):
    if args and callable(args[0]):
        return args[0]
    return lambda f: f
'''


def main():
    out_dir = os.path.join(HERE, 'dist')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, PACKAGE + '.zip')
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.check_call([sys.executable, '-m', 'pip', 'download', '--no-deps', '-q', '-d', tmp] + PINNED)
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for name in sorted(os.listdir(os.path.join(HERE, PACKAGE))):
                path = os.path.join(HERE, PACKAGE, name)
                if name.endswith('.py'):
                    z.write(path, f'{PACKAGE}/{name}')
            for wheel in sorted(os.listdir(tmp)):
                with zipfile.ZipFile(os.path.join(tmp, wheel)) as w:
                    for info in w.infolist():
                        n = info.filename
                        if n.startswith(KEEP) and '/__pycache__/' not in n and not n.endswith('/'):
                            z.writestr(f'{PACKAGE}/vendor/{n}', w.read(n))
                        elif '.dist-info/' in n and n.rsplit('/', 1)[-1] in LICENCES:
                            lib = n.split('-')[0]
                            z.writestr(f'{PACKAGE}/vendor/licences/{lib}-{n.rsplit("/", 1)[-1]}', w.read(n))
            z.writestr(f'{PACKAGE}/vendor/deprecated.py', DEPRECATED_SHIM)
    print(out, os.path.getsize(out) // 1024, 'KB')


if __name__ == '__main__':
    main()
