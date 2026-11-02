"""Build dev/api-params.json from the foo_ui_webview2 docs (docs/vitepress/api/*.md).

Usage: python extract-api.py <path-to-foo_ui_webview2>/docs/vitepress/api > ../api-params.json
Maps every method to its top-level parameter names, so the dev mock can reject
calls with parameters the real host would refuse (it rejects undeclared ones).
"""
import json, os, re, sys

root = sys.argv[1]
out = {}
for name in sorted(os.listdir(root)):
    if not name.endswith('.md'):
        continue
    text = open(os.path.join(root, name), encoding='utf-8').read()
    for m in re.finditer(r'<!-- api-schema:begin ([a-zA-Z0-9]+\.[a-zA-Z0-9]+) -->(.*?)<!-- api-schema:end -->', text, re.S):
        method, body = m.group(1), m.group(2)
        params = []
        if '| Parameter |' in body:
            table = body.split('| Parameter |', 1)[1].split('**Returns**', 1)[0]
            for row in re.finditer(r'^\| `([A-Za-z0-9_]+)` \|', table, re.M):
                params.append(row.group(1))
        out[method] = sorted(set(params))
json.dump(out, sys.stdout, indent=0, sort_keys=True)
