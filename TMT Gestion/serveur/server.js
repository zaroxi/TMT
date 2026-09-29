'use strict';
/* =====================================================================
   TMT Gestion — serveur local (version SQL)
   - Node.js ≥ 22.13, module intégré node:sqlite, aucune dépendance npm
   - sert l'application sur http://localhost:8080 et enregistre les données dans TMT.db
   - enregistrements incrémentaux (une transaction par enregistrement)
   - copie automatique quotidienne de TMT.db (30 derniers jours + une copie par mois)
   ===================================================================== */
{ const w0 = process.emitWarning; process.emitWarning = function (w, ...a) { if (/SQLite/i.test(String(w && w.message || w))) return; return w0.call(process, w, ...a); }; }
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const VERSION = '2.1 (SQL, utilisateurs)';
const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2), arg = (n, d) => { const i = ARGS.indexOf('--' + n); return i >= 0 ? (ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : true) : d; };

/* ---------- réglages du serveur ----------
   Enregistrés dans le dossier des données (donnees\reglages-serveur.json) et modifiables dans
   Paramètres › Serveur. L'ancien config.json (à côté du dossier serveur) est encore lu s'il existe,
   puis repris automatiquement dans reglages-serveur.json.                                          */
const CONFIG_FILE = path.resolve(ROOT, String(arg('config', 'config.json')));
let LEGACY = {}, CFG_ERR = '';
try { if (fs.existsSync(CONFIG_FILE)) LEGACY = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { CFG_ERR = 'config.json illisible (' + e.message + ') : réglages par défaut utilisés'; console.error('⚠ ' + CFG_ERR); }
const DATA = path.resolve(ROOT, String(arg('data', LEGACY.dossierDonnees || 'donnees')));
fs.mkdirSync(DATA, { recursive: true });
const RCFG_FILE = path.join(DATA, 'reglages-serveur.json');
const CFG_KEYS = ['port', 'reseau', 'motDePasseReseau', 'copieVers', 'joursDeCopies'];
let CFG = {};
try { if (fs.existsSync(RCFG_FILE)) CFG = JSON.parse(fs.readFileSync(RCFG_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { CFG_ERR = 'reglages-serveur.json illisible (' + e.message + ')'; console.error('⚠ ' + CFG_ERR); }
if (!fs.existsSync(RCFG_FILE) && Object.keys(LEGACY).length) {   // reprise de l'ancien config.json
  for (const k of CFG_KEYS) if (LEGACY[k] !== undefined) CFG[k] = LEGACY[k];
  try { fs.writeFileSync(RCFG_FILE, JSON.stringify(CFG, null, 2)); console.log('Réglages repris de config.json → ' + RCFG_FILE); } catch (e) { }
}
const PORT = +arg('port', CFG.port || 8080);
const LAN_START = !!(arg('reseau', false) || CFG.reseau);   // à l'écoute du réseau depuis le démarrage
let LAN = LAN_START;
let LAN_PW = String(CFG.motDePasseReseau || '');
let KEEP_DAYS = Math.max(3, +(CFG.joursDeCopies || 30));
let COPY_TO = CFG.copieVers ? path.resolve(ROOT, String(CFG.copieVers)) : '';
function saveCfg(n) {
  const next = { ...CFG };
  if (n.port !== undefined) { const p = Math.round(+n.port); if (!(p >= 1024 && p <= 65535)) throw Object.assign(new Error('port : nombre entre 1024 et 65535'), { code: 400 }); next.port = p; }
  if (n.reseau !== undefined) next.reseau = !!n.reseau;
  if (n.motDePasseReseau !== undefined) next.motDePasseReseau = String(n.motDePasseReseau).slice(0, 100);
  if (n.joursDeCopies !== undefined) { const j = Math.round(+n.joursDeCopies); if (!(j >= 3 && j <= 3650)) throw Object.assign(new Error('copies : entre 3 et 3650 jours'), { code: 400 }); next.joursDeCopies = j; }
  if (n.copieVers !== undefined) {
    const d = String(n.copieVers || '').trim(); next.copieVers = d;
    if (d) { const abs = path.resolve(ROOT, d); try { if (!fs.existsSync(abs)) { if (!fs.existsSync(path.dirname(abs))) throw new Error('dossier introuvable : ' + path.dirname(abs)); fs.mkdirSync(abs); } fs.accessSync(abs, fs.constants.W_OK); if (!fs.statSync(abs).isDirectory()) throw new Error('ce n\'est pas un dossier'); } catch (e) { throw Object.assign(new Error('dossier de copie inaccessible : ' + e.message), { code: 400 }); } }
  }
  fs.writeFileSync(RCFG_FILE + '.tmp', JSON.stringify(next, null, 2)); fs.renameSync(RCFG_FILE + '.tmp', RCFG_FILE);
  CFG = next; LAN = LAN_START && !!next.reseau; LAN_PW = String(next.motDePasseReseau || ''); KEEP_DAYS = Math.max(3, +(next.joursDeCopies || 30)); COPY_TO = next.copieVers ? path.resolve(ROOT, String(next.copieVers)) : '';
  return cfgOut();
}
const cfgOut = () => ({ port: +(CFG.port || 8080), reseau: !!CFG.reseau, motDePasseReseau: CFG.motDePasseReseau ? '••••••' : '', mdpDefini: !!CFG.motDePasseReseau, copieVers: CFG.copieVers || '', joursDeCopies: +(CFG.joursDeCopies || 30),
  actif: { port: PORT, reseau: LAN, ecouteReseau: LAN_START }, redemarrer: +(CFG.port || 8080) !== PORT || (!!CFG.reseau && !LAN_START), fichier: RCFG_FILE, ancienConfig: fs.existsSync(CONFIG_FILE) });
const OPEN = !!arg('ouvrir', false);
const TEST_PAUSE = +(process.env.TMT_TEST_PAUSE_MS || 0);
const APP_FILE = path.join(__dirname, 'app', 'index.html');
let APP_CSS_CACHE = null;
function appStyleCss() {   // le CSS de l'application (extrait de index.html), pour que la page de relevé partagé ait exactement le même rendu
  if (APP_CSS_CACHE !== null) return APP_CSS_CACHE;
  try { const m = fs.readFileSync(APP_FILE, 'utf8').match(/<style>([\s\S]*?)<\/style>/); APP_CSS_CACHE = m ? m[1] : ''; } catch (e) { APP_CSS_CACHE = ''; }
  return APP_CSS_CACHE;
}
const PREV_DIR = path.join(ROOT, 'serveur.precedent');   // version précédente du programme (retour arrière)
const SUPERVISED = process.env.TMT_WORKER === '1' && typeof process.send === 'function';   // lancé par le superviseur : peut redémarrer tout seul
const readVer = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')); } catch (e) { return {}; } };
const DB_FILE = path.join(DATA, 'TMT.db');
const BK_DIR = path.join(DATA, 'sauvegardes'), BK_MONTH = path.join(BK_DIR, 'mensuelles');
const LOG_FILE = path.join(DATA, 'journal-serveur.log');
fs.mkdirSync(BK_MONTH, { recursive: true });
const PHOTO_DIR = path.join(DATA, 'photos');   // photos des bons (gasoil…), une image JPEG par bon
const photoFile = id => { const n = String(id || ''); if (!/^[\w-]{1,60}$/.test(n)) throw Object.assign(new Error('photo : identifiant invalide'), { code: 400 }); return path.join(PHOTO_DIR, n + '.jpg'); };

function log(...a) {
  const line = new Date().toLocaleString('fr-FR') + '  ' + a.join(' ');
  console.log(line);
  try { if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2e6) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); fs.appendFileSync(LOG_FILE, line + '\r\n'); } catch (e) { }
}
const pad2 = n => String(n).padStart(2, '0');
const dayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hmStr = (d = new Date()) => `${pad2(d.getHours())}${pad2(d.getMinutes())}`;

/* ---------- base de données ---------- */
let db = null;
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
const TABLE_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const colOk = c => typeof c === 'string' && c.length > 0 && c.length < 80 && !c.startsWith('_') && !/[\u0000-\u001f]/.test(c);
let META = {};   // cache des colonnes par table
function openDb() {
  db = new DatabaseSync(DB_FILE);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v);
    CREATE TABLE IF NOT EXISTS _tables (name TEXT PRIMARY KEY, created TEXT);
    CREATE TABLE IF NOT EXISTS _deleted (t TEXT NOT NULL, k TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (t, k));
    CREATE INDEX IF NOT EXISTS _deleted_rev ON _deleted (rev);
    CREATE TABLE IF NOT EXISTS _saves (rev INTEGER PRIMARY KEY, at TEXT, pc TEXT, nb_modifs INTEGER, nb_suppr INTEGER);
    CREATE TABLE IF NOT EXISTS _users (id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, nom TEXT, hash TEXT, perms TEXT, actif INTEGER DEFAULT 1, created TEXT, last_login TEXT);
    CREATE TABLE IF NOT EXISTS _sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created TEXT, seen INTEGER, pc TEXT);
    CREATE TABLE IF NOT EXISTS _audit (id INTEGER PRIMARY KEY, rev INTEGER, at TEXT, login TEXT, nom TEXT, pc TEXT, t TEXT, k TEXT, act TEXT, data TEXT);
    CREATE INDEX IF NOT EXISTS _audit_at ON _audit (at);
    CREATE TABLE IF NOT EXISTS _alerts (id INTEGER PRIMARY KEY, at TEXT, login TEXT, nom TEXT, pc TEXT, n INTEGER, detail TEXT, vu TEXT);`);
  try { db.prepare('DELETE FROM _audit WHERE at < ?').run(new Date(Date.now() - AUDIT_DAYS * 864e5).toISOString()); } catch (e) { }
  if (!db.prepare('PRAGMA table_info(_users)').all().some(c => c.name === 'prefs')) db.exec('ALTER TABLE _users ADD COLUMN prefs TEXT');   // préférences de chaque compte (alertes affichées…)
  db.exec(`CREATE TABLE IF NOT EXISTS _releve_shares (token TEXT PRIMARY KEY, presta TEXT, ym TEXT, html TEXT, exp INTEGER, created TEXT, created_by TEXT)`);   // lien de partage du relevé sous-traitant (instantané figé) ; token = hash, colonne « plain » (ajoutée ci-dessous) = jeton en clair pour pouvoir réafficher/révoquer le lien depuis l'écran
  if (!db.prepare('PRAGMA table_info(_releve_shares)').all().some(c => c.name === 'plain')) db.exec('ALTER TABLE _releve_shares ADD COLUMN plain TEXT');
  try { db.prepare('DELETE FROM _releve_shares WHERE exp < ?').run(Date.now() - 30 * 864e5) } catch (e) { }   // ménage : liens expirés depuis plus de 30 j
  META = {};
  for (const { name } of db.prepare('SELECT name FROM _tables').all()) META[name] = cols(name);
  STMT.clear();
}
const cols = t => db.prepare(`PRAGMA table_info(${q(t)})`).all().map(r => r.name).filter(n => !n.startsWith('_'));
const metaGet = (k, d) => { const r = db.prepare('SELECT v FROM _meta WHERE k = ?').get(k); return r ? r.v : d; };
const metaSet = (k, v) => db.prepare('INSERT INTO _meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
const curRev = () => +metaGet('rev', 0);
function ensureTable(t, cs) {
  if (!TABLE_RE.test(t)) throw new Error('nom de table refusé : ' + t);
  if (!Array.isArray(cs) || !cs.every(colOk) || new Set(cs).size !== cs.length) throw new Error('colonnes refusées pour ' + t);
  if (!META[t]) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${q(t)} ("_k" TEXT PRIMARY KEY, "_pos" REAL, "_rev" INTEGER, ${cs.map(q).join(', ')})`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${q(t + '__rev')} ON ${q(t)} ("_rev")`);
    db.prepare('INSERT OR IGNORE INTO _tables (name, created) VALUES (?, ?)').run(t, new Date().toISOString());
    META[t] = cols(t);
  }
  for (const c of cs) if (!META[t].includes(c)) { db.exec(`ALTER TABLE ${q(t)} ADD COLUMN ${q(c)}`); META[t].push(c); STMT.clear(); }
}
const STMT = new Map();
function stmt(sql) { let s = STMT.get(sql); if (!s) { s = db.prepare(sql); STMT.set(sql, s); } return s; }
const val = v => v === undefined || v === null ? '' : typeof v === 'number' ? (Number.isFinite(v) ? v : '') : typeof v === 'boolean' ? String(v) : typeof v === 'string' ? v : JSON.stringify(v);

/* ---------- utilisateurs et droits ---------- */
const PERMS = ['pointage', 'gasoil', 'depenses', 'ref', 'montants', 'dashboard', 'rapports', 'caisse', 'params', 'users'];
const NEED_MONEY = ['dashboard', 'rapports', 'caisse'];          // n'ont de sens qu'avec « voir les prix et montants »
const SESSION_IDLE = 12 * 3600e3;                                   // déconnexion après 12 h sans activité
// tables invisibles sans le droit « montants » (renvoyées vides) ; colonnes vidées
const MONEY_TABLES = new Set(['NotesFrais', 'PaieMois', 'Retenues', 'Reglements', 'Factures', 'Commissions', 'PaiementsPrestataires', 'Rentabilite', 'Archives', 'Journal', 'Caisse']);
const MONEY_COLS = { StockMouvements: ['prix_unitaire'], Administration: ['paie'], Fiches: ['tarif', 'total', 'commission_pct'], Trajets: ['tarif', 'prix_prestataire', 'tarifs_dates'], Pneus: ['prix'], Vehicules: ['loyer_mensuel'], VehiculesHistorique: ['loyer_mensuel'], Chauffeurs: ['salaire', 'paie_brut', 'prime_imposable', 'indemnites_non_imposables'], Clotures: ['facture_html', 'gasoil_fige'] };
// droit nécessaire pour modifier chaque table (un des droits de la liste)
const WRITE = {
  Fiches: ['pointage'], Gasoil: ['gasoil'], Depenses: ['depenses'], PlanEntretien: ['depenses'], Pneus: ['depenses', 'ref'],
  Vehicules: ['ref'], Chauffeurs: ['ref'], Trajets: ['ref'], Planning: ['ref'], Clients: ['ref'], VehiculesHistorique: ['ref'], Indisponibilites: ['ref'], Affectations: ['ref', 'pointage'], PaieMois: ['rapports'], Administration: ['rapports'], Fournisseurs: ['depenses', 'caisse', 'gasoil', 'ref'], Stock: ['depenses', 'ref'], StockMouvements: ['depenses'], StockInventaires: ['depenses'], DecomptesClient: ['rapports'], Occasionnels: ['rapports', 'caisse'], RegistreRH: ['rapports', 'ref'], Corbeille: ['pointage', 'gasoil', 'depenses', 'caisse', 'ref', 'rapports', 'params'], Taches: ['dashboard', 'pointage', 'gasoil', 'depenses', 'caisse', 'ref', 'rapports', 'params'], Societes: ['ref', 'rapports'], CongesDemandes: ['rapports', 'ref'], Signatures: ['rapports', 'ref', 'pointage', 'params'],
  Caisse: ['caisse'], NotesFrais: ['caisse'], Retenues: ['rapports', 'caisse'], Reglements: ['rapports'], Factures: ['rapports'], Clotures: ['rapports'], Commissions: ['rapports', 'params'],
  PaiementsPrestataires: ['rapports'], Rentabilite: ['rapports', 'params'], Archives: ['rapports', 'params'], Parametres: ['params'], Journal: ['users']
};
// ajout de nouvelles lignes seulement (ex. retenue créée par une réparation « avancée », journal)
const INSERT_ONLY = { Retenues: ['depenses'], Journal: PERMS };
const hasAny = (u, list) => (list || []).some(x => u.perms.has(x));
function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function checkPw(pw, h) {
  const m = String(h || '').match(/^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/); if (!m) return false;
  const a = crypto.scryptSync(String(pw), m[1], 32), b = Buffer.from(m[2], 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const cleanPerms = list => { const p = PERMS.filter(x => (list || []).includes(x)); return p.includes('montants') ? p : p.filter(x => !NEED_MONEY.includes(x)); };
const jsonOr = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const pTrim = s => String(s || '').trim();
const userOut = r => ({ id: r.id, login: r.login, nom: r.nom || r.login, perms: JSON.parse(r.perms || '[]'), actif: !!r.actif, created: r.created, lastLogin: r.last_login, prefs: jsonOr(r.prefs, {}) });
const nbUsers = () => db.prepare('SELECT COUNT(*) AS n FROM _users').get().n;
const tokHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const cookieOf = req => { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)tmt_session=([0-9a-f]{64})/); return m ? m[1] : ''; };
function sessionUser(req) {
  const tok = cookieOf(req); if (!tok) return null;
  const s = stmt('SELECT s.token, s.seen, u.* FROM _sessions s JOIN _users u ON u.id = s.user_id WHERE s.token = ?').get(tokHash(tok));
  if (!s) return null;
  if (!s.actif || Date.now() - s.seen > SESSION_IDLE) { stmt('DELETE FROM _sessions WHERE token = ?').run(s.token); return null; }
  if (Date.now() - s.seen > 60000) stmt('UPDATE _sessions SET seen = ? WHERE token = ?').run(Date.now(), s.token);
  const u = userOut(s); u.perms = new Set(u.perms); u.token = s.token; return u;
}
function newSession(res, userId, pc) {
  const tok = crypto.randomBytes(32).toString('hex');
  stmt('INSERT INTO _sessions (token, user_id, created, seen, pc) VALUES (?, ?, ?, ?, ?)').run(tokHash(tok), userId, new Date().toISOString(), Date.now(), String(pc || '').slice(0, 60));
  stmt('UPDATE _users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), userId);
  stmt('DELETE FROM _sessions WHERE seen < ?').run(Date.now() - SESSION_IDLE);
  res.setHeader('Set-Cookie', `tmt_session=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
}
const FAILS = new Map();   // limite les essais de mot de passe
function tooMany(key) { const f = FAILS.get(key); return f && f.n >= 5 && Date.now() < f.until; }
function failed(key) { const f = FAILS.get(key) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) f.until = Date.now() + 60000 * Math.min(10, f.n - 4); FAILS.set(key, f); }
function adminsLeft(exceptId, next) {   // reste-t-il au moins un administrateur actif ?
  return db.prepare('SELECT * FROM _users').all().some(r => { const u = r.id === exceptId ? next : userOut(r); return u && u.actif && u.perms.includes('users'); });
}
/* ce que voit un utilisateur : sans « montants », tables d'argent vides et colonnes de prix vidées */
function hiddenFor(u) { return u.perms.has('montants') ? { tables: [], cols: {} } : { tables: [...MONEY_TABLES], cols: MONEY_COLS }; }
function filterTables(u, tables) {
  if (u.perms.has('montants')) return tables;
  for (const [t, tb] of Object.entries(tables)) {
    if (MONEY_TABLES.has(t)) { tb.rows = []; continue; }
    const hc = MONEY_COLS[t]; if (!hc) continue;
    const ix = hc.map(c => tb.cols.indexOf(c)).filter(i => i >= 0);
    for (const r of tb.rows) for (const i of ix) r[i + 2] = '';
  }
  return tables;
}
/* un enregistrement = une transaction : tout ou rien */
/* ---------- journal des modifications (audit) : qui a changé quoi, avant → après ---------- */
const AUDIT_DAYS = 400, AUDIT_SKIP = new Set(['Corbeille', 'Journal']), AUDIT_LAB = ['cle', 'immatriculation', 'nom', 'libelle', 'tache', 'bon', 'date', 'jour', 'categorie', 'trajet', 'vehicule', 'chauffeur', 'login'];
const MASS_DEL = { Fiches: 100, _: 10 };   // alerte « suppression importante » à partir de … lignes supprimées en un enregistrement
function auditLab(row) { const o = {}; if (!row) return o; for (const c of AUDIT_LAB) if (row[c] !== undefined && row[c] !== null && row[c] !== '' && Object.keys(o).length < 3) o[c] = String(row[c]).slice(0, 80); return o; }
function auditEvent(U, pc, t, k, act, data) { try { stmt('INSERT INTO _audit (rev, at, login, nom, pc, t, k, act, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(curRev(), new Date().toISOString(), (U && U.login) || '', (U && U.nom) || '', String(pc || '').slice(0, 60), t, String(k || ''), act, JSON.stringify(data || {})); } catch (e) { } }
function applySave(body, user) {
  const ops = Array.isArray(body.ops) ? body.ops : [];
  const U = user || { perms: new Set(PERMS), nom: '' }, money = U.perms.has('montants');
  // reprise après coupure : ne pas écraser une ligne modifiée ou supprimée depuis par un autre poste
  const recover = !!body.recover, since = +body.since || 0;
  const changedSince = (t, k, n) => { const r = stmt(`SELECT "_rev" AS r FROM ${q(t)} WHERE "_k" = ?`).get(k); if (r) return r.r > n; const d = stmt('SELECT rev FROM _deleted WHERE t = ? AND k = ?').get(t, k); return !!d && d.rev > n; };
  let nUp = 0, nDel = 0, nSkip = 0; const AUD = [], DELS = {};
  db.exec('BEGIN IMMEDIATE');
  try {
    const prev = curRev(), rev = prev + 1;
    for (const op of ops) {
      const t = String(op.t || ''), cs = (op.cols || []).map(String);
      // droits : tout, ajout seulement, ou rien (lignes ignorées sans erreur)
      const full = !WRITE[t] ? U.perms.has('params') : hasAny(U, WRITE[t]), insOnly = !full && hasAny(U, INSERT_ONLY[t]);
      const keyOk = k => full || (t === 'Parametres' && k === '_savedAt');
      if (!full && !insOnly && !(t === 'Parametres' && (op.up || []).some(r => r && r[0] === '_savedAt'))) { nSkip += (op.up || []).length + (op.del || []).length; continue; }
      ensureTable(t, cs);
      const protect = !money && MONEY_COLS[t] ? MONEY_COLS[t].map(c => cs.indexOf(c)).filter(i => i >= 0) : [];
      const exists = k => stmt(`SELECT * FROM ${q(t)} WHERE "_k" = ?`).get(k);
      if (op.up && op.up.length) {
        const sql = `INSERT INTO ${q(t)} ("_k", "_pos", "_rev", ${cs.map(q).join(', ')}) VALUES (${Array(cs.length + 3).fill('?').join(', ')}) ON CONFLICT("_k") DO UPDATE SET "_pos" = excluded."_pos", "_rev" = excluded."_rev"${cs.map(c => `, ${q(c)} = excluded.${q(c)}`).join('')}`;
        const s = stmt(sql), unTomb = stmt('DELETE FROM _deleted WHERE t = ? AND k = ?');
        for (const r of op.up) {
          if (!Array.isArray(r) || r.length !== cs.length + 2) throw new Error('ligne mal formée dans ' + t);
          if (recover && changedSince(t, String(r[0]), since)) { nSkip++; continue; }
          const k = String(r[0]); let old;
          if (!keyOk(k)) { if (!insOnly || exists(k)) { nSkip++; continue; } }
          const vals = r.slice(2).map(val);
          const aud = !body.replaceAll && !AUDIT_SKIP.has(t) && !(t === 'Parametres' && k === '_savedAt'), before = aud ? (old !== undefined ? old : exists(k)) : null;
          if (protect.length) {   // prix non visibles : garder ceux de la base (ou le tarif du trajet pour une nouvelle ligne)
            old = exists(k);
            for (const i of protect) vals[i] = old ? (old[cs[i]] ?? '') : '';
            if (t === 'Fiches') {
              const ci = c => cs.indexOf(c), ar = +vals[ci('ar')] || 0;
              if (!old && ci('tarif') >= 0) { const tr = META.Trajets && META.Trajets.includes('tarif') ? stmt('SELECT tarif FROM "Trajets" WHERE "_k" = ?').get(String(vals[ci('trajet_id')])) : null; vals[ci('tarif')] = tr ? tr.tarif : ''; }
              if (ci('total') >= 0 && ci('tarif') >= 0 && vals[ci('tarif')] !== '') vals[ci('total')] = ar * (+vals[ci('tarif')] || 0);
            }
          }
          s.run(String(r[0]), +r[1] || 0, rev, ...vals); unTomb.run(t, String(r[0])); nUp++;
          if (aud) {
            if (!before) { const o = {}; cs.forEach((c, i) => { if (vals[i] !== '' && vals[i] !== null && vals[i] !== undefined) o[c] = vals[i]; }); AUD.push([t, k, 'ajout', { lab: auditLab(o), v: o }]); }
            else { const ch = {}; cs.forEach((c, i) => { const a0 = before[c] === null || before[c] === undefined ? '' : before[c], b0 = vals[i] === null || vals[i] === undefined ? '' : vals[i]; if (String(a0) !== String(b0)) ch[c] = [a0, b0]; }); if (Object.keys(ch).length) { const cur = {}; cs.forEach((c, i) => cur[c] = vals[i]); AUD.push([t, k, 'modif', { lab: auditLab(cur), c: ch }]); } }
          }
          if (TEST_PAUSE && nUp === 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TEST_PAUSE);   // tests : enregistrement interrompu
        }
      }
      if (op.del && op.del.length) {
        const d = stmt(`DELETE FROM ${q(t)} WHERE "_k" = ?`), tomb = stmt('INSERT INTO _deleted (t, k, rev) VALUES (?, ?, ?) ON CONFLICT(t, k) DO UPDATE SET rev = excluded.rev');
        for (const k of op.del) { if (!keyOk(String(k))) { nSkip++; continue; } if (recover && changedSince(t, String(k), since)) { nSkip++; continue; } const before = !body.replaceAll && !AUDIT_SKIP.has(t) ? exists(String(k)) : null; d.run(String(k)); tomb.run(t, String(k), rev); nDel++;
          if (before) { const o = {}; for (const c of cs.length ? cs : Object.keys(before).filter(c => c[0] !== '_')) if (before[c] !== null && before[c] !== '' && before[c] !== undefined) o[c] = before[c]; AUD.push([t, String(k), 'suppr', { lab: auditLab(before), v: o }]); DELS[t] = (DELS[t] || 0) + 1; } }
      }
    }
    metaSet('rev', rev);
    stmt('INSERT INTO _saves (rev, at, pc, nb_modifs, nb_suppr) VALUES (?, ?, ?, ?, ?)').run(rev, new Date().toISOString(), ((U.nom ? U.nom + ' · ' : '') + String(body.pc || '')).slice(0, 80), nUp, nDel);
    if (body.replaceAll) metaSet('tombFloor', rev);   // import complet : les autres postes rechargent tout
    // garder un historique de suppressions raisonnable
    const floor = rev - 200000; if (floor > +metaGet('tombFloor', 0)) { stmt('DELETE FROM _deleted WHERE rev < ?').run(floor); metaSet('tombFloor', floor); }
    { const at = new Date().toISOString(), pc = String(body.pc || '').slice(0, 60), ins = stmt('INSERT INTO _audit (rev, at, login, nom, pc, t, k, act, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      if (body.replaceAll) ins.run(rev, at, U.login || '', U.nom || '', pc, '*', '', 'import', JSON.stringify({ n: nUp }));
      for (const [t, k, act, data] of AUD) ins.run(rev, at, U.login || '', U.nom || '', pc, t, k, act, JSON.stringify(data, (kk, v) => typeof v === 'string' && v.length > 400 ? v.slice(0, 40) + '… (' + v.length + ' caractères)' : v));   // images (signatures, logo) : pas en entier dans le journal
      const big = Object.entries(DELS).filter(([t, n]) => n >= (MASS_DEL[t] || MASS_DEL._));
      if (big.length) stmt('INSERT INTO _alerts (at, login, nom, pc, n, detail, vu) VALUES (?, ?, ?, ?, ?, ?, ?)').run(at, U.login || '', U.nom || '', pc, Object.values(DELS).reduce((a, b) => a + b, 0), JSON.stringify({ rev, tables: DELS }), '');
    }
    db.exec('COMMIT');
    return { rev, prev, nUp, nDel, nSkip };
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { } throw e; }
}

function rowsOut(t, where, args) {
  const cs = META[t]; if (!cs) return null;
  const rows = stmt(`SELECT "_k", "_pos", ${cs.map(q).join(', ')} FROM ${q(t)} ${where || ''} ORDER BY "_pos", rowid`).all(...(args || []));
  return { cols: cs, rows: rows.map(r => [r._k, r._pos, ...cs.map(c => r[c] === null ? '' : r[c])]) };
}
function loadAll(d = db) {
  const out = {};
  if (d === db) { for (const t of Object.keys(META)) out[t] = rowsOut(t); return out; }
  for (const { name } of d.prepare('SELECT name FROM _tables').all()) {
    const cs = d.prepare(`PRAGMA table_info(${q(name)})`).all().map(r => r.name).filter(n => !n.startsWith('_'));
    const rows = d.prepare(`SELECT "_k", "_pos", ${cs.map(q).join(', ')} FROM ${q(name)} ORDER BY "_pos", rowid`).all();
    out[name] = { cols: cs, rows: rows.map(r => [r._k, r._pos, ...cs.map(c => r[c] === null ? '' : r[c])]) };
  }
  return out;
}
function changesSince(since) {
  const rev = curRev();
  if (since < +metaGet('tombFloor', 0) || since > rev) return { rev, reload: true };   // base restaurée ou remplacée
  if (since >= rev) return { rev, tables: {}, deleted: {} };
  const tables = {}, deleted = {};
  for (const t of Object.keys(META)) { const r = rowsOut(t, 'WHERE "_rev" > ?', [since]); if (r.rows.length) tables[t] = r; }
  for (const r of stmt('SELECT t, k FROM _deleted WHERE rev > ?').all(since)) (deleted[r.t] = deleted[r.t] || []).push(r.k);
  return { rev, tables, deleted };
}

/* ---------- copies de sauvegarde ---------- */
let lastBackup = { at: 0, name: '', err: '' }, copyErr = '';
const bkList = dir => { try { return fs.readdirSync(dir).filter(n => /^TMT-.*\.db$/.test(n)).sort().reverse().map(n => { const st = fs.statSync(path.join(dir, n)); return { name: n, size: st.size, at: st.mtime.toISOString() }; }).sort((a, b) => b.at.localeCompare(a.at)); } catch (e) { return []; } };   // la plus récente d'abord
function verifyDb(file) {
  let d = null;
  try {
    try { d = new DatabaseSync(file, { readOnly: true }); } catch (e) { d = new DatabaseSync(file); }
    const ok = d.prepare('PRAGMA integrity_check').get();
    const v = ok && Object.values(ok)[0];
    if (v !== 'ok') throw new Error('contrôle d\'intégrité : ' + v);
    const n = {}; for (const { name } of d.prepare('SELECT name FROM _tables').all()) n[name] = d.prepare(`SELECT COUNT(*) AS n FROM ${q(name)}`).get().n;
    return n;
  } finally { try { d && d.close(); } catch (e) { } }
}
function backupNow(suffix) {
  const name = suffix ? `TMT-${dayStr()}-${hmStr()}-${suffix}.db` : `TMT-${dayStr()}.db`;
  const dest = path.join(BK_DIR, name), tmp = dest + '.tmp';
  try { fs.rmSync(tmp, { force: true }); } catch (e) { }
  db.exec(`VACUUM INTO ${"'" + tmp.replace(/'/g, "''") + "'"}`);
  verifyDb(tmp);
  fs.renameSync(tmp, dest);
  // une copie par mois, gardée
  const mName = `TMT-${dayStr().slice(0, 7)}.db`;
  if (!fs.existsSync(path.join(BK_MONTH, mName))) fs.copyFileSync(dest, path.join(BK_MONTH, mName));
  // garder les copies des 30 derniers jours
  const limit = dayStr(new Date(Date.now() - KEEP_DAYS * 864e5));
  for (const b of bkList(BK_DIR)) { const m = b.name.match(/^TMT-(\d{4}-\d{2}-\d{2})/); if (m && m[1] < limit) try { fs.rmSync(path.join(BK_DIR, b.name)); } catch (e) { } }
  // copie supplémentaire (OneDrive, clé USB, disque réseau…)
  copyErr = '';
  if (COPY_TO) {
    try {
      fs.mkdirSync(COPY_TO, { recursive: true }); fs.copyFileSync(dest, path.join(COPY_TO, name));
      if (fs.existsSync(PHOTO_DIR)) { const pd = path.join(COPY_TO, 'photos'); fs.mkdirSync(pd, { recursive: true }); for (const n of fs.readdirSync(PHOTO_DIR)) if (n.endsWith('.jpg') && !fs.existsSync(path.join(pd, n))) fs.copyFileSync(path.join(PHOTO_DIR, n), path.join(pd, n)); }   // photos : seulement les nouvelles
      for (const b of bkList(COPY_TO)) { const m = b.name.match(/^TMT-(\d{4}-\d{2}-\d{2})/); if (m && m[1] < limit && !fs.existsSync(path.join(BK_MONTH, b.name))) try { fs.rmSync(path.join(COPY_TO, b.name)); } catch (e) { } }
    } catch (e) { copyErr = e.message; log('⚠ copie vers', COPY_TO, 'impossible :', e.message); }
  }
  lastBackup = { at: Date.now(), name, err: '' };
  log('Copie de sauvegarde :', name);
  return name;
}
let bkRev = -1;
function dailyBackup() {   // copie du jour, remise à jour toutes les 2 h s'il y a eu des modifications
  try {
    const f = path.join(BK_DIR, `TMT-${dayStr()}.db`), rev = curRev();
    if (!fs.existsSync(f) || (rev !== bkRev && Date.now() - fs.statSync(f).mtimeMs > 2 * 3600e3)) { backupNow(); bkRev = rev; }
  }
  catch (e) { lastBackup.err = e.message; log('⚠ copie de sauvegarde impossible :', e.message); }
}
function safeBk(name) {
  const n = path.basename(String(name || ''));
  if (!/^TMT-[\w-]+\.db$/.test(n)) throw new Error('nom de copie invalide');
  const f = [path.join(BK_DIR, n), path.join(BK_MONTH, n)].find(x => fs.existsSync(x));
  if (!f) throw new Error('copie introuvable : ' + n);
  return f;
}
function restoreFrom(file) {
  verifyDb(file);
  const before = backupNow('avant-restauration');
  const oldRev = curRev(), users = db.prepare('SELECT * FROM _users').all(), sessions = db.prepare('SELECT * FROM _sessions').all();
  db.close(); STMT.clear();
  for (const x of ['-wal', '-shm']) try { fs.rmSync(DB_FILE + x, { force: true }); } catch (e) { }
  fs.copyFileSync(file, DB_FILE + '.restore'); fs.renameSync(DB_FILE + '.restore', DB_FILE);
  openDb();
  db.exec('DELETE FROM _users; DELETE FROM _sessions;');   // les comptes actuels sont gardés (pas ceux de la copie)
  for (const u of users) db.prepare('INSERT INTO _users (id, login, nom, hash, perms, actif, created, last_login, prefs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(u.id, u.login, u.nom, u.hash, u.perms, u.actif, u.created, u.last_login, u.prefs ?? null);
  for (const x of sessions) db.prepare('INSERT INTO _sessions (token, user_id, created, seen, pc) VALUES (?, ?, ?, ?, ?)').run(x.token, x.user_id, x.created, x.seen, x.pc);
  const rev = Math.max(oldRev, curRev()) + 1; metaSet('rev', rev); metaSet('tombFloor', rev);   // tous les postes rechargent
  log('Base restaurée depuis', path.basename(file), '(copie de l\'état précédent :', before + ')');
  return { rev, before };
}

/* ---------- HTTP ---------- */
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
const isLocal = req => { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; };
function hostOk(req) {
  const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (['localhost', '127.0.0.1', '::1'].includes(h)) return true;
  if (!LAN) return false;
  return lanIps().includes(h) || h === os.hostname().toLowerCase() || h.endsWith('.local') || /^[a-z0-9-]+$/.test(h);
}
function send(req, res, code, body, type) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (buf.length > 64000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { buf = zlib.gzipSync(buf, { level: 1 }); h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = buf.length;
  res.writeHead(code, h); res.end(buf);
}
function readBody(req, max = 400e6) {
  return new Promise((ok, ko) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { ko(new Error('trop volumineux')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { const s = Buffer.concat(parts).toString('utf8'); ok(s ? JSON.parse(s) : {}); } catch (e) { ko(new Error('requête incomplète ou illisible')); } });
    req.on('error', ko); req.on('aborted', () => ko(new Error('requête interrompue')));
  });
}
function readRaw(req, max) {
  return new Promise((ok, ko) => { const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { ko(Object.assign(new Error('fichier trop volumineux'), { code: 400 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts))); req.on('error', ko); req.on('aborted', () => ko(new Error('envoi interrompu'))); });
}
function unzip(buf) {   // lecture d'un .zip (stocké ou « deflate »), sans dépendance
  const bad = m => Object.assign(new Error('fichier .zip invalide' + (m ? ' : ' + m : '')), { code: 400 });
  if (buf.length < 22) throw bad();
  let e = buf.length - 22; while (e >= Math.max(0, buf.length - 70000) && buf.readUInt32LE(e) !== 0x06054b50) e--; if (e < 0 || buf.readUInt32LE(e) !== 0x06054b50) throw bad();
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw bad('répertoire');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl).replace(/\\/g, '/'); p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw bad('entrée');
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), data = buf.subarray(ds, ds + csize);
    if (method === 0) out.set(name, Buffer.from(data)); else if (method === 8) out.set(name, zlib.inflateRawSync(data)); else throw bad('compression non gérée');
  }
  return out;
}
function installUpdate(buf, U, force) {
  const files = unzip(buf), key = [...files.keys()].find(k => /(^|\/)serveur\/server\.js$/.test(k));
  if (!key) return { ok: false, error: 'ce fichier n\'est pas une mise à jour de TMT Gestion (dossier « serveur » introuvable) : choisissez TMT-Gestion-MISE-A-JOUR_….zip ou TMT-Gestion-SQL_….zip' };
  const pre = key.slice(0, -'server.js'.length), top = pre.slice(0, -'serveur/'.length), rel = new Map();
  for (const [k, v] of files) if (k.startsWith(pre)) { const r = k.slice(pre.length); if (r && !r.split('/').some(x => x === '..' || x === '')) rel.set(r, v); }
  const srv = rel.get('server.js'), app = rel.get('app/index.html');
  let mj = null; try { if (rel.has('maj.json')) mj = JSON.parse(rel.get('maj.json').toString('utf8')); } catch (e) { return { ok: false, error: 'maj.json illisible' }; }
  rel.delete('maj.json');
  if (!/TMT Gestion — serveur local/.test(srv.toString('utf8')) || (app ? !/<title>TMT Gestion/.test(app.toString('utf8')) : !mj)) return { ok: false, error: 'fichiers de TMT Gestion manquants ou invalides dans le .zip' };
  if (mj) {   // paquet « mise à jour » : seulement les fichiers changés ; les autres doivent être identiques à ceux de la version visée
    const sha = b => crypto.createHash('sha256').update(b).digest('hex'), manque = [];
    for (const [r, h] of Object.entries(mj.hashes || {})) { const b = rel.has(r) ? rel.get(r) : (() => { try { return fs.readFileSync(path.join(__dirname, ...r.split('/'))); } catch (e) { return null; } })(); if (!b || sha(b) !== h) manque.push(r); }
    if (manque.length) return { ok: false, error: `ce paquet de mise à jour (${mj.base || '?'} → ${mj.build || '?'}) ne correspond pas à la version installée (${readVer(__dirname).build || '?'}) : installez le paquet complet TMT-Gestion-SQL_….zip` };
  }
  let nv = {}; try { nv = JSON.parse((rel.get('version.json') || '{}').toString('utf8')); } catch (e) { }
  const cur = readVer(__dirname).build || '', nb = nv.build || '';
  if (!force && nb && cur && nb === cur) return { ok: false, same: true, error: `cette version (${nb}) est déjà installée` };
  if (!force && nb && cur && nb < cur) return { ok: false, older: true, error: `cette mise à jour (${nb}) est plus ancienne que la version installée (${cur})` };
  const chk = path.join(os.tmpdir(), 'tmt-maj-' + process.pid + '.js'); fs.writeFileSync(chk, srv);   // le nouveau serveur doit être du JavaScript valide
  try { const r = cp.spawnSync(process.execPath, ['--check', chk], { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) return { ok: false, error: 'nouveau serveur invalide : ' + String(r.stderr || '').split('\n').slice(0, 3).join(' ') }; } finally { try { fs.unlinkSync(chk); } catch (e) { } }
  const bk = backupNow('avant-mise-a-jour');   // copie de la base avant tout
  fs.rmSync(PREV_DIR, { recursive: true, force: true }); fs.cpSync(__dirname, PREV_DIR, { recursive: true });   // version actuelle gardée pour le retour arrière
  let n = 0;
  for (const [r, v] of rel) { const f = path.join(__dirname, ...r.split('/')); if (!f.startsWith(__dirname + path.sep)) continue; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.maj', v); fs.renameSync(f + '.maj', f); n++; }
  const lis = files.get(top + 'LISEZMOI.txt'); if (lis) { try { fs.writeFileSync(path.join(ROOT, 'LISEZMOI.txt'), lis); } catch (e) { } }
  const rec = { date: new Date().toISOString(), par: U.login, de: cur, vers: nb, fichiers: n, sauvegarde: bk, paquet: mj ? 'mise à jour' : 'complet' };
  try { fs.writeFileSync(path.join(DATA, 'mise-a-jour.json'), JSON.stringify(rec, null, 2)); } catch (e) { }
  log(`Mise à jour installée par ${U.login} : ${cur || '?'} → ${nb || '?'} (${n} fichier(s), sauvegarde ${bk})`);
  return { ok: true, restart: SUPERVISED, from: cur, to: nb, files: n, backup: bk, partiel: !!mj };
}
function rollbackUpdate(U) {
  if (!fs.existsSync(path.join(PREV_DIR, 'server.js'))) return { ok: false, error: 'aucune version précédente gardée' };
  const cur = readVer(__dirname).build || '', pv = readVer(PREV_DIR).build || '';
  const tmp = path.join(ROOT, 'serveur.annule'); fs.rmSync(tmp, { recursive: true, force: true }); fs.cpSync(__dirname, tmp, { recursive: true });
  fs.cpSync(PREV_DIR, __dirname, { recursive: true, force: true });
  fs.rmSync(PREV_DIR, { recursive: true, force: true }); fs.renameSync(tmp, PREV_DIR);   // la version annulée devient « précédente » (on peut revenir)
  log(`Retour à la version précédente par ${U.login} : ${cur} → ${pv}`);
  try { fs.writeFileSync(path.join(DATA, 'mise-a-jour.json'), JSON.stringify({ date: new Date().toISOString(), par: U.login, de: cur, vers: pv, retour: true }, null, 2)); } catch (e) { }
  return { ok: true, restart: SUPERVISED, from: cur, to: pv };
}
function auditList(p, U) {
  const w = [], a = [], money = U.perms.has('montants');
  if (p.get('du')) { w.push('at >= ?'); a.push(p.get('du')); }
  if (p.get('au')) { w.push('at < ?'); a.push(p.get('au') + 'T99'); }
  if (p.get('t')) { w.push('t = ?'); a.push(p.get('t')); }
  if (p.get('act')) { w.push('act = ?'); a.push(p.get('act')); }
  if (p.get('u')) { w.push('login = ?'); a.push(p.get('u')); }
  if (p.get('q')) { w.push('(data LIKE ? OR k LIKE ?)'); a.push('%' + p.get('q') + '%', '%' + p.get('q') + '%'); }
  if (!money) w.push(`t NOT IN (${[...MONEY_TABLES].map(t => `'${t}'`).join(',')})`);
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '', lim = Math.min(500, +p.get('limit') || 200), off = +p.get('offset') || 0;
  const rows = stmt(`SELECT * FROM _audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...a, lim, off).map(r => {
    const d = jsonOr(r.data, {});
    if (!money && MONEY_COLS[r.t]) for (const c of MONEY_COLS[r.t]) { if (d.c) delete d.c[c]; if (d.v) delete d.v[c]; }
    return { id: r.id, rev: r.rev, at: r.at, login: r.login, nom: r.nom, pc: r.pc, t: r.t, k: r.k, act: r.act, data: d };
  }).filter(r => r.act !== 'modif' || !r.data.c || Object.keys(r.data.c).length);
  const total = stmt(`SELECT COUNT(*) AS n FROM _audit ${where}`).get(...a).n;
  const users = stmt('SELECT DISTINCT login, nom FROM _audit WHERE login <> \'\' ORDER BY nom').all();
  return { rows, total, users, jours: AUDIT_DAYS };
}
let SERVER = null;
function restartSelf() {   // le superviseur relance le serveur (nouveau code) — les requêtes en cours se terminent d'abord
  log('Redémarrage du serveur…');
  const done = () => { try { db.close(); } catch (e) { } process.exit(99); };
  try { if (SERVER) { SERVER.close(done); if (SERVER.closeIdleConnections) SERVER.closeIdleConnections(); setTimeout(done, 4000).unref(); } else done(); } catch (e) { done(); }
}
function info() {
  let size = 0; try { size = fs.statSync(DB_FILE).size + (fs.existsSync(DB_FILE + '-wal') ? fs.statSync(DB_FILE + '-wal').size : 0); } catch (e) { }
  const counts = {}; for (const t of Object.keys(META)) counts[t] = stmt(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n;
  const last = stmt('SELECT rev, at, pc FROM _saves ORDER BY rev DESC LIMIT 1').get() || null;
  return { app: 'TMT Gestion', version: VERSION, node: process.versions.node, sqlite: db.prepare('SELECT sqlite_version() AS v').get().v, dbFile: DB_FILE, dataDir: DATA, size, rev: curRev(), counts, lastSave: last,
    backups: bkList(BK_DIR), monthly: bkList(BK_MONTH), backupDir: BK_DIR, keepDays: KEEP_DAYS, lastBackup, copyTo: COPY_TO, copyErr,
    lan: LAN, lanPw: !!LAN_PW, urls: [`http://localhost:${PORT}`, ...(LAN ? lanIps().map(ip => `http://${ip}:${PORT}`) : [])], started: STARTED, host: os.hostname(), cfgErr: CFG_ERR, build: readVer(__dirname).build || '', supervised: SUPERVISED };
}
const STARTED = new Date().toISOString();

async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (!hostOk(req)) return send(req, res, 403, { error: 'hôte refusé' });
  if (!isLocal(req)) {
    if (!LAN) return send(req, res, 403, { error: 'accès réseau désactivé' });
    if (LAN_PW) {
      const a = String(req.headers.authorization || ''), m = a.match(/^Basic (.+)$/), pw = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : null;
      if (pw !== LAN_PW) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TMT Gestion", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Mot de passe requis'); }
    }
  }
  if (req.method === 'POST') {   // protection : une page d'un autre site ne peut pas écrire
    const o = req.headers.origin; if (o && o !== 'null') { let oh = ''; try { oh = new URL(o).host; } catch (e) { } if (oh !== req.headers.host) return send(req, res, 403, { error: 'origine refusée' }); }
  }
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    let html; try { html = fs.readFileSync(APP_FILE); } catch (e) { return send(req, res, 500, 'Application introuvable : ' + APP_FILE, 'text/plain; charset=utf-8'); }
    return send(req, res, 200, html, 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && p === '/manifest.webmanifest') return send(req, res, 200, JSON.stringify({ name: 'TMT Gestion', short_name: 'TMT', start_url: '/?p=aujourdhui', scope: '/', display: 'standalone', background_color: '#f3f5f8', theme_color: '#0a8fe0', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] }), 'application/manifest+json');
  if (req.method === 'GET' && /^\/icon-(192|512)\.png$/.test(p)) { let b; try { b = fs.readFileSync(path.join(__dirname, 'app', p.slice(1))); } catch (e) { return send(req, res, 404, { error: 'introuvable' }); } return send(req, res, 200, b, 'image/png'); }
  /* ---------- relevé sous-traitant : lien de partage temporaire (24 h), instantané figé, aucune connexion ----------
     Page publique autonome (pas de compte, pas de session, aucun appel API depuis cette page) : elle affiche
     uniquement le document déjà généré et enregistré au moment du partage (voir POST /api/releve/share) — donc
     aucun risque de fuite d'une autre donnée de l'application, même si le jeton est deviné ou partagé plus loin. */
  if (req.method === 'GET' && p.startsWith('/releve/')) {
    const token = decodeURIComponent(p.slice('/releve/'.length)).trim();
    const r = /^[0-9a-f]{20,80}$/i.test(token) ? db.prepare('SELECT * FROM _releve_shares WHERE token = ?').get(tokHash(token)) : null;
    const page = (title, body) => send(req, res, 200, `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${appStyleCss()}</style><body>${body}</body></html>`, 'text/html; charset=utf-8');
    if (!r) return page('Lien invalide', '<div style="font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;text-align:center;color:#333;padding:0 16px"><h2>Lien invalide</h2><p style="color:#666">Demandez un nouveau lien à STE TAKE ME TRANS.</p></div>');
    if (Date.now() > r.exp) return page('Lien expiré', '<div style="font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;text-align:center;color:#333;padding:0 16px"><h2>Ce lien a expiré</h2><p style="color:#666">Demandez un nouveau lien à STE TAKE ME TRANS.</p></div>');
    return page('Relevé — ' + r.presta, `<div style="max-width:900px;margin:16px auto;padding:0 12px"><div class="row" style="justify-content:flex-end;margin-bottom:10px;print:none" id="noprint"><button class="btn pri" onclick="window.print()">🖶 Imprimer / PDF</button></div><div id="printArea">${r.html}</div></div><style>@media print{#noprint{display:none}}</style>`);
  }
  if (!p.startsWith('/api/')) return send(req, res, 404, { error: 'introuvable' });
  const api = p.slice(5);
  try {
    if (api === 'ping') return send(req, res, 200, { app: 'TMT Gestion', ok: true });
    /* ---------- connexion ---------- */
    if (api === 'me' && req.method === 'GET') {
      const u = sessionUser(req);
      return send(req, res, 200, u ? { user: { id: u.id, login: u.login, nom: u.nom, perms: [...u.perms], prefs: u.prefs } } : { user: null, setup: nbUsers() === 0, local: isLocal(req) });
    }
    if (req.method === 'POST' && ['login', 'logout', 'setup'].includes(api)) {
      const body = await readBody(req, 1e5);
      if (api === 'logout') { const t = cookieOf(req); if (t) stmt('DELETE FROM _sessions WHERE token = ?').run(tokHash(t)); res.setHeader('Set-Cookie', 'tmt_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return send(req, res, 200, { ok: true }); }
      if (api === 'setup') {   // premier compte (gérant) : seulement sur l'ordinateur principal, base sans utilisateur
        if (nbUsers() > 0) return send(req, res, 403, { error: 'des utilisateurs existent déjà' });
        if (!isLocal(req)) return send(req, res, 403, { error: 'le premier compte se crée sur l\'ordinateur principal' });
        const login = String(body.login || '').trim(), nom = String(body.nom || '').trim() || login;
        if (!/^[\w.@-]{2,40}$/.test(login)) return send(req, res, 400, { error: 'identifiant invalide (lettres, chiffres, . _ - @)' });
        if (String(body.password || '').length < 6) return send(req, res, 400, { error: 'mot de passe : 6 caractères minimum' });
        const id = crypto.randomBytes(6).toString('hex');
        db.prepare('INSERT INTO _users (id, login, nom, hash, perms, actif, created) VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, login, nom, hashPw(body.password), JSON.stringify(PERMS), new Date().toISOString());
        log('Premier compte créé :', login); newSession(res, id, body.pc); auditEvent({ login, nom: body.nom || login }, [body.pc, req.socket.remoteAddress].filter(Boolean).join(' · '), '_connexion', login, 'connexion', { lab: { login }, premier: 1 }); return send(req, res, 200, { ok: true });
      }
      const login = String(body.login || '').trim(), key = login.toLowerCase() + '|' + (req.socket.remoteAddress || '');
      if (tooMany(key)) return send(req, res, 429, { error: 'trop d\'essais : attendez quelques minutes' });
      const r = db.prepare('SELECT * FROM _users WHERE login = ?').get(login);
      if (!r || !r.actif || !checkPw(body.password, r.hash)) { failed(key); log('Connexion refusée :', login); auditEvent({ login, nom: r ? r.nom : '' }, [body.pc, req.socket.remoteAddress].filter(Boolean).join(' · '), '_connexion', login, 'refus', { lab: { login } }); return send(req, res, 401, { error: 'identifiant ou mot de passe incorrect' }); }
      FAILS.delete(key); newSession(res, r.id, body.pc); log('Connexion :', r.login); auditEvent(r, [body.pc, req.socket.remoteAddress].filter(Boolean).join(' · '), '_connexion', r.login, 'connexion', { lab: { login: r.login } }); return send(req, res, 200, { ok: true });
    }
    const U = sessionUser(req);
    if (!U) return send(req, res, 401, { error: 'connexion requise', auth: false });
    const need = perm => { if (!U.perms.has(perm)) { const e = new Error('droit insuffisant'); e.code = 403; throw e; } };
    const photoNeed = id => need(/^ndf/.test(String(id || '')) ? 'caisse' : /^dec/.test(String(id || '')) ? 'rapports' : /^dep/.test(String(id || '')) ? 'depenses' : 'gasoil');   // reçus des notes de frais : droit Caisse ; décompte client : droit Rapports ; réparations/dépenses : droit Réparations
    if (req.method === 'GET') {
      if (api === 'rev') return send(req, res, 200, { rev: curRev(), perms: [...U.perms].join(','), build: readVer(__dirname).build || '' });
      if (api === 'update/info') { need('params'); const pv0 = fs.existsSync(path.join(PREV_DIR, 'server.js')) ? readVer(PREV_DIR) : null, pv = pv0 && (pv0.build || '') !== (readVer(__dirname).build || '') ? pv0 : null; let last = null; try { last = JSON.parse(fs.readFileSync(path.join(DATA, 'mise-a-jour.json'), 'utf8')); } catch (e) { } return send(req, res, 200, { build: readVer(__dirname).build || '', supervised: SUPERVISED, prev: pv ? (pv.build || '?') : '', last }); }
      if (api === 'load') return send(req, res, 200, { rev: curRev(), tables: filterTables(U, loadAll()), hidden: hiddenFor(U) });
      if (api === 'changes') {
        const c = changesSince(+url.searchParams.get('since') || 0);
        if (c.tables) { filterTables(U, c.tables); if (!U.perms.has('montants')) for (const t of MONEY_TABLES) delete c.deleted[t]; }
        return send(req, res, 200, c);
      }
      if (api === 'info') return send(req, res, 200, info());
      if (api === 'releve/current') {   // lien de partage déjà généré (non expiré) pour ce relevé, s'il existe
        need('rapports');
        const presta = String(url.searchParams.get('presta') || '').trim(), ym = String(url.searchParams.get('ym') || '').trim();
        const r = presta && ym ? db.prepare('SELECT plain, exp FROM _releve_shares WHERE presta = ? AND ym = ? AND exp > ? AND plain IS NOT NULL ORDER BY created DESC LIMIT 1').get(presta, ym, Date.now()) : null;
        return send(req, res, 200, { share: r ? { path: '/releve/' + r.plain, exp: r.exp } : null });
      }
      if (api === 'seed') { need('params'); const f = path.join(__dirname, 'seed.json'); return send(req, res, 200, fs.existsSync(f) ? fs.readFileSync(f) : { error: 'seed.json absent' }); }
      if (api === 'users') { need('users'); return send(req, res, 200, { users: db.prepare('SELECT * FROM _users ORDER BY nom COLLATE NOCASE').all().map(userOut), perms: PERMS }); }
      if (api === 'photo') {
        photoNeed(url.searchParams.get('id')); const f = photoFile(url.searchParams.get('id'));
        if (!fs.existsSync(f)) return send(req, res, 404, { error: 'photo introuvable' });
        const b = fs.readFileSync(f); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': b.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); return res.end(b);
      }
      if (api === 'audit') { need('users'); return send(req, res, 200, auditList(url.searchParams, U)); }
      if (api === 'audit/alerts') { need('users'); return send(req, res, 200, { alerts: stmt("SELECT * FROM _alerts WHERE vu = '' ORDER BY id DESC LIMIT 20").all().map(a => ({ ...a, detail: jsonOr(a.detail, {}) })) }); }
      if (api === 'srvconfig') { need('params'); return send(req, res, 200, { ...cfgOut(), local: isLocal(req) }); }
      if (api === 'backup/test') {
        need('params'); const f = safeBk(url.searchParams.get('name')); verifyDb(f);
        const d = new DatabaseSync(f); try { return send(req, res, 200, { name: path.basename(f), size: fs.statSync(f).size, tables: loadAll(d) }); } finally { d.close(); }
      }
      if (api === 'backup/download') {
        need('params'); const f = safeBk(url.searchParams.get('name')), b = fs.readFileSync(f);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(f)}"`, 'Content-Length': b.length }); return res.end(b);
      }
    }
    if (req.method === 'POST' && (api === 'update' || api === 'update/rollback' || api === 'restart')) {   // mise à jour du programme (gérant)
      need('params'); need('users');
      if (api === 'restart') { if (!SUPERVISED) return send(req, res, 400, { error: 'redémarrage automatique indisponible : fermez la fenêtre du serveur et relancez TMT Gestion' }); send(req, res, 200, { ok: true, restart: true }); log('Redémarrage demandé par', U.login); setTimeout(restartSelf, 600); return; }
      if (api === 'update/rollback') { const r = rollbackUpdate(U); send(req, res, 200, r); if (r.restart) setTimeout(restartSelf, 600); return; }
      const buf = await readRaw(req, 80e6), r = installUpdate(buf, U, url.searchParams.get('force') === '1');
      send(req, res, r.ok ? 200 : 400, r); if (r.ok && r.restart) setTimeout(restartSelf, 800); return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (api === 'photo') {
        photoNeed(body.id); const f = photoFile(body.id), m = String(body.data || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return send(req, res, 400, { error: 'photo : image JPEG attendue' });
        const b = Buffer.from(m[1], 'base64'); if (b.length > 4e6) return send(req, res, 400, { error: 'photo trop grande' });
        if (b[0] !== 0xff || b[1] !== 0xd8) return send(req, res, 400, { error: 'photo : fichier invalide' });
        fs.mkdirSync(PHOTO_DIR, { recursive: true }); fs.writeFileSync(f + '.tmp', b); fs.renameSync(f + '.tmp', f);
        return send(req, res, 200, { ok: true, size: b.length });
      }
      if (api === 'srvconfig') {
        need('params'); const n = body || {};
        if (!isLocal(req) && (n.reseau === false || n.port !== undefined)) return send(req, res, 403, { error: 'depuis le téléphone ou un autre poste, on ne peut pas couper l\'accès réseau ni changer le port (vous seriez déconnecté) : faites-le sur l\'ordinateur principal' });
        if (n.motDePasseReseau === '••••••') delete n.motDePasseReseau;
        const r = saveCfg(n); log('Réglages du serveur modifiés par', U.login); return send(req, res, 200, { ok: true, ...r, local: isLocal(req) });
      }
      if (api === 'audit/ack') { need('users'); stmt('UPDATE _alerts SET vu = ? WHERE id = ? OR ? = 1').run(new Date().toISOString() + ' ' + U.login, +body.id || 0, body.all ? 1 : 0); return send(req, res, 200, { ok: true }); }
      if (api === 'save') { const r = applySave(body, U); return send(req, res, 200, { ok: true, ...r }); }
      if (api === 'prefs') {   // préférences du compte connecté (chacun pour soi, aucun droit requis)
        const cur = jsonOr(db.prepare('SELECT prefs FROM _users WHERE id = ?').get(U.id).prefs, {}), next = { ...cur, ...(body.prefs && typeof body.prefs === 'object' ? body.prefs : {}) };
        const txt = JSON.stringify(next); if (txt.length > 20000) return send(req, res, 400, { error: 'préférences trop longues' });
        db.prepare('UPDATE _users SET prefs = ? WHERE id = ?').run(txt, U.id);
        return send(req, res, 200, { ok: true, prefs: next });
      }
      if (api === 'password') {   // changer son propre mot de passe
        const r = db.prepare('SELECT * FROM _users WHERE id = ?').get(U.id);
        if (!checkPw(body.old, r.hash)) return send(req, res, 400, { error: 'mot de passe actuel incorrect' });
        if (String(body.password || '').length < 6) return send(req, res, 400, { error: 'mot de passe : 6 caractères minimum' });
        db.prepare('UPDATE _users SET hash = ? WHERE id = ?').run(hashPw(body.password), U.id);
        db.prepare('DELETE FROM _sessions WHERE user_id = ? AND token <> ?').run(U.id, U.token);
        return send(req, res, 200, { ok: true });
      }
      if (api === 'users/save') {
        need('users');
        const id = String(body.id || ''), cur = id ? db.prepare('SELECT * FROM _users WHERE id = ?').get(id) : null;
        if (id && !cur) return send(req, res, 404, { error: 'utilisateur introuvable' });
        const login = String(body.login || '').trim(), nom = String(body.nom || '').trim() || login, perms = cleanPerms(body.perms), actif = body.actif === false ? 0 : 1, pw = String(body.password || '');
        if (!/^[\w.@-]{2,40}$/.test(login)) return send(req, res, 400, { error: 'identifiant invalide (lettres, chiffres, . _ - @, sans espace)' });
        const dup = db.prepare('SELECT id FROM _users WHERE login = ?').get(login); if (dup && dup.id !== id) return send(req, res, 400, { error: `l'identifiant « ${login} » existe déjà` });
        if ((!cur || pw) && pw.length < 6) return send(req, res, 400, { error: 'mot de passe : 6 caractères minimum' });
        if (!adminsLeft(id, { actif, perms })) return send(req, res, 400, { error: 'il faut garder au moins un utilisateur actif avec le droit « Gérer les utilisateurs »' });
        const nid = id || crypto.randomBytes(6).toString('hex');
        if (cur) db.prepare('UPDATE _users SET login = ?, nom = ?, perms = ?, actif = ?' + (pw ? ', hash = ?' : '') + ' WHERE id = ?').run(...[login, nom, JSON.stringify(perms), actif, ...(pw ? [hashPw(pw)] : []), id]);
        else db.prepare('INSERT INTO _users (id, login, nom, hash, perms, actif, created) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nid, login, nom, hashPw(pw), JSON.stringify(perms), actif, new Date().toISOString());
        if (cur && (!actif || pw)) db.prepare('DELETE FROM _sessions WHERE user_id = ?' + (id === U.id ? ' AND token <> ?' : '')).run(...(id === U.id ? [id, U.token] : [id]));
        log(`Utilisateur ${cur ? 'modifié' : 'créé'} par ${U.login} :`, login, perms.join(','), actif ? '' : '(désactivé)');
        return send(req, res, 200, { ok: true, id: nid });
      }
      if (api === 'releve/share') {   // relevé sous-traitant : figer l'instantané déjà calculé côté client et générer un lien de partage (durée choisie)
        need('rapports');
        const presta = String(body.presta || '').trim().slice(0, 200), ym = String(body.ym || '').trim().slice(0, 7), html = String(body.html || '');
        const heures = Math.min(720, Math.max(1, Math.round(Number(body.heures) || 24)));   // 1 h à 30 j, défaut 24 h
        if (!presta || !/^\d{4}-\d{2}$/.test(ym)) return send(req, res, 400, { error: 'prestataire ou mois manquant' });
        if (!html || html.length > 400000) return send(req, res, 400, { error: 'relevé invalide ou trop volumineux' });
        if (body.expirer) { const old = /^[0-9a-f]{20,80}$/i.test(String(body.expirer)) ? String(body.expirer) : ''; if (old) db.prepare('DELETE FROM _releve_shares WHERE token = ? AND created_by = ?').run(tokHash(old), U.login); }   // renouvellement : révoque l'ancien lien
        const token = crypto.randomBytes(24).toString('hex'), exp = Date.now() + heures * 3600e3;
        db.prepare('INSERT INTO _releve_shares (token, plain, presta, ym, html, exp, created, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(tokHash(token), token, presta, ym, html, exp, new Date().toISOString(), U.login);
        log(`Relevé partagé par ${U.login} :`, presta, ym, `(${heures} h)`);
        return send(req, res, 200, { ok: true, path: '/releve/' + token, exp });
      }
      if (api === 'releve/expire') {   // révoque immédiatement un lien de partage
        need('rapports');
        const t = String(body.token || ''); if (!/^[0-9a-f]{20,80}$/i.test(t)) return send(req, res, 400, { error: 'jeton invalide' });
        const n = db.prepare('DELETE FROM _releve_shares WHERE token = ?').run(tokHash(t)).changes;
        if (n) log(`Lien de relevé expiré manuellement par ${U.login}`);
        return send(req, res, 200, { ok: true });
      }
      if (api === 'users/delete') {
        need('users'); const id = String(body.id || '');
        if (id === U.id) return send(req, res, 400, { error: 'vous ne pouvez pas supprimer votre propre compte' });
        if (!adminsLeft(id, null)) return send(req, res, 400, { error: 'il faut garder au moins un utilisateur avec le droit « Gérer les utilisateurs »' });
        db.prepare('DELETE FROM _sessions WHERE user_id = ?').run(id); db.prepare('DELETE FROM _users WHERE id = ?').run(id);
        log('Utilisateur supprimé par', U.login, ':', id); return send(req, res, 200, { ok: true });
      }
      if (api === 'backup/now') { need('params'); return send(req, res, 200, { ok: true, name: backupNow(String(body.suffix || 'manuelle').replace(/[^\w-]/g, '').slice(0, 30) || 'manuelle'), info: info() }); }
      if (api === 'backup/restore') { need('params'); const r = restoreFrom(safeBk(body.name)); log('Restauration demandée par', U.login); return send(req, res, 200, { ok: true, ...r }); }
    }
    return send(req, res, 404, { error: 'introuvable' });
  } catch (e) {
    if (e.code === 403 || e.code === 400) return send(req, res, e.code, { error: e.message });
    log('⚠ erreur', req.method, p, ':', e.message);
    return send(req, res, 500, { error: e.message });
  }
}

/* ---------- démarrage ---------- */
function openBrowser(u) {
  try {
    if (process.platform === 'win32') cp.exec(`start "" msedge --app="${u}" --start-maximized`, { windowsHide: true }, err => { if (err) cp.exec(`start "" "${u}"`, { windowsHide: true }); });   // fenêtre Edge dédiée, comme avant
    else cp.spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [u], { detached: true, stdio: 'ignore' }).on('error', () => { });
  } catch (e) { }
}
function start() {
  openDb();
  const server = SERVER = http.createServer((req, res) => { handle(req, res).catch(e => { try { send(req, res, 500, { error: e.message }); } catch (e2) { } }); });
  if (SUPERVISED) process.on('disconnect', () => { try { db.close(); } catch (e) { } process.exit(0); });   // superviseur arrêté : on s'arrête aussi
  server.requestTimeout = 0; server.headersTimeout = 60000;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      // déjà lancé ? on ouvre simplement le navigateur
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 3000 }, r => {
        let s = ''; r.on('data', c => s += c); r.on('end', () => { let ok = false; try { ok = JSON.parse(s).app === 'TMT Gestion'; } catch (x) { }
          if (ok) { console.log('TMT Gestion est déjà lancé : ouverture du navigateur.'); if (OPEN) openBrowser(`http://localhost:${PORT}`); setTimeout(() => process.exit(0), 500); }
          else { console.error(`Le port ${PORT} est déjà utilisé par un autre programme. Changez "port" dans config.json.`); process.exitCode = 2; setTimeout(() => process.exit(2), 15000); } });
      }).on('error', () => { console.error(`Le port ${PORT} est occupé.`); process.exit(2); });
      return;
    }
    console.error(e); process.exit(1);
  });
  server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
    log(`TMT Gestion ${VERSION} — http://localhost:${PORT}  ·  base : ${DB_FILE}  ·  Node ${process.versions.node}`);
    if (LAN) log('Accès réseau activé :', lanIps().map(ip => `http://${ip}:${PORT}`).join('  '), LAN_PW ? '(mot de passe demandé)' : '(sans mot de passe)');
    console.log('\n  Ne fermez pas cette fenêtre pendant l\'utilisation de TMT Gestion.\n');
    dailyBackup();
    setInterval(dailyBackup, 20 * 60000).unref();
    if (OPEN && !process.env.TMT_RESTART) openBrowser(`http://localhost:${PORT}`);
    if (process.env.TMT_RESTART) log('Serveur relancé — version', readVer(__dirname).build || '?');
  });
  const stop = () => { log('Arrêt du serveur'); try { db.close(); } catch (e) { } process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
}

/* superviseur : lance le serveur, le relance après une mise à jour (code 99) ; si la nouvelle version
   ne démarre pas, remet la version précédente (serveur.precedent) et relance.                     */
function supervise() {
  let child = null, stopping = false, updAt = 0;
  const restorePrev = () => { try { if (!fs.existsSync(path.join(PREV_DIR, 'server.js'))) return false; fs.cpSync(PREV_DIR, __dirname, { recursive: true, force: true }); log('⚠ La nouvelle version ne démarre pas : version précédente remise en place'); try { fs.writeFileSync(path.join(DATA, 'mise-a-jour.json'), JSON.stringify({ date: new Date().toISOString(), echec: true }, null, 2)); } catch (e) { } return true; } catch (e) { log('⚠ retour arrière impossible :', e.message); return false; } };
  const run = restart => {
    const args = ['--no-warnings', __filename, ...ARGS.filter(a => !(restart && a === '--ouvrir'))], t0 = Date.now();
    child = cp.spawn(process.execPath, args, { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...process.env, TMT_WORKER: '1', ...(restart ? { TMT_RESTART: '1' } : {}) } });
    child.on('exit', code => {
      if (stopping) return process.exit(code || 0);
      if (code === 99) { console.log('\n  ⟳ Redémarrage de TMT Gestion…\n'); updAt = Date.now(); return setTimeout(() => run(true), 300); }
      if (updAt && Date.now() - t0 < 60000 && code !== 0 && code !== 2 && restorePrev()) { updAt = 0; return setTimeout(() => run(true), 300); }
      process.exit(code == null ? 1 : code);
    });
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { stopping = true; try { if (child) child.kill(s); } catch (e) { } setTimeout(() => process.exit(0), 5000).unref(); });
  run(false);
}

/* mot de passe oublié : sur l'ordinateur principal, nouveau mot de passe pour un compte */
async function resetPasswordCli() {
  openDb();
  const users = db.prepare('SELECT * FROM _users ORDER BY nom').all().map(userOut);
  if (!users.length) { console.log('\n  Aucun compte : ouvrez TMT Gestion pour créer le compte du gérant.\n'); return; }
  console.log('\n  Comptes :'); for (const u of users) console.log(`   - ${u.login.padEnd(20)} ${u.nom}${u.perms.includes('users') ? '  (gère les utilisateurs)' : ''}${u.actif ? '' : '  [désactivé]'}`);
  const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator](), ask = async qn => { process.stdout.write(qn); const r = await lines.next(); if (!process.stdin.isTTY) process.stdout.write('\n'); return r.done ? '' : r.value; };
  try {
    const login = (await ask('\n  Identifiant du compte : ')).trim();
    const r = db.prepare('SELECT * FROM _users WHERE login = ?').get(login); if (!r) { console.log('  Compte introuvable.'); return; }
    const p1 = await ask('  Nouveau mot de passe (6 caractères minimum) : '), p2 = await ask('  Retapez-le : ');
    if (p1.length < 6 || p1 !== p2) { console.log('  Mots de passe trop courts ou différents : rien n\'a été changé.'); return; }
    db.prepare('UPDATE _users SET hash = ?, actif = 1 WHERE id = ?').run(hashPw(p1), r.id); db.prepare('DELETE FROM _sessions WHERE user_id = ?').run(r.id);
    log('Mot de passe réinitialisé sur l\'ordinateur principal pour', r.login);
    console.log(`\n  C'est fait : connectez-vous avec « ${r.login} » et le nouveau mot de passe.\n`);
  } finally { rl.close(); }
}

if (require.main === module) {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) { console.error(`Node.js ${process.versions.node} est trop ancien : installez Node.js 22.13 ou plus récent (voir LISEZMOI).`); process.exit(3); }
  if (arg('mot-de-passe-oublie', false)) resetPasswordCli().then(() => { try { db.close(); } catch (e) { } process.exit(0); });
  else if (process.env.TMT_WORKER === '1' || arg('sans-superviseur', false)) start();
  else supervise();
}
module.exports = { applySave, changesSince, loadAll, openDb, backupNow };
