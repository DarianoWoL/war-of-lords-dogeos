"""Wstawia Regulamin i Polityke Prywatnosci (PL + EN) z dokumenty-prawne/zrodla/ do stron Serwisu.

    python scripts/build_legal.py

Zrodlo prawdy: dokumenty-prawne/zrodla/{regulamin,polityka}.{pl,en}.html. Na stronie obie wersje
jezykowe sa w dokumencie, widoczna jest ta zgodna z wybranym jezykiem (przelacznik EN | PL).
Dane Uslugodawcy: w tresci tylko e-mail, pelne dane na koncu strony w zwijanej sekcji (<details>).
Wersje do wysylki (PDF/DOCX z pelnymi danymi): dokumenty-prawne/wersja-PL-*/ (eksport z przegladarki Edge).
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'dokumenty-prawne' / 'zrodla'
PUB = ROOT / 'public'

PROVIDER = {
    'name': 'Ilona Dobrowolska',
    'address': 'Rzeczyca Księża 227, 23-230 RZECZYCA KSIĘŻA',
    'email': 'support@waroflords.pl',
}
MAIL = f'<a href="mailto:{PROVIDER["email"]}" style="color:#e8c766;">{PROVIDER["email"]}</a>'

LABELS = {
    'regulamin': {
        'pl': {'contact': 'Adres e-mail (kontakt / reklamacje)', 'full': 'Pełne dane Usługodawcy', 'summary': 'Dane Usługodawcy',
               'who': 'Usługodawca', 'addr': 'Adres siedziby / do doręczeń'},
        'en': {'contact': 'E-mail address (contact / complaints)', 'full': 'Full Service Provider details', 'summary': 'Service Provider details',
               'who': 'Service Provider', 'addr': 'Registered / correspondence address'},
    },
    'polityka': {
        'pl': {'contact': 'Adres e-mail w sprawach danych osobowych', 'full': 'Pełne dane Administratora', 'summary': 'Dane Administratora danych osobowych',
               'who': 'Administrator danych osobowych', 'addr': 'Adres do korespondencji'},
        'en': {'contact': 'E-mail address for personal data matters', 'full': 'Full controller details', 'summary': 'Data controller details',
               'who': 'Data controller', 'addr': 'Correspondence address'},
    },
}
MORE = {'pl': 'na końcu strony (rozwiń)', 'en': 'at the end of the page (expand)'}
EMAIL_LABEL = {'pl': 'Adres e-mail', 'en': 'E-mail address'}
DETAILS_ID = {'pl': 'dane-uslugodawcy', 'en': 'provider-details'}


def short_box(doc, lang):
    l = LABELS[doc][lang]
    return (f'<div class="legal-provider-box">\n'
            f'                <div class="legal-label">{l["contact"]}</div>\n'
            f'                <div class="legal-value">{MAIL}</div>\n'
            f'                <div class="legal-label" style="margin-top:12px;">{l["full"]}</div>\n'
            f'                <div class="legal-value"><a href="#{DETAILS_ID[lang]}" style="color:#e8c766;">{MORE[lang]}</a></div>\n'
            f'            </div>')


def details(doc, lang):
    l = LABELS[doc][lang]
    return (f'\n        <details class="legal-provider-details" id="{DETAILS_ID[lang]}">\n'
            f'            <summary>{l["summary"]}</summary>\n'
            f'            <div class="legal-provider-box">\n'
            f'                <div class="legal-label">{l["who"]}</div>\n'
            f'                <div class="legal-value">{PROVIDER["name"]}</div>\n'
            f'                <div class="legal-label">{l["addr"]}</div>\n'
            f'                <div class="legal-value">{PROVIDER["address"]}</div>\n'
            f'                <div class="legal-label">{EMAIL_LABEL[lang]}</div>\n'
            f'                <div class="legal-value">{MAIL}</div>\n'
            f'            </div>\n'
            f'        </details>\n')


def doc_html(doc, lang):
    body = (SRC / f'{doc}.{lang}.html').read_text(encoding='utf-8').strip()
    body = body.replace('<div class="legal-provider-box" data-provider="short"></div>', short_box(doc, lang))
    body = '\n'.join(('        ' + line) if line.strip() else '' for line in body.split('\n'))
    return (f'<div class="legal-doc" data-doc-lang="{lang}" lang="{lang}">\n{body}\n{details(doc, lang)}'
            f'        </div>')


STYLE = ('    <style>html[lang="en"] .legal-doc[data-doc-lang="pl"], html:not([lang="en"]) .legal-doc[data-doc-lang="en"] { display: none; }\n'
         '        .legal-lang-note{margin:0 auto 18px;max-width:900px;padding:12px 16px;border:1px solid #d4af37;border-radius:8px;background:rgba(212,175,55,0.12);color:#f0d78c;font-size:15px;line-height:1.5}\n'
         '        .legal-doc ol[type="a"] { list-style-type: lower-alpha; margin-top: 8px; }</style>\n')

OPEN_SCRIPT = """    <script>
        // Odnosnik "pelne dane" rozwija sekcje z danymi na koncu strony (w biezacej wersji jezykowej).
        document.querySelectorAll('a[href="#dane-uslugodawcy"], a[href="#provider-details"]').forEach((link) => link.addEventListener('click', () => {
            const target = document.getElementById(link.getAttribute('href').slice(1));
            if (target) target.open = true;
        }));
    </script>
"""


def build(page, doc):
    p = PUB / page
    s = p.read_bytes().decode('utf-8')
    inner = '\n        <!-- LEGAL:BEGIN - generowane przez scripts/build_legal.py z dokumenty-prawne/zrodla/ -->\n' \
            + doc_html(doc, 'pl') + '\n' + doc_html(doc, 'en') + '\n        <!-- LEGAL:END -->\n'
    if '<!-- LEGAL:BEGIN' in s:
        s = re.sub(r'\n        <!-- LEGAL:BEGIN.*?<!-- LEGAL:END -->\n', lambda m: inner, s, count=1, flags=re.S)
    else:
        start = s.index('<div class="legal-card">') + len('<div class="legal-card">')
        end = s.index('</details>\n    </div>', start) + len('</details>\n')
        s = s[:start] + inner + s[end:]
        # jezyk strony ustawia przelacznik (bez stalego lang="pl"), style przelaczania wersji
        s = s.replace('<html lang="pl" data-content-lang="pl">', '<html lang="en">', 1)
        s = re.sub(r'    <style>\.legal-lang-note:empty\{display:none\}[^\n]*\n', lambda m: STYLE, s, count=1)
        # stary skrypt rozwijania (tylko #dane-uslugodawcy) -> wersja dla obu jezykow
        s = re.sub(r'    <script>\n        // Odnosnik "pelne dane".*?</script>\n', lambda m: OPEN_SCRIPT, s, count=1, flags=re.S)
    p.write_bytes(s.encode('utf-8'))
    print('ok', page)


if __name__ == '__main__':
    build('regulamin.html', 'regulamin')
    build('polityka-prywatnosci.html', 'polityka')
