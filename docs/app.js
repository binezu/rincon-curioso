'use strict';
// ---------------------------------------------------------------- estado (en el cel + en GitHub: estado/vistos.json, estado/bajadas.json)
const POR_PAG = 12;
const $ = (s, el = document) => el.querySelector(s);
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const repo = (() => {
  const u = ls.get('repo', null);
  if (u) return u;
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  return m ? { owner: m[1], name: location.pathname.split('/')[1] || '' } : { owner: '', name: '' };
})();
let vistos = ls.get('vistos', {});      // id -> segundos
let bajadas = ls.get('bajadas', {});    // id -> {t, m}
let tengo = ls.get('tengo', {});        // id -> segundos  ("ya la tengo": no la baja la PC, no vuelve a salir)
let pendiente = ls.get('pendiente', false);
const D = { indice: null, parati: null, comentar: null, meses: {} };

function aviso(txt, ms = 3500) {
  const a = $('#aviso'); a.textContent = txt; a.hidden = false;
  clearTimeout(aviso.t); if (ms) aviso.t = setTimeout(() => (a.hidden = true), ms);
}
async function json(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}

// ---- GitHub
const b64 = s => btoa(unescape(encodeURIComponent(s)));
const unb64 = s => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));
function gh(path, opt = {}) {
  const token = ls.get('token', '');
  const h = { Accept: 'application/vnd.github+json' };
  if (token) h.Authorization = 'Bearer ' + token;
  return fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`, { ...opt, headers: { ...h, ...(opt.headers || {}) }, cache: 'no-store' });
}
async function leerRemoto(path) {
  const r = await gh(path);
  if (r.status === 404) return { data: {}, sha: null };
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json();
  return { data: JSON.parse(unb64(j.content) || '{}'), sha: j.sha };
}
function juntar(a, b) {
  const o = { ...a };
  for (const k in b) if (!(k in o)) o[k] = b[k];
  return o;
}

async function sincronizar(silencio = false) {
  if (!repo.owner || !repo.name) return;
  const token = ls.get('token', '');
  try {
    for (const [nom, get, set] of [['vistos', () => vistos, v => (vistos = v)], ['bajadas', () => bajadas, v => (bajadas = v)],
                                   ['tengo', () => tengo, v => (tengo = v)]]) {
      for (let intento = 0; intento < 4; intento++) {
        const { data, sha } = await leerRemoto(`estado/${nom}.json`);
        const todo = juntar(get(), data); set(todo); ls.set(nom, todo);
        if (!token || Object.keys(todo).every(k => JSON.stringify(todo[k]) === JSON.stringify(data[k]))) break;
        const r = await gh(`estado/${nom}.json`, { method: 'PUT', body: JSON.stringify({
          message: `cel: ${nom}`, content: b64(JSON.stringify(todo)), ...(sha ? { sha } : {}) }) });
        if (r.ok) break;
        if (r.status === 401 || r.status === 403) throw new Error('el token no sirve (revisa ⚙)');
      }
    }
    pendiente = false; ls.set('pendiente', false);
    if (!silencio) aviso(token ? '✓ guardado en GitHub' : 'Sin token: lo que veas solo se guarda en este cel (⚙)');
  } catch (e) {
    pendiente = true; ls.set('pendiente', true);
    if (!silencio) aviso('No se pudo guardar en GitHub: ' + e.message + '. Se reintenta luego.', 6000);
  }
}
function marcarVistos(ids) {
  const t = Math.floor(Date.now() / 1000);
  for (const id of ids) if (!vistos[id]) vistos[id] = t;
  ls.set('vistos', vistos); pendiente = true; ls.set('pendiente', true);
  sincronizar(true);
}

// ---------------------------------------------------------------- apartar (la PC la baja en tamaño completo al sincronizar)
function apartar(btn, p) {
  bajadas[p.i] = { t: Math.floor(Date.now() / 1000), m: p.m }; ls.set('bajadas', bajadas);
  btn.textContent = '⭐ apartada'; btn.className = 'ok'; btn.disabled = true;
  sincronizar(true);
}

// ---------------------------------------------------------------- gusto actualizado por el reentreno en la nube
let G = null;
async function cargarGusto() {
  try { G = await json('data/gusto.json'); } catch (e) { G = { g: {}, q: {} }; }
}
const conG = ps => {
  if (G) for (const p of ps) { if (G.g[p.i] != null) p.g = G.g[p.i]; if (G.q[p.i] != null) p.q = G.q[p.i]; }
  return ps;
};

// ---------------------------------------------------------------- aviso de reentreno (GitHub Actions)
let corria = false;
async function revisarEntreno() {
  if (!repo.owner || document.hidden) return;
  try {
    const h = { Accept: 'application/vnd.github+json' }; const t = ls.get('token', ''); if (t) h.Authorization = 'Bearer ' + t;
    const r = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/actions/workflows/publicar.yml/runs?per_page=1`, { headers: h, cache: 'no-store' });
    if (!r.ok) return;
    const run = (await r.json()).workflow_runs?.[0];
    const activo = run && run.status !== 'completed';
    const a = $('#aviso');
    if (activo) { a.textContent = '⏳ Reentrenando el modelo con lo que viste… (3–5 min)'; a.hidden = false; a.onclick = null; }
    else if (corria && run.conclusion === 'success') {
      a.textContent = '✓ Modelo actualizado — toca aquí para ver las nuevas'; a.hidden = false;
      a.onclick = () => { a.hidden = true; D.parati = D.comentar = null; D.meses = {}; cargarGusto().then(() => ir($('#tabs .on').dataset.v)); };
    } else if (corria) a.hidden = true;
    corria = activo;
  } catch (e) {}
}
setInterval(revisarEntreno, ls.get('token', '') ? 30000 : 120000);

// ---------------------------------------------------------------- tarjetas y paginas
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function tarjeta(p, { duda = false, cita = false } = {}) {
  const el = document.createElement('div'); el.className = 'c'; el.dataset.id = p.i;
  // ❤ 94 = le gusta mas que el 94% de todos los posts (lo mismo que en las paginas de la PC)
  const g = p.q != null ? '❤ ' + Math.round(p.q * 100) : p.g != null ? '❤ ~' + Math.round(p.g * 100) : '';
  el.innerHTML = `
    <a class="im" href="${esc(p.l)}" target="_blank" rel="noopener"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(p.p)}" alt=""></a>
    <div class="tx">${esc(p.t)}</div>
    <div class="meta"><span>${esc(p.m)} · #${p.r}</span><span>▲ ${p.s.toLocaleString('es')}</span><span>${g}</span>
      ${duda ? '<span class="tag">🤔 duda</span>' : ''}${p.nuevo ? '<span class="tag nuevo">nuevo</span>' : ''}</div>
    ${(cita || duda === false) && p.o ? `<div class="ob">“${esc(p.o)}” <b>${p.on} de ${p.op}</b></div>` : ''}
    <div class="acc"><button class="bj">⭐ la quiero</button><a href="${esc(p.l)}" target="_blank" rel="noopener">reddit</a></div>`;
  const b = $('.bj', el);
  if (bajadas[p.i]) { b.textContent = '⭐ apartada'; b.className = 'ok'; b.disabled = true; }
  else b.onclick = () => apartar(b, p);
  if (tengo[p.i]) { b.textContent = '✓ ya la tienes'; b.className = 'ok'; b.disabled = true; }
  // presionar un rato (cel) o clic derecho (PC) -> menu "ya la tengo"
  el.addEventListener('contextmenu', e => { e.preventDefault(); menuTengo(e.clientX, e.clientY, p, el); });
  let tm = null;
  el.addEventListener('touchstart', e => { const t = e.touches[0]; tm = setTimeout(() => { tm = null; menuTengo(t.clientX, t.clientY, p, el); }, 550); }, { passive: true });
  for (const ev of ['touchend', 'touchmove', 'touchcancel']) el.addEventListener(ev, () => { if (tm) clearTimeout(tm); tm = null; }, { passive: true });
  $('img', el).onerror = function () { this.replaceWith(Object.assign(document.createElement('div'), { className: 'cargando', textContent: 'sin vista previa' })); };
  return el;
}
function menuTengo(x, y, p, el) {
  $('#menu')?.remove();
  const m = document.createElement('div'); m.id = 'menu'; m.className = 'menu';
  const ya = !!tengo[p.i];
  m.innerHTML = `<button>${ya ? '↩ quitar “ya la tengo”' : '✓ ya la tengo'}</button><button class="sec">cancelar</button>`;
  m.style.left = Math.min(x, innerWidth - 210) + 'px'; m.style.top = Math.min(y, innerHeight - 110) + 'px';
  document.body.append(m);
  const cerrar = () => { m.remove(); removeEventListener('scroll', cerrar); };
  m.children[1].onclick = cerrar;
  m.children[0].onclick = () => {
    cerrar();
    if (ya) { tengo[p.i] = 0; ls.set('tengo', tengo); sincronizar(true); aviso('Listo, ya no está marcada'); el.style.opacity = ''; return; }
    tengo[p.i] = Math.floor(Date.now() / 1000); ls.set('tengo', tengo);
    const b = $('.bj', el); b.textContent = '✓ ya la tienes'; b.className = 'ok'; b.disabled = true; el.style.opacity = '.45';
    aviso('✓ Marcada como “ya la tengo”: no vuelve a salir y el modelo aprende que sí te gusta ese tipo');
    sincronizar(true);
  };
  setTimeout(() => addEventListener('scroll', cerrar, { once: true }), 50);
}
function paginado(cont, lista, opciones = {}) {
  // lista: [{p, duda}]  -> paginas de 12; "ya las vi, siguiente" marca la pagina como vista
  let pag = 0;
  const grid = document.createElement('div'); grid.className = 'grid';
  const pager = document.createElement('div'); pager.className = 'pager';
  cont.append(grid, pager);
  const total = () => Math.max(1, Math.ceil(lista.length / POR_PAG));
  function pintar() {
    grid.innerHTML = '';
    const trozo = lista.slice(pag * POR_PAG, (pag + 1) * POR_PAG);
    for (const x of trozo) grid.append(tarjeta(x.p, { duda: x.duda, cita: opciones.cita }));
    pager.innerHTML = '';
    const atras = Object.assign(document.createElement('button'), { className: 'sec', textContent: '← atrás', disabled: pag === 0 });
    atras.onclick = () => { pag--; pintar(); scrollTo(0, 0); };
    const sig = Object.assign(document.createElement('button'), { textContent: 'ya las vi, siguiente →', disabled: !trozo.length });
    sig.onclick = () => { if (opciones.marcar !== false) marcarVistos(trozo.map(x => x.p.i)); pag++; pintar(); scrollTo(0, 0); };
    const n = Object.assign(document.createElement('span'), { className: 'info', textContent: `página ${pag + 1} de ${total()}` });
    pager.append(atras, n, sig);
    if (!trozo.length) grid.innerHTML = '<p class="cargando">¡Ya viste todo! 🎉</p>';
  }
  pintar();
}
const libre = p => !p.h && !bajadas[p.i] && !vistos[p.i] && !tengo[p.i];

// ---------------------------------------------------------------- vistas
const V = {
  async parati(c) {
    D.parati = D.parati || await json('data/para_ti.json');
    const seg = conG(D.parati.seguros.filter(libre)).sort((a, b) => b.g - a.g);
    const dud = conG(D.parati.dudas.filter(libre)).sort((a, b) => Math.abs(a.g - 0.5) - Math.abs(b.g - 0.5));
    const lista = []; let i = 0, j = 0;
    while (lista.length < 1200 && (i < seg.length || j < dud.length)) {
      for (let k = 0; k < 3 && i < seg.length; k++) lista.push({ p: seg[i++] });
      if (j < dud.length) lista.push({ p: dud[j++], duda: true });
    }
    c.innerHTML = `<p class="info">Lo que el modelo cree que más te gusta (1 de cada 4 🤔 es una donde duda: tu decisión le enseña más).
      Quedan ${seg.length.toLocaleString('es')} sin ver.</p>`;
    paginado(c, lista);
  },
  async comentar(c) {
    D.comentar = D.comentar || await json('data/comentar.json');
    const lista = D.comentar.filter(libre).map(p => ({ p }));
    c.innerHTML = '<p class="info">Posts donde mucha gente distinta dijo lo mismo: el “comentario obvio” sale abajo (cuántas personas de las que comentaron).</p>';
    paginado(c, lista, { cita: true });
  },
  async meses(c) {
    D.indice = D.indice || await json('data/indice.json');
    const filas = D.indice.meses.slice().reverse().map(m => {
      const pc = m.n100 ? Math.round(100 * m.h100 / m.n100) : 0;
      return `<tr class="mes" data-m="${m.m}"><td><b>${m.m}</b>${m.robot ? ' <span class="tag nuevo">nuevo</span>' : ''}</td>
        <td>${m.h100}/${m.n100}<div class="bar"><i style="width:${pc}%"></i></div></td><td>${m.estilo}</td></tr>`;
    }).join('');
    c.innerHTML = `<p class="info">Cuántos tienes de los 100 más votados de cada mes y cuántos “muy tu estilo” (❤ 90 o más) te faltan. Toca un mes.</p>
      <table><tr><th>Mes</th><th>Tienes (top 100)</th><th>Muy tu estilo</th></tr>${filas}</table>`;
    c.querySelectorAll('tr.mes').forEach(tr => (tr.onclick = () => abrirMes(tr.dataset.m)));
  },
  async bajadas(c) {
    const ids = Object.keys(bajadas).sort((a, b) => bajadas[b].t - bajadas[a].t);
    c.innerHTML = `<p class="info">⭐ ${ids.length} apartadas (las más nuevas primero). La PC las baja en tamaño completo a not_done_nuevas cuando sincronizas.</p>`;
    const porMes = {};
    for (const id of ids) (porMes[bajadas[id].m] = porMes[bajadas[id].m] || []).push(id);
    const lista = [];
    for (const m of Object.keys(porMes)) {
      if (!D.meses[m]) try { D.meses[m] = await json(`data/meses/${m}.json`); } catch (e) { D.meses[m] = []; }
    }
    for (const id of ids) { const p = (D.meses[bajadas[id].m] || []).find(x => x.i === id); if (p) lista.push({ p }); }
    paginado(c, lista, { marcar: false });
  },
  async ajustes(c) {
    D.indice = D.indice || await json('data/indice.json').catch(() => ({}));
    c.innerHTML = `<div class="ajustes">
      <p class="info">Datos de la PC: ${esc(D.indice.actualizado || '?')} · robot mensual: ${esc(D.indice.robot || 'todavía no corre')} ·
        ${Object.keys(vistos).length.toLocaleString('es')} vistas · ${Object.keys(bajadas).length} bajadas ${pendiente ? '· ⏳ falta guardar en GitHub' : ''}</p>
      <label>Token de GitHub (para que lo que veas y bajes se guarde y la PC lo vea)</label>
      <input id="tok" type="password" placeholder="github_pat_…" value="${esc(ls.get('token', ''))}" autocomplete="off">
      <button class="b" id="guardar">Guardar y sincronizar</button>
      <label>Repositorio</label>
      <input id="rep" value="${esc(repo.owner + '/' + repo.name)}">
      <label>Cómo va el modelo</label><pre>${esc(D.indice.eval || '')}</pre></div>`;
    $('#guardar', c).onclick = async () => {
      ls.set('token', $('#tok', c).value.trim());
      const [o, n] = $('#rep', c).value.trim().split('/'); if (o && n) { repo.owner = o; repo.name = n; ls.set('repo', repo); }
      await sincronizar();
    };
  },
};
async function abrirMes(m) {
  const c = $('#vista');
  c.innerHTML = '<p class="cargando">Cargando…</p>';
  D.meses[m] = D.meses[m] || conG(await json(`data/meses/${m}.json`));
  let orden = 'gusto';
  const pintar = () => {
    const ps = D.meses[m].filter(p => !p.h && !bajadas[p.i]);
    ps.sort(orden === 'gusto' ? (a, b) => (b.g || 0) - (a.g || 0) : (a, b) => a.r - b.r);
    c.innerHTML = `<p class="info"><a href="#" id="volver">← meses</a> · <b>${m}</b>: ${ps.length} que no tienes</p>
      <div class="seg"><button data-o="gusto">por tu estilo</button><button data-o="votos">por votos</button></div>`;
    c.querySelectorAll('.seg button').forEach(b => { b.classList.toggle('on', b.dataset.o === orden); b.onclick = () => { orden = b.dataset.o; pintar(); }; });
    $('#volver', c).onclick = e => { e.preventDefault(); ir('meses'); };
    paginado(c, ps.map(p => ({ p })));
  };
  pintar();
}
async function ir(v) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  const c = $('#vista'); c.innerHTML = '<p class="cargando">Cargando…</p>'; scrollTo(0, 0);
  try { await V[v](c); } catch (e) { c.innerHTML = `<p class="cargando">No se pudo cargar (${esc(e.message)}).</p>`; }
}
document.querySelectorAll('#tabs button').forEach(b => (b.onclick = () => ir(b.dataset.v)));
$('#nuevo').href = `https://github.com/${repo.owner}/${repo.name}/actions/workflows/mensual.yml`;
cargarGusto().then(() => ir('parati'));
revisarEntreno();
{ const antes = Object.keys(vistos).length + Object.keys(bajadas).length;
  sincronizar(true).then(() => {   // si la PC u otro aparato marco cosas, rehacer la lista
    if (Object.keys(vistos).length + Object.keys(bajadas).length !== antes && $('#tabs .on').dataset.v === 'parati') ir('parati'); }); }
if (!ls.get('token', '')) setTimeout(() => aviso('Tip: pon tu token en ⚙ para que lo que veas se guarde en GitHub y la PC lo vea.', 6000), 1500);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
