# -*- coding: utf-8 -*-
"""Reentreno en la nube (GitHub Actions, sin GPU; ~1-2 min).  Misma receta que 17_gusto.py en la PC:
  etiquetas historicas y de "hoy" (huellas/etiquetas.json, las calcula la PC)
  + apartadas en el cel o la PC (estado/bajadas.json) = positivo
  + vistas sin apartar hace mas de 20 min (estado/vistos.json) = negativo        (las de ahora pesan x3)
Salida (NO se guarda en el repositorio, solo se publica): docs/data/gusto.json, para_ti.json, indice.json
"""
import os, json, glob, time
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(AQUI, 'docs', 'data')
VISTO_MIN = 20


def lee(rel, d):
    f = os.path.join(AQUI, rel)
    if os.path.exists(f):
        with open(f, encoding='utf-8') as fh:
            return json.load(fh)
    return d


def escribe(rel, obj):
    with open(os.path.join(AQUI, rel), 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(',', ':'))


def main():
    t0 = time.time()
    ids = []; Xs = []
    for f in sorted(glob.glob(os.path.join(AQUI, 'huellas', '*.npz'))):
        z = np.load(f, allow_pickle=True); ids += z['ids'].tolist(); Xs.append(z['X'])
    X = np.concatenate(Xs).astype(np.float32); pos = {i: k for k, i in enumerate(ids)}
    et = lee('huellas/etiquetas.json', {})
    baj = lee('estado/bajadas.json', {}); vis = lee('estado/vistos.json', {})
    ahora = time.time()
    lab = {}; y = {}
    for i, (l, v) in et.items():
        lab[i] = l; y[i] = v
    for i in baj:
        if lab.get(i) != 'hoy':
            lab[i] = 'baja'
        y[i] = 1
    for i, t in vis.items():
        if i not in baj and i not in lab and ahora - t > VISTO_MIN * 60:
            lab[i] = 'visto'; y[i] = 0
    L = [i for i in lab if i in pos]
    H = [i for i in L if lab[i] == 'hist']
    sc = StandardScaler().fit(X[[pos[i] for i in H]])
    C = float(np.load(os.path.join(AQUI, 'modelo', 'modelo.npz'))['C'])
    w = np.array([3.0 if lab[i] in ('hoy', 'baja', 'visto') else 1.0 for i in L])
    clf = LogisticRegression(C=C, max_iter=3000, class_weight='balanced').fit(sc.transform(X[[pos[i] for i in L]]), [y[i] for i in L], sample_weight=w)
    P = clf.predict_proba(sc.transform(X))[:, 1]
    G = {i: round(float(p), 4) for i, p in zip(ids, P)}
    escribe('docs/data/gusto.json', G)
    cnt = {k: sum(1 for i in L if lab[i] == k) for k in ('hist', 'hoy', 'baja', 'visto')}
    print('entrenado con %d (%s) en %.0f s' % (len(L), cnt, time.time() - t0))

    # listas con el gusto nuevo
    libres = []; ind = lee('docs/data/indice.json', {'meses': []}); est = {}
    for f in glob.glob(os.path.join(DATA, 'meses', '*.json')):
        for d in json.load(open(f, encoding='utf-8')):
            if d['i'] in G:
                d['g'] = G[d['i']]
            if not d['h'] and d['i'] not in baj and 'g' in d:
                libres.append(d)
                est[d['m']] = est.get(d['m'], 0) + (d['g'] >= 0.7)
    seg = sorted(libres, key=lambda d: -d['g'])[:3000]; ya = {d['i'] for d in seg}
    dud = sorted((d for d in libres if d['i'] not in ya and d['i'] not in vis), key=lambda d: abs(d['g'] - 0.5))[:600]
    escribe('docs/data/para_ti.json', {'seguros': seg, 'dudas': dud})
    for m in ind['meses']:
        m['estilo'] = est.get(m['m'], 0)
    ind['entreno'] = time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())
    ind['etiquetas'] = cnt
    escribe('docs/data/indice.json', ind)


if __name__ == '__main__':
    main()
