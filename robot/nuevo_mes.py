# -*- coding: utf-8 -*-
"""Robot mensual (corre en GitHub Actions, sin GPU): agrega a la app los meses nuevos de r/mildlyinteresting.
  1. baja de Arctic Shift los posts del mes (score >= 100, sin nsfw) y se queda con los 250 de mas votos
  2. vista previa de cada uno -> SigLIP2 (imagen + titulo) + DINOv2 -> el modelo exportado de la PC -> "que tanto te gusta"
  3. comentarios -> "comentario obvio" (misma idea que 18_comentarios.py en la PC)
  4. escribe docs/data/meses/AAAA-MM.json y actualiza indice / para_ti / comentar
Uso: python robot/nuevo_mes.py [AAAA-MM ...]     (sin argumentos: todos los meses completos que falten)
"""
import os, re, sys, io, json, glob, html, math, time, datetime as dt, collections, urllib.request, urllib.error
import numpy as np

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(AQUI, 'docs', 'data')
API = 'https://arctic-shift.photon-reddit.com/api/'
UA = {'User-Agent': 'Mozilla/5.0 mildly-app-robot/1.0'}
TOP = 250
BOTS = re.compile(r'(?i)^(automoderator|\[deleted\]|.*bot)$')


def log(*a):
    print(*a, flush=True)


def get_json(url, intentos=8):
    espera = 5
    for _ in range(intentos):
        try:
            time.sleep(0.5)
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                d = json.loads(r.read().decode('utf-8'))
            if d.get('error'):
                raise RuntimeError(d['error'])
            return d['data']
        except Exception as e:
            log('  reintento', url[:90], e)
            time.sleep(espera); espera = min(espera * 2, 120)
    raise RuntimeError('fallo: ' + url)


def lee(rel, defecto):
    f = os.path.join(AQUI, rel)
    if os.path.exists(f):
        with open(f, encoding='utf-8') as fh:
            return json.load(fh)
    return defecto


def escribe(rel, obj):
    f = os.path.join(AQUI, rel)
    os.makedirs(os.path.dirname(f), exist_ok=True)
    with open(f, 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(',', ':'))


# ---------------------------------------------------------------- posts del mes
def posts_mes(m):
    y, mo = map(int, m.split('-'))
    a0 = int(dt.datetime(y, mo, 1, tzinfo=dt.timezone.utc).timestamp())
    b0 = int(dt.datetime(y + (mo == 12), mo % 12 + 1, 1, tzinfo=dt.timezone.utc).timestamp())
    keep = []
    for a in range(a0, b0, 86400):
        b = min(a + 86400, b0)
        while True:
            data = get_json('%sposts/search?subreddit=mildlyinteresting&after=%d&before=%d&limit=auto&sort=desc'
                            '&fields=id,created_utc,score,title,url,over_18,num_comments' % (API, a, b))
            if not data:
                break
            for p in data:
                if (p.get('score') or 0) >= 100 and not p.get('over_18'):
                    keep.append({'id': p['id'], 's': p['score'], 'title': p.get('title', ''), 'url': p.get('url', ''),
                                 'nc': p.get('num_comments', 0)})
            nb = min(p['created_utc'] for p in data)
            if nb <= a or nb >= b:
                break
            b = nb
    vistos = set(); top = []
    for p in sorted(keep, key=lambda p: -p['s']):
        if p['id'] not in vistos:
            vistos.add(p['id']); top.append(p)
    return top[:TOP]


def elegir_preview(p):
    def mejor(res):
        res = [r for r in res if r.get('u') or r.get('url')]
        if not res:
            return ''
        r = next((x for x in res if (x.get('x') or x.get('width') or 0) >= 640), res[-1])
        return html.unescape(r.get('u') or r.get('url'))
    tipo = 'video' if p.get('is_video') else ('galeria' if p.get('is_gallery') else 'imagen')
    try:
        if p.get('is_gallery') and p.get('media_metadata'):
            orden = [g['media_id'] for g in (p.get('gallery_data') or {}).get('items', [])] or list(p['media_metadata'])
            mm = p['media_metadata'][orden[0]]
            return mejor(mm.get('p', [])) or html.unescape(mm.get('s', {}).get('u', '')), tipo
        return mejor(p['preview']['images'][0]['resolutions']), tipo
    except Exception:
        u = p.get('url', '')
        if u.startswith('https://i.redd.it/') or u.lower().endswith(('.jpg', '.jpeg', '.png')):
            return u, tipo
        return '', tipo


def completar(top):
    full = {}
    for k in range(0, len(top), 100):
        for q in get_json(API + 'posts/ids?ids=' + ','.join(p['id'] for p in top[k:k + 100])):
            full[q['id']] = q
    for rank, p in enumerate(top, 1):
        q = full.get(p['id'], {})
        p['rank'] = rank
        p['prev'], p['tipo'] = elegir_preview(q)
        p['link'] = 'https://www.reddit.com' + (q.get('permalink') or '/comments/' + p['id'])
        p['removed'] = q.get('removed_by_category')
    return top


def bajar_img(url):
    from PIL import Image
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                data = r.read(); final = r.geturl()
            if len(data) < 500 or 'removed' in final:
                return None
            return Image.open(io.BytesIO(data)).convert('RGB')
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                return None
            time.sleep(3)
        except Exception:
            time.sleep(3)
    return None


# ---------------------------------------------------------------- caracteristicas (igual que en la PC)
class Modelos:
    def __init__(self):
        import torch
        from transformers import AutoModel, AutoProcessor
        self.torch = torch
        torch.set_num_threads(max(1, os.cpu_count() or 2))
        self.sg = AutoModel.from_pretrained('google/siglip2-base-patch16-224').eval()
        self.sp = AutoProcessor.from_pretrained('google/siglip2-base-patch16-224')
        self.dn = AutoModel.from_pretrained('facebook/dinov2-base').eval()

    @staticmethod
    def _f(out):
        import torch
        if isinstance(out, torch.Tensor):
            return out
        return out.pooler_output if getattr(out, 'pooler_output', None) is not None else out[0]

    def vec(self, ims, titulos):
        import cv2
        torch = self.torch; F = torch.nn.functional
        with torch.no_grad():
            xi = self.sp(images=ims, return_tensors='pt')
            vi = F.normalize(self._f(self.sg.get_image_features(pixel_values=xi['pixel_values'])).float(), dim=-1)
            xt = self.sp(text=titulos, padding='max_length', max_length=64, truncation=True, return_tensors='pt')
            vt = F.normalize(self._f(self.sg.get_text_features(input_ids=xt['input_ids'])).float(), dim=-1)
            mean = np.array([0.485, 0.456, 0.406], np.float32); std = np.array([0.229, 0.224, 0.225], np.float32)
            b = np.stack([((cv2.resize(np.asarray(im), (224, 224), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0 - mean) / std)
                          .transpose(2, 0, 1) for im in ims])
            o = self.dn(pixel_values=torch.from_numpy(b)).last_hidden_state
            vd = F.normalize(torch.cat([o[:, 0], o[:, 1:].mean(1)], 1).float(), dim=1)
        return vi.numpy(), vt.numpy(), vd.numpy()


def calificar(posts, mods):
    z = np.load(os.path.join(AQUI, 'modelo', 'modelo.npz'))
    ok = []; ims = []
    for k, p in enumerate(posts):
        im = bajar_img(p['prev']) if p['prev'] else None
        if im is not None and im.size[0] > 20 and im.size[1] > 20:
            ok.append(p); ims.append(im)
        if k % 50 == 0:
            log('  vistas previas %d / %d' % (k, len(posts)))
    V = []
    for k in range(0, len(ok), 16):
        V.append(mods.vec(ims[k:k + 16], [p['title'] for p in ok[k:k + 16]]))
    vi = np.concatenate([v[0] for v in V]); vt = np.concatenate([v[1] for v in V]); vd = np.concatenate([v[2] for v in V])
    d = np.array([math.log1p(p['nc'] or 0) - math.log1p(p['s']) for p in ok]); dz = (d - d.mean()) / (d.std() + 1e-6)
    meta = np.array([[math.log1p(p['s']), p['rank'] / 250.0, math.log1p(p['nc'] or 0), q] for p, q in zip(ok, dz)], np.float32)
    X = np.hstack([vi, vt, vd, meta])
    s = ((X - z['mean']) / z['scale']) @ z['coef'] + z['b'][0]
    for p, v in zip(ok, 1 / (1 + np.exp(-s))):
        p['g'] = round(float(v), 4)
    return ok


# ---------------------------------------------------------------- comentarios
def comentarios(p, st, norm):
    from sklearn.cluster import AgglomerativeClustering
    cs = []; after = None
    for _ in range(3):
        d = get_json(API + 'comments/search?link_id=%s&limit=100&sort=asc' % p['id'] + ('&after=%d' % after if after else ''), 4)
        cs += [[c.get('author'), str(c.get('parent_id', '')).startswith('t3_'), (c.get('body') or '')[:400], c.get('controversiality') or 0] for c in d]
        if len(d) < 100:
            break
        after = int(d[-1]['created_utc'])
    cs = [c for c in cs if c[0] and not BOTS.match(c[0])]
    if len(cs) < 8:
        return
    aut = collections.Counter(c[0] for c in cs)
    vistos = set(); tl = []
    for c in cs:
        if c[1] and len(c[2].strip()) >= 3 and c[2] not in ('[removed]', '[deleted]') and c[0] not in vistos:
            vistos.add(c[0]); tl.append(c)
    if len(tl) < 6:
        return
    E = st.encode(['query: ' + c[2][:300] for c in tl], batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    lab = AgglomerativeClustering(n_clusters=None, metric='cosine', linkage='average', distance_threshold=0.14).fit_predict(E)
    l, tam = collections.Counter(lab).most_common(1)[0]
    if tam < 2:
        return
    i = np.where(lab == l)[0]; j = i[np.argmax(E[i] @ E[i].mean(0))]
    max_share = aut.most_common(1)[0][1] / len(cs); frac_top = sum(1 for c in cs if c[1]) / len(cs)
    contro = sum(c[3] for c in cs) / len(cs)
    conv = tam / len(tl); ganas = math.log1p(len(tl)) - math.log1p(p['s'])
    pelea = max(0, max_share - 0.08) * 6 + max(0, 0.45 - frac_top) * 3 + contro * 4
    ce = (conv - norm['conv_mu']) / norm['conv_sd'] + 0.6 * (ganas - norm['ganas_mu']) / norm['ganas_sd'] - pelea - (1.0 if len(tl) < 10 else 0)
    p['o'] = tl[j][2].replace('\n', ' ')[:200]; p['on'] = int(tam); p['op'] = len(tl); p['ce'] = round(float(ce), 2)


# ---------------------------------------------------------------- juntar
def meses_faltantes():
    hechos = {os.path.basename(f)[:7] for f in glob.glob(os.path.join(DATA, 'meses', '*.json'))}
    hoy = dt.date.today()
    # Arctic Shift tarda unos dias en tener todo: un mes se procesa a partir del dia 4 del mes siguiente
    ult = dt.date(hoy.year, hoy.month, 1) - dt.timedelta(days=1 if hoy.day >= 4 else 32)
    m = max(hechos) if hechos else '2026-10'
    out = []
    y, mo = map(int, m.split('-'))
    while True:
        mo += 1
        if mo == 13:
            y += 1; mo = 1
        if (y, mo) > (ult.year, ult.month):
            break
        out.append('%04d-%02d' % (y, mo))
    return out


def actualizar_listas(nuevos):
    baj = lee('estado/bajadas.json', {})
    pt = lee('docs/data/para_ti.json', {'seguros': [], 'dudas': []})
    todos = {d['i']: d for d in pt['seguros'] + pt['dudas']}
    for d in nuevos:
        if not d['h'] and 'g' in d:
            todos[d['i']] = d
    libres = [d for d in todos.values() if d['i'] not in baj]
    seg = sorted(libres, key=lambda d: -d['g'])[:3000]; ya = {d['i'] for d in seg}
    dud = sorted((d for d in libres if d['i'] not in ya), key=lambda d: abs(d['g'] - 0.5))[:600]
    escribe('docs/data/para_ti.json', {'seguros': seg, 'dudas': dud})
    com = {d['i']: d for d in lee('docs/data/comentar.json', [])}
    for d in nuevos:
        if 'ce' in d and not d['h']:
            com[d['i']] = d
    escribe('docs/data/comentar.json', sorted(com.values(), key=lambda d: -d['ce'])[:800])


def main():
    meses = sys.argv[1:] or meses_faltantes()
    if not meses:
        log('no hay meses nuevos'); return
    log('meses a procesar:', meses)
    mods = Modelos()
    from sentence_transformers import SentenceTransformer
    st = SentenceTransformer('intfloat/multilingual-e5-small', device='cpu')
    norm = lee('modelo/coment_norm.json', {'conv_mu': 0.1, 'conv_sd': 0.07, 'ganas_mu': -4.5, 'ganas_sd': 0.8})
    baj = lee('estado/bajadas.json', {})
    ind = lee('docs/data/indice.json', {'meses': []})
    for m in meses:
        log('== %s' % m)
        top = completar(posts_mes(m))
        log('  %d posts top' % len(top))
        ok = calificar(top, mods)
        log('  calificados %d' % len(ok))
        for k, p in enumerate(ok):
            try:
                comentarios(p, st, norm)
            except Exception as e:
                log('  comentarios', p['id'], e)
            if k % 50 == 0:
                log('  comentarios %d / %d' % (k, len(ok)))
        ds = []
        for p in ok:
            d = {'i': p['id'], 'm': m, 'r': p['rank'], 's': p['s'], 'c': p['nc'] or 0, 't': p['title'], 'p': p['prev'],
                 'u': p['url'], 'l': p['link'], 'k': p['tipo'], 'h': int(p['id'] in baj), 'g': p['g'], 'nuevo': 1}
            for k in ('o', 'on', 'op', 'ce'):
                if k in p:
                    d[k] = p[k]
            ds.append(d)
        escribe('docs/data/meses/%s.json' % m, ds)
        t100 = [d for d in ds if d['r'] <= 100]
        ind['meses'] = [x for x in ind['meses'] if x['m'] != m] + [{
            'm': m, 'n': len(ds), 'h100': sum(d['h'] for d in t100), 'n100': len(t100), 'h': sum(d['h'] for d in ds),
            'estilo': sum(1 for d in ds if not d['h'] and d['g'] >= 0.7), 'robot': 1}]
        ind['meses'].sort(key=lambda x: x['m'])
        ind['robot'] = dt.datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')
        escribe('docs/data/indice.json', ind)
        actualizar_listas(ds)
    log('listo')


if __name__ == '__main__':
    main()
