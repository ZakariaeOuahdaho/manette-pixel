'use strict';

// Bits des boutons dans le rapport XUSB (identiques côté serveur / pilote).
const BITS = {
  DU: 0x0001, DD: 0x0002, DL: 0x0004, DR: 0x0008, START: 0x0010, BACK: 0x0020,
  LS: 0x0040, RS: 0x0080, LB: 0x0100, RB: 0x0200, GUIDE: 0x0400,
  A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000,
};

const DEFAUTS = {
  taille: 1, opacite: 0.9, zoneMorte: 0.08, course: 1, flottants: true,
  haptique: 8, vibrJeu: true, combos: true, latence: true, disposition: 'xbox', preset: 'normal',
};

const DOUBLE_TAP_MS = 300;      // délai max entre deux tapes pour L3 / R3
const TAPE_MAX_MS = 250;        // une « tape » est un toucher court…
const HEARTBEAT_MS = 150;       // …et l'état est renvoyé au moins à ce rythme
const PING_MS = 2000;
const SILENCE_MAX_MS = 6000;    // sans pong depuis ce délai, la connexion est tenue pour morte
const OUVERTURE_MAX_MS = 4000;

const $ = (s) => document.querySelector(s);
const pad = $('#pad');
const portrait = matchMedia('(orientation: portrait)');

// ---------- Stockage local (peut être indisponible : navigation privée…) ----------

function lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } }
function ecrire(cle, valeur) { try { localStorage.setItem(cle, valeur); } catch { /* sans mémoire, tant pis */ } }

function chargerReglages() {
  let stockes = {};
  try { stockes = JSON.parse(lire('manette.reglages')) || {}; } catch { stockes = {}; }
  const cfg = { ...DEFAUTS };
  for (const cle of Object.keys(DEFAUTS)) {
    if (typeof stockes[cle] === typeof DEFAUTS[cle]) cfg[cle] = stockes[cle];
  }
  return cfg;
}
const cfg = chargerReglages();

// En USB (adb reverse), la page est servie par localhost et le serveur n'exige pas de code.
const estLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

const params = new URLSearchParams(location.search);
const jeton = params.get('k') || lire('manette.jeton') || '';
if (params.get('k')) ecrire('manette.jeton', jeton);

// crypto.randomUUID n'existe qu'en HTTPS ; getRandomValues marche aussi en HTTP.
let clientId = lire('manette.id');
if (!clientId) {
  const octets = new Uint8Array(12);
  crypto.getRandomValues(octets);
  clientId = Array.from(octets, (o) => o.toString(16).padStart(2, '0')).join('');
  ecrire('manette.id', clientId);
}

// ---------- Géométrie : positions des commandes, mesurées depuis le DOM ----------

let geo = null;

function centre(el) {
  const r = el.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, dx: r.width / 2, dy: r.height / 2 };
}

function mesurer() {
  const d = centre(pad.querySelector('[data-dpad]'));
  const sticks = {};
  for (const el of pad.querySelectorAll('[data-stick]')) {
    el.style.transform = '';  // mesurer au repos
    const c = centre(el);
    sticks[el.dataset.stick] = { el, knob: el.querySelector('.knob'), cx: c.cx, cy: c.cy, r: c.dx };
  }
  const zones = {};
  for (const el of pad.querySelectorAll('[data-zone]')) zones[el.dataset.zone] = el.getBoundingClientRect();
  // Un bouton masqué (LT+RT hors mode combat) n'a pas de taille : il ne doit pas capter de toucher.
  const visibles = Array.from(pad.querySelectorAll('[data-btn]')).filter((el) => el.getClientRects().length);
  geo = {
    u: d.dx / 15,  // la croix fait 30 unités de large
    boutons: visibles.map((el) => ({
      el,
      id: el.dataset.btn,
      groupe: el.dataset.groupe || el.dataset.btn,
      rond: el.classList.contains('rond'),
      hit: parseFloat(el.dataset.hit || '1.2'),
      ...centre(el),
    })),
    bras: Array.from(pad.querySelectorAll('[data-dir]')),
    dpad: { cx: d.cx, cy: d.cy, demi: d.dx },
    sticks,
    zones,
  };
  dessinerSticks();
}

// Renvoie les boutons sous le doigt : le plus proche, plus son voisin du même groupe
// quand le doigt est presque à égale distance des deux (appui « entre » A et B).
function boutonsSous(x, y) {
  const touches = [];
  for (const b of geo.boutons) {
    let d;
    if (b.rond) {
      d = Math.hypot(x - b.cx, y - b.cy) / (b.dx * b.hit);
    } else {
      const marge = geo.u * 2;
      d = Math.max(Math.abs(x - b.cx) / (b.dx + marge), Math.abs(y - b.cy) / (b.dy + marge));
    }
    if (d <= 1) touches.push({ b, d });
  }
  if (!touches.length) return null;
  touches.sort((p, q) => p.d - q.d);
  const ids = [touches[0].b.id];
  const second = touches[1];
  if (cfg.combos && second && second.b.groupe === touches[0].b.groupe && second.d - touches[0].d < 0.2) {
    ids.push(second.b.id);
  }
  return ids;
}

// Directions de la croix sous le doigt, -1 si le doigt est hors de la croix (marge comprise).
function dpadSous(x, y, marge) {
  const p = geo.dpad;
  const dx = x - p.cx;
  const dy = y - p.cy;
  const limite = p.demi + marge;
  if (Math.abs(dx) > limite || Math.abs(dy) > limite) return -1;
  const n = Math.hypot(dx, dy);
  if (n < p.demi * 0.2) return 0;  // centre mort
  // Seuil 0.42 (> sin 22,5°) : les diagonales sont un peu plus étroites que les directions pures.
  const ux = dx / n;
  const uy = dy / n;
  let bits = 0;
  if (uy < -0.42) bits |= BITS.DU; else if (uy > 0.42) bits |= BITS.DD;
  if (ux < -0.42) bits |= BITS.DL; else if (ux > 0.42) bits |= BITS.DR;
  return bits;
}

function dansRect(r, x, y) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// ---------- Contacts : chaque doigt posé est soit un « bouton » (qui peut glisser
// d'un bouton à l'autre), soit un joystick (qu'il garde jusqu'au relâcher). ----------

const contacts = new Map();
const sticks = { L: { contact: null, finTape: 0 }, R: { contact: null, finTape: 0 } };

function evaluerBouton(c) {
  const ids = boutonsSous(c.x, c.y);
  if (ids) {
    for (const id of ids) c.vus.add(id);
    c.ids = ids;
    c.dpad = 0;
    c.surDpad = false;
    return;
  }
  c.ids = [];
  // Une fois sur la croix, le pouce peut déborder largement sans la lâcher.
  const d = dpadSous(c.x, c.y, geo.u * (c.surDpad ? 7 : 2));
  c.surDpad = d >= 0;
  c.dpad = Math.max(d, 0);
}

function demarrerStick(cote, x, y, id) {
  const g = geo.sticks[cote];
  const s = sticks[cote];
  const maintenant = performance.now();
  const c = {
    id, type: 'stick', cote, x, y, x0: x, y0: y, t0: maintenant, bouge: 0,
    ox: cfg.flottants ? x : g.cx,
    oy: cfg.flottants ? y : g.cy,
    clic: maintenant - s.finTape < DOUBLE_TAP_MS,
    vx: 0, vy: 0, kx: 0, ky: 0,
  };
  s.contact = c;
  s.finTape = 0;
  bougerStick(c);
  return c;
}

function bougerStick(c) {
  const R = geo.sticks[c.cote].r * cfg.course;
  let dx = c.x - c.ox;
  let dy = c.y - c.oy;
  const m = Math.hypot(dx, dy);
  if (cfg.flottants && m > R) {
    // Le centre suit le pouce : revenir en arrière répond tout de suite.
    c.ox = c.x - (dx / m) * R;
    c.oy = c.y - (dy / m) * R;
    dx = c.x - c.ox;
    dy = c.y - c.oy;
  }
  c.bouge = Math.max(c.bouge, Math.hypot(c.x - c.x0, c.y - c.y0));

  let nx = dx / R;
  let ny = dy / R;
  const n = Math.hypot(nx, ny);
  if (n > 1) { nx /= n; ny /= n; }
  c.kx = nx;
  c.ky = ny;

  // Zone morte radiale, puis remise à l'échelle pour garder toute la plage utile.
  const mag = Math.min(n, 1);
  const zm = cfg.zoneMorte;
  if (mag <= zm) {
    c.vx = 0;
    c.vy = 0;
  } else {
    const k = (mag - zm) / (1 - zm) / mag;
    c.vx = nx * k;
    c.vy = ny * k;
  }
}

function finirStick(c) {
  const s = sticks[c.cote];
  if (s.contact === c) s.contact = null;
  const duree = performance.now() - c.t0;
  const tape = !c.clic && duree < TAPE_MAX_MS && c.bouge < geo.sticks[c.cote].r * 0.35;
  s.finTape = tape ? performance.now() : 0;
}

function oublier(id) {
  const c = contacts.get(id);
  if (!c) return;
  contacts.delete(id);
  if (c.type === 'stick') finirStick(c);
}

pad.addEventListener('pointerdown', (e) => {
  if (edition) { debutGlisse(e); return; }
  if (!actif || e.target.closest('#statut')) return;
  e.preventDefault();
  // Premier doigt posé : tout contact encore connu est un fantôme (relâcher jamais reçu).
  if (e.isPrimary) for (const id of [...contacts.keys()]) oublier(id);

  const x = e.clientX;
  const y = e.clientY;
  let c = null;
  if (!boutonsSous(x, y) && dpadSous(x, y, geo.u * 2) < 0) {
    for (const cote of ['L', 'R']) {
      if (!sticks[cote].contact && dansRect(geo.zones[cote], x, y)) {
        c = demarrerStick(cote, x, y, e.pointerId);
        break;
      }
    }
  }
  if (!c) {
    c = { id: e.pointerId, type: 'bouton', x, y, ids: [], dpad: 0, surDpad: false, vus: new Set(), t0: performance.now() };
    evaluerBouton(c);
  }
  contacts.set(e.pointerId, c);
  maj();
}, { passive: false });

pad.addEventListener('pointermove', (e) => {
  if (edition) { suiteGlisse(e); return; }
  const c = contacts.get(e.pointerId);
  if (!c || (e.pointerType === 'mouse' && e.buttons === 0)) return;  // simple survol
  c.x = e.clientX;
  c.y = e.clientY;
  if (c.type === 'stick') bougerStick(c); else evaluerBouton(c);
  maj();
});

// ---------- Mode combat : dans UFC 4, presque tout est « modificateur tenu + coup ».
// Un seul pouce ne peut pas tenir RB et appuyer sur X : une tape sur un modificateur
// l'arme, et il reste appuyé jusqu'à ce que le coup suivant soit relâché. ----------

const MODIFICATEURS = ['LB', 'RB', 'LT'];
const FRAPPES = ['A', 'B', 'X', 'Y'];
const armes = new Set();

// Renvoie vrai si les modificateurs armés ont changé.
function verrouiller(c) {
  if ([...c.vus].some((id) => FRAPPES.includes(id))) {
    const avant = armes.size;
    armes.clear();  // le coup est parti avec ses modificateurs
    return avant > 0;
  }
  const [seul] = c.vus;
  if (c.vus.size === 1 && MODIFICATEURS.includes(seul) && performance.now() - c.t0 < TAPE_MAX_MS) {
    if (armes.has(seul)) armes.delete(seul); else armes.add(seul);  // une 2e tape désarme
    return true;
  }
  return false;
}

function relacherContact(e) {
  if (edition) { finGlisse(e); return; }
  const c = contacts.get(e.pointerId);
  if (!c) return;
  const change = c.type === 'bouton' && combat() && verrouiller(c);
  oublier(e.pointerId);
  maj(change);  // armer LB ne change pas l'état envoyé (il était déjà appuyé) : redessiner quand même
}
pad.addEventListener('pointerup', relacherContact);
pad.addEventListener('pointercancel', relacherContact);

function relacherTout() {
  contacts.clear();
  armes.clear();
  for (const s of Object.values(sticks)) { s.contact = null; s.finTape = 0; }
  maj();
}

// ---------- État de la manette ----------

let etat = { boutons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };

function axe(v) {
  return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
}

function calculer() {
  let boutons = 0;
  let lt = 0;
  let rt = 0;
  const v = { L: [0, 0], R: [0, 0] };
  for (const c of contacts.values()) {
    if (c.type === 'stick') {
      v[c.cote] = [c.vx, c.vy];
      if (c.clic) boutons |= c.cote === 'L' ? BITS.LS : BITS.RS;
    } else {
      boutons |= c.dpad;
      for (const id of c.ids) {
        if (id === 'LT') lt = 255;
        else if (id === 'RT') rt = 255;
        else if (id === 'LTRT') { lt = 255; rt = 255; }
        else boutons |= BITS[id];
      }
    }
  }
  for (const id of armes) {
    if (id === 'LT') lt = 255; else boutons |= BITS[id];
  }
  // À l'écran Y descend ; pour XInput, Y positif = haut.
  return { boutons, lt, rt, lx: axe(v.L[0]), ly: axe(-v.L[1]), rx: axe(v.R[0]), ry: axe(-v.R[1]) };
}

function maj(redessiner = false) {
  const nouveau = calculer();
  const appui = (nouveau.boutons & ~etat.boutons) || (nouveau.lt && !etat.lt) || (nouveau.rt && !etat.rt);
  if (redessiner || nouveau.boutons !== etat.boutons || nouveau.lt !== etat.lt || nouveau.rt !== etat.rt) dessinerBoutons(nouveau);
  etat = nouveau;
  if (appui) vibrerToucher();
  planifierSticks();
  envoyer(false);
}

// ---------- Dessin ----------

function dessinerBoutons(e) {
  if (!geo) return;
  for (const b of geo.boutons) {
    const on = b.id === 'LT' ? e.lt > 0 : b.id === 'RT' ? e.rt > 0
      : b.id === 'LTRT' ? e.lt > 0 && e.rt > 0 : (e.boutons & BITS[b.id]) !== 0;
    b.el.classList.toggle('on', on);
    b.el.classList.toggle('arme', armes.has(b.id));
  }
  for (const el of geo.bras) el.classList.toggle('on', (e.boutons & BITS[el.dataset.dir]) !== 0);
}

let rafSticks = 0;
function planifierSticks() {
  if (!rafSticks) rafSticks = requestAnimationFrame(() => { rafSticks = 0; dessinerSticks(); });
}

function dessinerSticks() {
  if (!geo) return;
  for (const cote of ['L', 'R']) {
    const g = geo.sticks[cote];
    const c = sticks[cote].contact;
    g.el.classList.toggle('actif', !!c);
    g.el.classList.toggle('clic', !!(c && c.clic));
    if (!c) {
      g.el.style.transform = '';
      g.knob.style.transform = '';
      continue;
    }
    const bx = cfg.flottants ? c.ox - g.cx : 0;
    const by = cfg.flottants ? c.oy - g.cy : 0;
    g.el.style.transform = `translate(${bx}px, ${by}px)`;
    const course = g.r * 0.56;  // le pommeau reste dans le cercle
    g.knob.style.transform = `translate(${c.kx * course}px, ${c.ky * course}px)`;
  }
}

// ---------- Réseau ----------

let ws = null;
let pret = false;              // vrai une fois que le serveur a attribué une manette
let essais = 0;
let minuterieReco = null;
let erreurBloquante = false;
let dernierPong = 0;
let dernierEnvoye = '';
let tDernierEnvoi = 0;
const infos = { etat: 'attente', texte: 'Connexion…', manette: null, joueur: null, rtt: null };

const tampon = new ArrayBuffer(13);
const vue = new DataView(tampon);

function envoyer(force) {
  if (!ws || !pret || ws.readyState !== WebSocket.OPEN) return;
  const e = etat;
  const cle = `${e.boutons},${e.lt},${e.rt},${e.lx},${e.ly},${e.rx},${e.ry}`;
  if (!force && cle === dernierEnvoye) return;
  // Réseau engorgé : on saute les simples mouvements de joystick, le prochain envoi portera l'état à jour.
  if (!force && ws.bufferedAmount > 1024 && cle.split(',', 3).join() === dernierEnvoye.split(',', 3).join()) return;
  vue.setUint8(0, 1);
  vue.setUint16(1, e.boutons, true);
  vue.setUint8(3, e.lt);
  vue.setUint8(4, e.rt);
  vue.setInt16(5, e.lx, true);
  vue.setInt16(7, e.ly, true);
  vue.setInt16(9, e.rx, true);
  vue.setInt16(11, e.ry, true);
  try {
    ws.send(tampon.slice(0));
  } catch {
    return;
  }
  dernierEnvoye = cle;
  tDernierEnvoi = performance.now();
}

// L'état complet part régulièrement même sans changement : c'est ce qui prouve au
// serveur que le téléphone est toujours là (sinon il remet la manette au neutre).
setInterval(() => {
  if (performance.now() - tDernierEnvoi > HEARTBEAT_MS) envoyer(true);
}, 50);

setInterval(() => {
  if (!ws || !pret || ws.readyState !== WebSocket.OPEN) return;
  if (performance.now() - dernierPong > SILENCE_MAX_MS) {
    abandonner(ws);
    return;
  }
  ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
}, PING_MS);

function connecter() {
  clearTimeout(minuterieReco);
  minuterieReco = null;
  if (erreurBloquante || ws) return;
  if (!jeton && !estLocal) {
    montrerErreur('Lien incomplet', 'Ouvre cette page en scannant le QR code affiché sur le PC.', false);
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const s = new WebSocket(`${proto}://${location.host}/ws?k=${encodeURIComponent(jeton)}`);
  s.binaryType = 'arraybuffer';
  ws = s;
  pret = false;
  if (infos.etat !== 'ko') statut('attente', 'Connexion…');

  // Un pare-feu qui jette les paquets laisse la connexion « en cours » très longtemps.
  const delai = setTimeout(() => { if (s.readyState === WebSocket.CONNECTING) abandonner(s); }, OUVERTURE_MAX_MS);
  s.onopen = () => {
    clearTimeout(delai);
    s.send(JSON.stringify({ t: 'bonjour', id: clientId }));
  };
  s.onmessage = (m) => { if (s === ws) recevoir(m.data); };
  s.onclose = (ev) => { clearTimeout(delai); perdue(s, ev.code); };
}

// Ferme sans attendre la poignée de main de fermeture (inutile sur une connexion morte).
function abandonner(s) {
  s.onclose = null;
  s.onmessage = null;
  try { s.close(); } catch { /* déjà fermée */ }
  perdue(s, 1006);
}

function perdue(s, code) {
  if (s !== ws) return;
  ws = null;
  pret = false;
  vibrationJeu(0, 0);
  if (code === 4001) {
    montrerErreur('Lien invalide', "Ce lien n'est plus valable. Rescanne le QR code affiché sur le PC.", false);
    return;
  }
  if (code === 4003) {
    montrerErreur('Plus de place', 'Quatre téléphones sont déjà connectés à ce PC.', true);
    return;
  }
  if (code === 4000) {
    montrerErreur('Manette ouverte ailleurs', 'Cette manette a été reprise par un autre onglet ou un autre appareil.', true);
    return;
  }
  essais += 1;
  statut('ko', essais > 4 ? 'PC injoignable' : 'Reconnexion…');
  if (document.visibilityState === 'visible') {
    minuterieReco = setTimeout(connecter, Math.min(3000, 250 * essais));
  }
}

function recevoir(donnees) {
  if (typeof donnees !== 'string') return;
  let m;
  try { m = JSON.parse(donnees); } catch { return; }
  if (m.t === 'bienvenue') {
    pret = true;
    essais = 0;
    dernierPong = performance.now();
    infos.manette = m.manette;
    infos.joueur = m.joueur;
    statut('ok');
    envoyer(true);
  } else if (m.t === 'joueur') {
    infos.joueur = m.joueur;
    majStatut();
  } else if (m.t === 'vibration') {
    vibrationJeu(m.g, m.p);
  } else if (m.t === 'pong') {
    dernierPong = performance.now();
    if (typeof m.ts === 'number') {
      const rtt = performance.now() - m.ts;
      infos.rtt = infos.rtt == null ? rtt : infos.rtt * 0.7 + rtt * 0.3;
    }
    majStatut();
  }
}

// ---------- Pastille d'état ----------

function statut(etatConnexion, texte) {
  infos.etat = etatConnexion;
  if (texte) infos.texte = texte;
  majStatut();
}

function majStatut() {
  const el = $('#statut');
  el.classList.remove('ok', 'ko', 'attente');
  el.classList.add(infos.etat);
  let texte = infos.texte;
  if (infos.etat === 'ok') {
    texte = infos.joueur ? `Joueur ${infos.joueur}` : `Manette ${infos.manette}`;
    if (cfg.latence && infos.rtt != null) texte += ` · ${Math.round(infos.rtt)} ms`;
  }
  $('#statut-texte').textContent = texte;
}

// ---------- Vibrations ----------

let vibJeu = 0;
let minuterieVib = null;

// Chrome refuse de vibrer tant que l'écran n'a jamais été touché.
function vibrer(motif) {
  const autorise = navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
  if (autorise && navigator.vibrate) navigator.vibrate(motif);
}

function vibrerToucher() {
  if (cfg.haptique > 0 && vibJeu < 0.04) vibrer(cfg.haptique);
}

// Le vibreur Android est tout ou rien : l'intensité demandée par le jeu devient
// une proportion de temps vibré sur chaque tranche de 100 ms.
function vibrationJeu(gros, petit) {
  vibJeu = Math.max(gros, petit) / 255;
  if (vibJeu >= 0.04 && cfg.vibrJeu && actif && navigator.vibrate) {
    if (!minuterieVib) {
      tickVibration();
      minuterieVib = setInterval(tickVibration, 100);
    }
  } else {
    arreterVibration();
  }
}

function tickVibration() {
  if (vibJeu < 0.04 || !cfg.vibrJeu || !actif) {
    arreterVibration();
    return;
  }
  vibrer(Math.round(30 + 70 * vibJeu));
}

function arreterVibration() {
  if (!minuterieVib) return;
  clearInterval(minuterieVib);
  minuterieVib = null;
  vibrer(0);
}

// ---------- Activité : la manette n'écoute les doigts que quand rien ne la recouvre ----------

let actif = false;

function recalculerActif() {
  const ok = $('#accueil').hidden && $('#reglages').hidden && $('#erreur').hidden && !edition
    && !portrait.matches && document.visibilityState === 'visible';
  if (ok === actif) return;
  if (ok) {
    mesurer();
    actif = true;
  } else {
    actif = false;
    relacherTout();  // relâche tout et envoie aussitôt l'état neutre
    arreterVibration();
  }
}

function montrerErreur(titre, texte, reessayable) {
  erreurBloquante = true;
  $('#erreur-titre').textContent = titre;
  $('#erreur-texte').textContent = texte;
  $('#reessayer').hidden = !reessayable;
  $('#erreur').hidden = false;
  statut('ko', titre);
  recalculerActif();
}

$('#reessayer').addEventListener('click', () => {
  erreurBloquante = false;
  essais = 0;
  $('#erreur').hidden = true;
  recalculerActif();
  connecter();
});

// ---------- Plein écran et accueil ----------

let veutPleinEcran = false;

async function pleinEcran() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch { /* refusé ou non supporté : on joue quand même */ }
  try {
    await screen.orientation.lock('landscape');
  } catch { /* le verrouillage n'existe qu'en plein écran sur Android */ }
  veutPleinEcran = !!document.fullscreenElement;
}

// Garde l'écran allumé (seulement en contexte sûr : localhost en USB, ou HTTPS).
let verrouEcran = null;
async function garderEcranAllume() {
  if (!('wakeLock' in navigator) || verrouEcran || document.visibilityState !== 'visible') return;
  try {
    verrouEcran = await navigator.wakeLock.request('screen');
    verrouEcran.addEventListener('release', () => { verrouEcran = null; });
  } catch { /* refusé (batterie faible…) : l'écran s'éteindra comme d'habitude */ }
}

let historiquePiege = false;

$('#jouer').addEventListener('click', () => {
  // Pas d'await : un plein écran qui ne répond jamais ne doit pas bloquer la manette.
  pleinEcran();
  garderEcranAllume();
  // Le geste « retour » d'Android ne doit pas quitter la page en pleine partie.
  if (!historiquePiege) {
    history.pushState({ manette: true }, '', location.href);
    historiquePiege = true;
  }
  $('#accueil').hidden = true;
  recalculerActif();
  if (!ws && !erreurBloquante) connecter();
});

window.addEventListener('popstate', () => {
  if (historiquePiege) history.pushState({ manette: true }, '', location.href);
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && veutPleinEcran && $('#reglages').hidden) {
    $('#accueil-titre').textContent = 'En pause';
    $('#accueil-texte').textContent = 'Le plein écran a été quitté.';
    $('#jouer').textContent = 'Reprendre';
    $('#accueil').hidden = false;
  }
  recalculerActif();
});

// ---------- Réglages ----------

const FORMATS = {
  taille: (v) => `${Math.round(v * 100)} %`,
  opacite: (v) => `${Math.round(v * 100)} %`,
  zoneMorte: (v) => `${Math.round(v * 100)} %`,
  course: (v) => `${Math.round(v * 100)} %`,
};

// ---------- Presets : dispositions toutes faites, ou personnelles (boutons déplacés au doigt).
// Un preset personnel garde la base dont il est parti (tailles, mode combat) et la position
// de chaque élément, en fraction de l'écran pour s'adapter à un autre téléphone. ----------

const PRESETS_FIXES = [
  { id: 'normal', nom: 'Normal', base: 'normal' },
  { id: 'ufc', nom: 'UFC 4 (combat)', base: 'ufc' },
];
const AIDES_PRESET = {
  normal: 'Disposition d\'une manette classique : gâchettes en haut.',
  ufc: 'Gâchettes près des pouces, LT et RT au-dessus. Une tape sur LB, RB ou LT (L1, R1, L2) '
    + 'l\'arme pour le coup suivant, par exemple LB puis X pour un crochet. LT+RT fait la garde basse.',
};

function lirePersos() {
  try {
    const liste = JSON.parse(lire('manette.presets'));
    return Array.isArray(liste) ? liste.filter((p) => p && p.id && p.positions) : [];
  } catch { return []; }
}
let persos = lirePersos();

function presetActuel() {
  return PRESETS_FIXES.find((p) => p.id === cfg.preset) || persos.find((p) => p.id === cfg.preset) || PRESETS_FIXES[0];
}
function combat() { return presetActuel().base === 'ufc'; }

const DEPLACABLES = Array.from(pad.querySelectorAll('[data-btn], [data-stick], [data-dpad]'));
function cleDe(el) { return el.dataset.btn || (el.dataset.stick ? `stick${el.dataset.stick}` : 'croix'); }
for (const el of DEPLACABLES) {
  el.dataset.x0 = el.style.getPropertyValue('--x');
  el.dataset.y0 = el.style.getPropertyValue('--y');
}

function appliquerPreset() {
  const p = presetActuel();
  cfg.preset = p.id;  // un preset supprimé retombe sur Normal
  document.body.dataset.base = p.base;
  for (const el of DEPLACABLES) {
    const pos = p.positions && p.positions[cleDe(el)];
    el.style.setProperty('--x', pos ? `${pos.x * 100}%` : el.dataset.x0);
    el.style.setProperty('--y', pos ? `${pos.y * 100}%` : el.dataset.y0);
  }
  // La zone où le pouce attrape un joystick flottant suit le joystick déplacé.
  for (const zone of pad.querySelectorAll('[data-zone]')) {
    const pos = p.positions && p.positions[`stick${zone.dataset.zone}`];
    Object.assign(zone.style, pos ? {
      left: `calc(${pos.x * 100}% - var(--u) * 28)`, top: `calc(${pos.y * 100}% - var(--u) * 28)`,
      width: 'calc(var(--u) * 56)', height: 'calc(var(--u) * 56)', right: 'auto', bottom: 'auto',
    } : { left: '', top: '', width: '', height: '', right: '', bottom: '' });
  }
  if (!combat()) armes.clear();
  $('#aide-preset').textContent = AIDES_PRESET[p.id]
    || `Ton preset, parti de « ${PRESETS_FIXES.find((f) => f.id === p.base).nom} ».`;
  $('#supprimer-preset').hidden = !persos.includes(p);
}

function remplirPresets() {
  $('#choix-preset').replaceChildren(...[...PRESETS_FIXES, ...persos].map((p) => new Option(p.nom, p.id)));
}

function enregistrerPersos() {
  ecrire('manette.presets', JSON.stringify(persos));
  ecrire('manette.reglages', JSON.stringify(cfg));
}

// ---------- Mode édition : on touche un bouton et on le fait glisser où on veut ----------

let edition = null;  // { perso: preset personnel modifié ou null, glisse: déplacement en cours }

function ouvrirEdition() {
  const p = presetActuel();
  edition = { perso: persos.includes(p) ? p : null, glisse: null };
  $('#nom-preset').value = edition.perso ? edition.perso.nom : '';
  for (const prop of ['left', 'top', 'bottom', 'transform']) $('#edition').style[prop] = '';  // cadre à sa place
  $('#reglages').hidden = true;
  $('#edition').hidden = false;
  document.body.classList.add('edition');
  recalculerActif();
  for (const el of pad.querySelectorAll('[data-stick]')) el.style.transform = '';  // joysticks au repos
}

function fermerEdition(enregistrer) {
  if (enregistrer) {
    const r = pad.getBoundingClientRect();
    const positions = {};
    for (const el of DEPLACABLES) {
      if (!el.getClientRects().length) continue;  // LT+RT, masqué hors UFC
      const c = centre(el);
      positions[cleDe(el)] = { x: +((c.cx - r.left) / r.width).toFixed(4), y: +((c.cy - r.top) / r.height).toFixed(4) };
    }
    const nom = $('#nom-preset').value.trim() || `Mon preset ${persos.length + 1}`;
    if (edition.perso) {
      Object.assign(edition.perso, { nom, positions });
    } else {
      const p = { id: `perso-${Date.now()}`, nom, base: presetActuel().base, positions };
      persos.push(p);
      cfg.preset = p.id;
    }
    enregistrerPersos();
  }
  edition = null;
  document.body.classList.remove('edition');
  $('#edition').hidden = true;
  appliquerReglages();  // après « Annuler », remet les positions du preset
  recalculerActif();
}

function debutGlisse(e) {
  const el = e.target.closest('[data-btn], [data-stick], [data-dpad]');
  if (!el || edition.glisse) return;
  e.preventDefault();
  const c = centre(el);
  edition.glisse = { el, id: e.pointerId, dx: c.cx - e.clientX, dy: c.cy - e.clientY, demiL: c.dx, demiH: c.dy };
  el.classList.add('deplace');
}

function suiteGlisse(e) {
  const g = edition.glisse;
  if (!g || g.id !== e.pointerId) return;
  const r = pad.getBoundingClientRect();
  // Le bouton reste entièrement à l'écran.
  const x = Math.min(Math.max(e.clientX + g.dx, r.left + g.demiL), r.right - g.demiL);
  const y = Math.min(Math.max(e.clientY + g.dy, r.top + g.demiH), r.bottom - g.demiH);
  g.el.style.setProperty('--x', `${((x - r.left) / r.width) * 100}%`);
  g.el.style.setProperty('--y', `${((y - r.top) / r.height) * 100}%`);
}

function finGlisse(e) {
  const g = edition.glisse;
  if (!g || g.id !== e.pointerId) return;
  g.el.classList.remove('deplace');
  edition.glisse = null;
}

// Le cadre d'édition se déplace par sa ligne du haut, pour dégager un bouton qu'il couvre.
$('#poignee').addEventListener('pointerdown', (e) => {
  const poignee = e.currentTarget;
  const cadre = $('#edition');
  const r = cadre.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;
  try { poignee.setPointerCapture(e.pointerId); } catch { /* sans capture, le glisser marche tant que le doigt reste dessus */ }
  const bouger = (m) => {
    const x = Math.min(Math.max(m.clientX - dx, 0), innerWidth - r.width);
    const y = Math.min(Math.max(m.clientY - dy, 0), innerHeight - r.height);
    Object.assign(cadre.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto', transform: 'none' });
  };
  const fin = () => {
    poignee.removeEventListener('pointermove', bouger);
    poignee.removeEventListener('pointerup', fin);
    poignee.removeEventListener('pointercancel', fin);
  };
  poignee.addEventListener('pointermove', bouger);
  poignee.addEventListener('pointerup', fin);
  poignee.addEventListener('pointercancel', fin);
});

$('#modifier-preset').addEventListener('click', ouvrirEdition);
$('#enregistrer-preset').addEventListener('click', () => fermerEdition(true));
$('#annuler-edition').addEventListener('click', () => fermerEdition(false));
$('#supprimer-preset').addEventListener('click', () => {
  const p = presetActuel();
  if (!persos.includes(p) || !window.confirm(`Supprimer le preset « ${p.nom} » ?`)) return;
  persos = persos.filter((q) => q !== p);
  cfg.preset = p.base;  // retour au preset d'origine
  enregistrerPersos();
  remplirReglages();
  appliquerReglages();
});

function appliquerReglages() {
  pad.style.setProperty('--taille', cfg.taille);
  pad.style.setProperty('--opacite', cfg.opacite);
  pad.classList.toggle('flottants', cfg.flottants);
  document.body.classList.toggle('ps', cfg.disposition === 'playstation');
  appliquerPreset();
  for (const o of document.querySelectorAll('output[data-pour]')) {
    o.textContent = FORMATS[o.dataset.pour](cfg[o.dataset.pour]);
  }
  majStatut();
}

function remplirReglages() {
  remplirPresets();
  for (const el of document.querySelectorAll('[data-reglage]')) {
    const cle = el.dataset.reglage;
    if (el.type === 'checkbox') el.checked = cfg[cle];
    else el.value = String(cfg[cle]);
  }
}

function surReglage(e) {
  const el = e.target;
  const cle = el.dataset.reglage;
  if (el.type === 'checkbox') cfg[cle] = el.checked;
  else if (typeof DEFAUTS[cle] === 'boolean') cfg[cle] = el.value === 'true';
  else if (typeof DEFAUTS[cle] === 'string') cfg[cle] = el.value;
  else cfg[cle] = parseFloat(el.value);
  ecrire('manette.reglages', JSON.stringify(cfg));
  appliquerReglages();
}

for (const el of document.querySelectorAll('[data-reglage]')) {
  el.addEventListener('input', surReglage);
  el.addEventListener('change', surReglage);
}

$('#statut').addEventListener('click', () => {
  remplirReglages();
  $('#reglages').hidden = false;
  recalculerActif();
});

$('#fermer-reglages').addEventListener('click', () => {
  $('#reglages').hidden = true;
  recalculerActif();
});

$('#defaut').addEventListener('click', () => {
  Object.assign(cfg, DEFAUTS);
  ecrire('manette.reglages', JSON.stringify(cfg));
  remplirReglages();
  appliquerReglages();
});

$('#plein-ecran').addEventListener('click', () => { pleinEcran(); });

// ---------- Évènements de page ----------

portrait.addEventListener('change', recalculerActif);

document.addEventListener('visibilitychange', () => {
  recalculerActif();
  // Le verrou d'écran saute quand la page passe en arrière-plan : le reprendre au retour.
  if (document.visibilityState === 'visible' && $('#accueil').hidden) garderEcranAllume();
  if (document.visibilityState === 'visible' && !ws && !erreurBloquante) {
    essais = 0;
    connecter();
  }
});

new ResizeObserver(() => { if (actif) mesurer(); }).observe(pad);

window.addEventListener('contextmenu', (e) => e.preventDefault());

appliquerReglages();
connecter();
