"""Narzedzie do oznaczania tekstow kluczami tlumaczen (i18n) w plikach stron.

    python scripts/i18n_tag.py plik.html spec.json

spec.json - lista operacji:
  ["text", "Oryginalny tekst", "klucz"]        - element z dokladnie tym tekstem dostaje data-i18n
  ["html", "unikalny fragment tagu", "klucz"]  - element (tekst z odnosnikami) dostaje data-i18n-html
  ["attr", "placeholder", "Wartosc", "klucz"]  - atrybut tlumaczony przez data-i18n-attr
  ["js", "Tekst w skrypcie", "klucz"]          - '...'/"..." w skrypcie -> i18n.t('klucz')

Zapisuje z koncami linii LF (jak na serwerze). Wypisuje operacje, ktorych nie udalo sie wykonac.
"""
import json
import re
import sys
from pathlib import Path


def add_attr(tag, name, value):
    """Dodaje atrybut do tagu otwierajacego (albo dopisuje do istniejacego data-i18n-attr)."""
    if name == 'data-i18n-attr' and 'data-i18n-attr="' in tag:
        return tag.replace('data-i18n-attr="', f'data-i18n-attr="{value};', 1)
    if f'{name}="' in tag:
        return tag
    end = len(tag) - (2 if tag.endswith('/>') else 1)
    return tag[:end].rstrip() + f' {name}="{value}"' + tag[end:]


def op_text(s, original, key):
    pat = re.compile(r'(<[a-zA-Z][^<>]*>)(\s*)' + re.escape(original) + r'(\s*)(?=</)')
    n = 0

    def repl(m):
        nonlocal n
        n += 1
        return add_attr(m.group(1), 'data-i18n', key) + m.group(2) + original + m.group(3)
    return pat.sub(repl, s), n


def op_html(s, fragment, key):
    i = s.find(fragment)
    if i < 0:
        return s, 0
    start = s.rfind('<', 0, i + 1)
    end = s.find('>', i)
    tag = s[start:end + 1]
    return s[:start] + add_attr(tag, 'data-i18n-html', key) + s[end + 1:], 1


def op_attr(s, attr, value, key):
    pat = re.compile(r'<[a-zA-Z][^<>]*\b' + re.escape(attr) + r'="' + re.escape(value) + r'"[^<>]*>')
    n = 0

    def repl(m):
        nonlocal n
        n += 1
        return add_attr(m.group(0), 'data-i18n-attr', f'{attr}:{key}')
    return pat.sub(repl, s), n


def op_js(s, text, key):
    """Podmienia napis tylko wewnatrz skryptow (<script>...</script> albo caly plik .js),
    nigdy w atrybutach HTML."""
    n = 0

    def fix(code):
        nonlocal n
        for q in ("'", '"', '`'):
            lit = q + text + q
            if lit in code:
                n += code.count(lit)
                code = code.replace(lit, f"i18n.t('{key}')")
        return code
    if not re.search(r'<html|<script', s, re.I):
        return fix(s), n
    s = re.sub(r'(<script(?![^>]*src=)[^>]*>)(.*?)(</script>)',
               lambda m: m.group(1) + fix(m.group(2)) + m.group(3), s, flags=re.S | re.I)
    return s, n


OPS = {'text': op_text, 'html': op_html, 'attr': op_attr, 'js': op_js}


def main():
    path = Path(sys.argv[1])
    spec = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    s = path.read_bytes().decode('utf-8')
    missed = []
    for op in spec:
        s, n = OPS[op[0]](s, *op[1:])
        if n == 0:
            missed.append(op)
    path.write_bytes(s.encode('utf-8'))
    print(f'{path.name}: {len(spec) - len(missed)}/{len(spec)} operacji')
    for op in missed:
        print('  NIE ZNALEZIONO:', op)


if __name__ == '__main__':
    main()
