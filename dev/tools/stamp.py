"""Stamp index.html with content hashes so WebView2 never runs stale files.

WebView2 caches the theme's files, and ES modules import each other by plain
relative paths, so an updated module can be skipped in favour of a cached copy.
This writes an import map that points every module at `file.js?v=<hash>`, and
adds the same `?v=` to the stylesheets and the entry script. Only changed files
get new URLs, so unchanged ones still come from the cache.

Run before packaging a release:  python dev/tools/stamp.py
"""
import hashlib, json, pathlib, re

root = pathlib.Path(__file__).resolve().parents[2]
index = root / 'index.html'
html = index.read_text(encoding='utf-8')

def h(path):
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]

imports = {}
for js in sorted((root / 'js').rglob('*.js')):
    rel = js.relative_to(root).as_posix()
    imports['/' + rel] = f'/{rel}?v={h(js)}'
block = '<script type="importmap">\n' + json.dumps({'imports': imports}, indent=2) + '\n</script>'

if '<script type="importmap">' in html:
    html = re.sub(r'<script type="importmap">.*?</script>', lambda m: block, html, flags=re.S)
else:
    html = html.replace('<link rel="stylesheet"', block + '\n  <link rel="stylesheet"', 1)

html = re.sub(r'href="(css/[^"?]+)(\?v=[^"]*)?"', lambda m: f'href="{m.group(1)}?v={h(root / m.group(1))}"', html)
html = re.sub(r'src="/?(js/main\.js)(\?v=[^"]*)?"', lambda m: f'src="/{m.group(1)}?v={h(root / m.group(1))}"', html)
index.write_text(html, encoding='utf-8')
print(f'stamped {len(imports)} modules')
