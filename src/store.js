'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// เก็บไฟล์ตั้งค่าไว้ในโฟลเดอร์ที่เขียนได้ (สำคัญเมื่อรันแบบ packaged/Electron)
// กำหนดผ่าน env TOOLHOSO4_CONFIG_DIR ได้ ไม่งั้นใช้ ../config (ตอน dev)
const CONFIG_DIR = process.env.TOOLHOSO4_CONFIG_DIR || path.join(__dirname, '..', 'config');
const CONN_FILE = path.join(CONFIG_DIR, 'connections.json');
const TABLE_FILE = path.join(CONFIG_DIR, 'tables.json');
const KEY_FILE = path.join(CONFIG_DIR, '.key');

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

// เมื่อรันครั้งแรก (โฟลเดอร์ตั้งค่าว่าง) ให้คัดลอกค่าเริ่มต้นที่แถมมากับโปรแกรม
const DEFAULTS_DIR = path.join(__dirname, '..', 'default-config');
try {
  const defTables = path.join(DEFAULTS_DIR, 'tables.json');
  if (!fs.existsSync(TABLE_FILE) && fs.existsSync(defTables)) {
    fs.copyFileSync(defTables, TABLE_FILE);
  }
} catch (e) { /* ไม่มีค่าเริ่มต้นก็ไม่เป็นไร */ }

/* ---------- การเข้ารหัสรหัสผ่าน (AES-256-GCM) ---------- */
function getKey() {
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), 'utf8');
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'enc:' + [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value || '';
  try {
    const [, ivHex, tagHex, dataHex] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/* ---------- Connections ---------- */
const EMPTY_CONN = { engine: 'postgres', host: '', port: 5432, database: '', user: '', password: '', ssl: false, label: '' };
const VALID_ENGINES = new Set(['postgres', 'mysql']);
function normEngine(e) {
  e = String(e || '').toLowerCase();
  if (e === 'postgresql' || e === 'pg' || e === 'postgre') e = 'postgres';
  if (e === 'mariadb' || e === 'maria') e = 'mysql';
  return VALID_ENGINES.has(e) ? e : 'postgres';
}

function getConnections({ withPassword = false } = {}) {
  const raw = readJson(CONN_FILE, { source: { ...EMPTY_CONN }, target: { ...EMPTY_CONN } });
  const out = {};
  for (const side of ['source', 'target']) {
    const c = Object.assign({ ...EMPTY_CONN }, raw[side] || {});
    c.engine = normEngine(c.engine);
    c.password = withPassword ? decrypt(c.password) : (c.password ? '********' : '');
    out[side] = c;
  }
  return out;
}

function getConnection(side) {
  const all = getConnections({ withPassword: true });
  return all[side];
}

function saveConnections(payload) {
  const current = readJson(CONN_FILE, {});
  const next = {};
  for (const side of ['source', 'target']) {
    const incoming = payload[side] || {};
    const prev = current[side] || {};
    const engine = normEngine(incoming.engine !== undefined ? incoming.engine : prev.engine);
    const c = {
      label: incoming.label || '',
      engine: engine,
      host: (incoming.host || '').trim(),
      port: Number(incoming.port) || (engine === 'mysql' ? 3306 : 5432),
      database: (incoming.database || '').trim(),
      user: (incoming.user || '').trim(),
      ssl: !!incoming.ssl,
      password: prev.password || ''
    };
    // ถ้าไม่ได้ส่งรหัสผ่านมา (หรือส่งเป็น mask) ให้คงรหัสผ่านเดิมไว้
    if (incoming.password !== undefined && incoming.password !== '' && incoming.password !== '********') {
      c.password = encrypt(incoming.password);
    }
    next[side] = c;
  }
  writeJson(CONN_FILE, next);
  return getConnections();
}

/* ---------- Table groups ---------- */
const DEFAULT_GROUPS = {
  basic: { key: 'basic', name: 'ข้อมูลพื้นฐาน (Basic Data)', icon: '🗂️', tables: [] },
  master: { key: 'master', name: 'ข้อมูลคนไข้ (Master Data)', icon: '🧑‍⚕️', tables: [] },
  visit: { key: 'visit', name: 'ข้อมูลประวัติ (Visit Data)', icon: '📋', tables: [] }
};

function getGroups() {
  const raw = readJson(TABLE_FILE, null);
  if (!raw) {
    writeJson(TABLE_FILE, DEFAULT_GROUPS);
    return JSON.parse(JSON.stringify(DEFAULT_GROUPS));
  }
  const out = {};
  for (const key of Object.keys(DEFAULT_GROUPS)) {
    out[key] = Object.assign({}, DEFAULT_GROUPS[key], raw[key] || {});
    out[key].tables = Array.isArray(out[key].tables) ? out[key].tables : [];
  }
  return out;
}

function getGroup(key) {
  const g = getGroups();
  return g[key] || null;
}

function saveGroupTables(key, tables) {
  const groups = getGroups();
  if (!groups[key]) throw new Error('ไม่พบกลุ่มข้อมูล: ' + key);
  groups[key].tables = (tables || []).map(t => ({
    table: String(t.table || '').trim(),
    schema: String(t.schema || 'public').trim() || 'public',
    label: String(t.label || '').trim(),
    keyColumns: Array.isArray(t.keyColumns) ? t.keyColumns.filter(Boolean) : [],
    dateColumn: t.dateColumn || '',
    enabled: t.enabled !== false
  })).filter(t => t.table);
  writeJson(TABLE_FILE, groups);
  return groups[key];
}

module.exports = {
  getConnections, getConnection, saveConnections,
  getGroups, getGroup, saveGroupTables,
  encrypt, decrypt, CONFIG_DIR
};
