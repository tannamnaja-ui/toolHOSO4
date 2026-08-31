'use strict';
/* ============================================================
   ตัวรัน "สูตรเฉพาะตาราง" (recipe)
   ใช้กับตารางที่ต้องมี logic พิเศษ เช่น
   - ดึงข้อมูลต้นทางด้วยคิวรี่ที่กำหนดเอง (ตามช่วงวันที่)
   - แม็ปฟิลด์ query -> คอลัมน์ปลายทาง
   - lookup ค่าจากตารางอ้างอิงในปลายทาง (เช่น doctor.oldcode -> code)
   - เติมเฉพาะแถวที่ปลายทางยังไม่มี (ตาม key)
   ทำงานได้ทั้งปลายทาง PostgreSQL และ MySQL (ใช้ engine ของฝั่งนั้น)
   ============================================================ */

const crypto = require('crypto');
const { buildKeyPredicate, extractField, makeReasonGrouper, detectTargetEncoding, stripToWin874 } = require('./transfer');

const MAX_PARAMS = 30000;

/** สร้างค่าอัตโนมัติตามชนิดที่กำหนดในสูตร */
function genValue(kind) {
  switch (kind) {
    case 'guid32':   // GUID 32 ตัว hex พิมพ์ใหญ่ ไม่มีขีด เช่น CA74543DCFC9C4063C4628D24539F0FA
      return crypto.randomBytes(16).toString('hex').toUpperCase();
    case 'guid':     // แบบมีขีด 8-4-4-4-12
      return crypto.randomUUID().toUpperCase();
    default:
      return null;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function shortErr(e) {
  let m = e && e.message ? e.message : String(e);
  if (e && e.detail) m += ' | ' + e.detail;
  if (e && e.sqlMessage && !m.includes(e.sqlMessage)) m += ' | ' + e.sqlMessage;
  return m.length > 300 ? m.slice(0, 300) + '...' : m;
}

function keyStr(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function fmt(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  return String(v);
}

/* ---------- lookup: match -> ret จากตารางอ้างอิงปลายทาง ---------- */
async function resolveLookup(tgtCtx, def, values) {
  const eng = tgtCtx.eng;
  const map = new Map();
  const distinct = [...new Set(values.map(keyStr).filter(v => v !== ''))];
  if (!distinct.length) return map;
  for (const batch of chunk(distinct, 1000)) {
    let p = 1;
    const ph = batch.map(() => eng.ph(p++)).join(', ');
    const sql = 'select ' + eng.quote(def.match) + ' as k, ' + eng.quote(def.ret) + ' as v ' +
      'from ' + eng.qname(def.schema || 'public', def.table) +
      ' where ' + eng.quote(def.match) + ' in (' + ph + ')';
    const r = await eng.query(tgtCtx.pool, sql, batch);
    r.rows.forEach(row => { if (!map.has(keyStr(row.k))) map.set(keyStr(row.k), row.v); });
  }
  return map;
}

/* ---------- resolve ทุก map ที่สูตรต้องใช้ (รองรับ lookup แบบลูกโซ่) ---------- */
async function resolveAllMaps(tgtCtx, recipe, rows) {
  const defs = recipe.lookups || {};
  const maps = {};
  const firstInputs = {};
  const add = (name, v) => {
    if (v === null || v === undefined || v === '') return;
    (firstInputs[name] || (firstInputs[name] = new Set())).add(v);
  };

  // ระดับแรก: อินพุตจากฟิลด์ query โดยตรง
  for (const row of rows) {
    for (const c of recipe.columns) {
      if (c.lookup) add(c.lookup, row[c.field]);
      else if (c.lookupChain) add(c.lookupChain[0], row[c.field]);
    }
  }
  for (const name of Object.keys(firstInputs)) {
    maps[name] = await resolveLookup(tgtCtx, defs[name], [...firstInputs[name]]);
  }

  // ระดับลูกโซ่: อินพุตของ step ถัดไป = ผลลัพธ์ของ step ก่อนหน้า
  for (const c of recipe.columns) {
    if (!c.lookupChain) continue;
    for (let step = 1; step < c.lookupChain.length; step++) {
      const name = c.lookupChain[step];
      const ins = new Set();
      for (const row of rows) {
        let v = row[c.field];
        let ok = true;
        for (let s = 0; s < step; s++) {
          const m = maps[c.lookupChain[s]];
          v = m ? m.get(keyStr(v)) : undefined;
          if (v === null || v === undefined) { ok = false; break; }
        }
        if (ok && v !== null && v !== undefined && v !== '') ins.add(v);
      }
      if (maps[name]) {
        const missing = [...ins].filter(x => !maps[name].has(keyStr(x)));
        if (missing.length) {
          const m2 = await resolveLookup(tgtCtx, defs[name], missing);
          for (const [k, val] of m2) maps[name].set(k, val);
        }
      } else {
        maps[name] = await resolveLookup(tgtCtx, defs[name], [...ins]);
      }
    }
  }
  return maps;
}

/** อ่านค่าสูงสุดของคอลัมน์ในตารางปลายทาง (ใช้กับ seqFromMax)
 *  ไม่ใช้ coalesce เพื่อรองรับคอลัมน์ที่เป็นสตริงตัวเลขเติมศูนย์ (เช่น '0000123') */
async function getMaxColumn(tgtCtx, schema, table, column) {
  const eng = tgtCtx.eng;
  const r = await eng.query(tgtCtx.pool,
    'select max(' + eng.quote(column) + ') as m from ' + eng.qname(schema, table), []);
  const m = r.rows[0] && r.rows[0].m;
  return Number(m) || 0;
}

/** ทำความสะอาดข้อความ: ตัด NUL (0x00) และ control char ตกค้าง (คง tab/LF/CR)
 *  แก้ปัญหาแถวจากข้อมูลเก่า/WIN874 ที่มีอักขระควบคุม ทำให้ insert ล้มเหลวทั้งแถว */
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
function cleanText(v) {
  return (typeof v === "string") ? v.replace(CTRL_RE, "") : v;
}

/** แปลงค่าให้เป็นตัวเลข — ว่าง/ไม่ใช่ตัวเลข → null (สำหรับคอลัมน์ numeric/int) */
function coerceNumeric(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** คำนวณค่าของคอลัมน์ปลายทางหนึ่งช่อง
 *  rowCtx = { index, seqBase } สำหรับคอลัมน์ที่รันเลขต่อจากค่าสูงสุด */
function valueFor(row, c, maps, unmatched, rowCtx) {
  const v = rawValueFor(row, c, maps, unmatched, rowCtx);
  if (c.numeric) return coerceNumeric(v);   // คอลัมน์ตัวเลข: ค่าว่าง/ไม่ใช่ตัวเลข → NULL
  return cleanText(v);                       // ข้อความ: ตัดอักขระควบคุมที่ทำให้ insert ล้มเหลว
}

function rawValueFor(row, c, maps, unmatched, rowCtx) {
  if (c.seqFromMax) {
    const base = (rowCtx && rowCtx.seqBase[c.col]) || 0;
    const n = base + ((rowCtx && rowCtx.index) || 0) + 1;
    const pad = (c.seqFromMax && typeof c.seqFromMax === 'object' && c.seqFromMax.pad) ? c.seqFromMax.pad : 0;
    return pad ? String(n).padStart(pad, '0') : n;   // เติมศูนย์เป็นสตริงถ้ากำหนด pad
  }
  if (c.gen) return genValue(c.gen);
  if (Object.prototype.hasOwnProperty.call(c, 'const')) return c.const;
  let v = row[c.field];
  if (c.lookup) {
    const m = maps[c.lookup];
    if (v === null || v === undefined || v === '') return null;
    if (m && m.has(keyStr(v))) return m.get(keyStr(v));
    if (unmatched) (unmatched[c.lookup] || (unmatched[c.lookup] = new Set())).add(keyStr(v));
    return null;
  }
  if (c.lookupChain) {
    for (const name of c.lookupChain) {
      if (v === null || v === undefined || v === '') return null;
      const m = maps[name];
      const nv = m ? m.get(keyStr(v)) : undefined;
      if (nv === null || nv === undefined) {
        if (unmatched) (unmatched[name] || (unmatched[name] = new Set())).add(keyStr(v));
        return null;
      }
      v = nv;
    }
    return v;
  }
  return v === undefined ? null : v;
}

/** ฟิลด์คีย์ (ฝั่ง query) และคอลัมน์คีย์ (ฝั่งปลายทาง) — รองรับทั้งเดี่ยวและหลายคอลัมน์ */
function keyFieldsOf(recipe) {
  return recipe.keyFields || (recipe.keyField ? [recipe.keyField] : recipe.targetKey.slice());
}
/** สตริงคีย์ประกอบ (normalize ให้ต้นทาง/ปลายทางเทียบกันได้ข้ามชนิด) */
function compositeKey(vals) {
  return JSON.stringify(vals.map(v => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return 'D:' + v.toISOString();
    if (Buffer.isBuffer(v)) return 'B:' + v.toString('base64');
    return 'S:' + String(v);
  }));
}

/* ---------- หาแถวที่ปลายทางยังไม่มี (ตามคีย์ เดี่ยวหรือหลายคอลัมน์) ---------- */
async function findMissingRows(tgtCtx, recipe, rows, onProgress) {
  const eng = tgtCtx.eng;
  const keyFields = keyFieldsOf(recipe);      // ฟิลด์ในผลคิวรี่
  const targetCols = recipe.targetKey;        // คอลัมน์ปลายทาง (เรียงตรงกับ keyFields)
  const qcols = targetCols.map(eng.quote).join(', ');
  const table = eng.qname(recipe.schema || 'public', recipe.table);
  const size = Math.max(200, Math.min(2000, Math.floor(MAX_PARAMS / targetCols.length)));
  const missing = [];
  let done = 0;
  for (const batch of chunk(rows, size)) {
    // สร้าง object คีย์ (keyed by คอลัมน์ปลายทาง) จากค่าฟิลด์ต้นทาง
    const keyRows = batch.map(r => {
      const o = {}; targetCols.forEach((tc, i) => { o[tc] = r[keyFields[i]]; }); return o;
    });
    const pred = buildKeyPredicate(eng, targetCols, keyRows, 1);
    const res = await eng.query(tgtCtx.pool, 'select ' + qcols + ' from ' + table + ' where ' + pred.sql, pred.params, { array: true });
    const exist = new Set(res.rows.map(arr => compositeKey(arr)));
    for (const r of batch) {
      if (!exist.has(compositeKey(keyFields.map(f => r[f])))) missing.push(r);
    }
    done += batch.length;
    if (onProgress) onProgress({ checked: done, total: rows.length, missing: missing.length });
  }
  return missing;
}

async function countTargetByDate(tgtCtx, recipe, from, to) {
  if (!recipe.targetDateColumn || !from || !to) return null;
  const eng = tgtCtx.eng;
  try {
    const f = eng.dateFilter(recipe.targetDateColumn, 'date', from, to, 1);
    const where = f.sql ? ' where ' + f.sql : '';
    const r = await eng.query(tgtCtx.pool, 'select count(*) as n from ' + eng.qname(recipe.schema || 'public', recipe.table) + where, f.params);
    return Number(r.rows[0].n);
  } catch (e) { return null; }
}

/* ============================================================
   วิเคราะห์สูตร (plan) — สำหรับหน้าจอ/ตรวจก่อนโอน
   ============================================================ */
async function planRecipe(recipe, srcCtx, tgtCtx) {
  const plan = {
    table: recipe.table, schema: recipe.schema || 'public', label: recipe.label || recipe.table,
    recipe: true, keySource: 'สูตรเฉพาะ',
    keyColumns: recipe.targetKey.slice(), dateColumn: recipe.dateColumn || '',
    columns: recipe.columns.map(c => c.col),
    srcEngine: srcCtx.eng.name, tgtEngine: tgtCtx.eng.name,
    lookups: [], warnings: [], error: null
  };

  if (recipe.source.engine && srcCtx.eng.name !== recipe.source.engine) {
    plan.warnings.push('สูตรนี้ออกแบบสำหรับต้นทาง ' + recipe.source.engine + ' — ต้นทางปัจจุบันเป็น ' + srcCtx.eng.name);
  }

  try {
    const tgt = await tgtCtx.eng.describeTable(tgtCtx.pool, plan.schema, recipe.table);
    plan.tgtExists = tgt.exists;
    if (!tgt.exists) { plan.error = 'ไม่พบตาราง ' + recipe.table + ' ในฐานข้อมูลปลายทาง'; return plan; }
    const tgtCols = new Set(tgt.columns.map(c => c.name));
    const missingCols = plan.columns.filter(c => !tgtCols.has(c));
    if (missingCols.length) plan.warnings.push('ไม่พบคอลัมน์ในปลายทาง: ' + missingCols.join(', '));
  } catch (e) {
    plan.error = 'ตรวจตารางปลายทางไม่สำเร็จ: ' + shortErr(e);
    return plan;
  }

  for (const [name, def] of Object.entries(recipe.lookups || {})) {
    let exists = false;
    try { exists = (await tgtCtx.eng.describeTable(tgtCtx.pool, def.schema || 'public', def.table)).exists; } catch (e) {}
    plan.lookups.push({ name, table: def.table, match: def.match, ret: def.ret, exists });
    if (!exists) plan.warnings.push('ไม่พบตารางอ้างอิง "' + def.table + '" ในปลายทาง (ฟิลด์ที่ใช้ตารางนี้จะเป็น NULL)');
  }
  return plan;
}

/* ============================================================
   โอนข้อมูลตามสูตร
   ============================================================ */
async function transferRecipe(recipe, srcCtx, tgtCtx, from, to, emit, options) {
  options = options || {};
  const result = {
    table: recipe.table, schema: recipe.schema || 'public', label: recipe.label || recipe.table,
    recipe: true, keyColumns: recipe.targetKey.slice(), dateColumn: recipe.dateColumn || '',
    srcEngine: srcCtx.eng.name, tgtEngine: tgtCtx.eng.name, warnings: []
  };

  const timing = {};
  const secSince = t => ((Date.now() - t) / 1000).toFixed(1);

  // 1) รันคิวรี่ต้นทาง
  emit({ type: 'stage', table: recipe.table, stage: 'รันคิวรี่ต้นทาง (สูตรเฉพาะ)...' });
  let rows;
  const tQuery = Date.now();
  try {
    const q = recipe.source.sql(from, to);
    rows = (await srcCtx.eng.query(srcCtx.pool, q.text, q.params)).rows;
  } catch (e) {
    result.status = 'error';
    result.error = 'คิวรี่ต้นทางล้มเหลว: ' + shortErr(e);
    return result;
  }
  timing.queryMs = Date.now() - tQuery;
  result.sourceRows = rows.length;
  emit({ type: 'stage', table: recipe.table, stage: 'รันคิวรี่ต้นทางเสร็จใน ' + secSince(tQuery) + ' วินาที (' + rows.length.toLocaleString() + ' แถว)' });

  // dedupe ตามคีย์ (เดี่ยว/หลายคอลัมน์) — เก็บแถวแรก, ข้ามแถวที่คีย์หลัก (ตัวแรก) ว่าง
  const keyFields = keyFieldsOf(recipe);
  const seen = new Set();
  const uniq = [];
  for (const r of rows) {
    if (r[keyFields[0]] === null || r[keyFields[0]] === undefined || r[keyFields[0]] === '') continue;
    const k = compositeKey(keyFields.map(f => r[f]));
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }

  result.targetRows = await countTargetByDate(tgtCtx, recipe, from, to);

  if (!uniq.length) {
    result.status = 'ok'; result.missingRows = 0; result.inserted = 0; result.failed = 0;
    emit({ type: 'stage', table: recipe.table, stage: 'ไม่มีข้อมูลในช่วงวันที่ที่เลือก' });
    return result;
  }

  // 2) หาแถวที่ปลายทางยังไม่มี (ตามคีย์)
  emit({ type: 'stage', table: recipe.table, stage: 'ตรวจหาคีย์ที่ขาดในปลายทาง...' });
  const tCheck = Date.now();
  const missingRows = await findMissingRows(tgtCtx, recipe, uniq,
    p => emit(Object.assign({ type: 'progress', table: recipe.table, phase: 'check' }, p)));
  timing.checkMs = Date.now() - tCheck;
  result.missingRows = missingRows.length;
  emit({ type: 'stage', table: recipe.table, stage: 'ตรวจคีย์ที่ขาดเสร็จใน ' + secSince(tCheck) + ' วินาที (ขาด ' + missingRows.length.toLocaleString() + ')' });

  if (!missingRows.length) {
    result.status = 'ok'; result.inserted = 0; result.failed = 0;
    emit({ type: 'stage', table: recipe.table, stage: 'ข้อมูลครบแล้ว ไม่ต้องโอน' });
    return result;
  }

  if (options.dryRun) {
    result.status = 'dry-run'; result.inserted = 0; result.failed = 0;
    emit({ type: 'stage', table: recipe.table, stage: 'พบข้อมูลขาด ' + missingRows.length + ' แถว (โหมดตรวจสอบเท่านั้น)' });
    return result;
  }

  // 3) resolve lookups (บนปลายทาง)
  emit({ type: 'stage', table: recipe.table, stage: 'แปลงค่าอ้างอิง (lookup) ปลายทาง...' });
  let maps;
  try {
    maps = await resolveAllMaps(tgtCtx, recipe, missingRows);
  } catch (e) {
    result.status = 'error';
    result.error = 'lookup ล้มเหลว: ' + shortErr(e);
    return result;
  }

  // 3.5) เตรียมค่าเริ่มต้นของคอลัมน์ที่รันเลขต่อจากค่าสูงสุดในปลายทาง (seqFromMax)
  const seqBase = {};
  for (const c of recipe.columns) {
    if (c.seqFromMax) {
      seqBase[c.col] = await getMaxColumn(tgtCtx, recipe.schema || 'public', recipe.table, c.col);
      emit({ type: 'stage', table: recipe.table, stage: 'รันเลข ' + c.col + ' ต่อจาก ' + seqBase[c.col].toLocaleString() });
    }
  }

  // 4) สร้างแถว insert
  const tgtEng = tgtCtx.eng;
  const cols = recipe.columns.map(c => c.col);
  const unmatched = {};
  // ถ้าปลายทางเป็น WIN874 ให้ตัดอักขระที่เก็บไม่ได้ออก (เก็บที่เหลือ ไม่ทิ้งทั้งแถว)
  const tgtEncoding = await detectTargetEncoding(tgtCtx);
  const encStrip = tgtEncoding === 'WIN874' ? (v => (typeof v === 'string' ? stripToWin874(v) : v)) : (v => v);
  if (tgtEncoding === 'WIN874') emit({ type: 'stage', table: recipe.table, stage: 'ปลายทางเป็น WIN874 — จะตัดอักขระที่เก็บไม่ได้ออก' });
  const built = missingRows.map((row, i) => recipe.columns.map(c => encStrip(valueFor(row, c, maps, unmatched, { index: i, seqBase }))));

  const writeSize = Math.max(50, Math.min(500, Math.floor(MAX_PARAMS / Math.max(1, cols.length))));
  let inserted = 0, failed = 0;
  const errors = [];

  emit({ type: 'stage', table: recipe.table, stage: 'กำลังโอน ' + missingRows.length.toLocaleString() + ' แถว...' });
  const tInsert = Date.now();

  for (const batch of chunk(built, writeSize)) {
    if (options.isCancelled && options.isCancelled()) { result.cancelled = true; break; }
    const insSql = tgtEng.buildInsertIgnore(recipe.schema || 'public', recipe.table, cols, batch.length, { overriding: false });
    const values = [];
    batch.forEach(r => r.forEach(v => values.push(v)));
    try {
      const rr = await tgtEng.query(tgtCtx.pool, insSql, values);
      inserted += rr.rowCount;
    } catch (e) {
      for (const row of batch) {
        const one = tgtEng.buildInsertIgnore(recipe.schema || 'public', recipe.table, cols, 1, { overriding: false });
        try { const r1 = await tgtEng.query(tgtCtx.pool, one, row); inserted += r1.rowCount; }
        catch (err) { failed++; if (errors.length < 20) errors.push(shortErr(err)); }
      }
    }
    emit({ type: 'progress', table: recipe.table, phase: 'insert', inserted, failed, total: missingRows.length });
  }

  timing.insertMs = Date.now() - tInsert;

  // สรุปค่าที่ lookup ไม่เจอ (เป็นคำเตือน)
  for (const [name, set] of Object.entries(unmatched)) {
    if (set.size) result.warnings.push('lookup "' + name + '" ไม่พบค่าที่ตรงกัน ' + set.size + ' รายการ (ใส่ NULL)');
  }

  result.status = result.cancelled ? 'cancelled' : (failed ? 'partial' : 'ok');
  result.inserted = inserted;
  result.failed = failed;
  result.errors = errors;
  result.timing = timing;
  // สรุปเวลาแต่ละขั้น (คิวรี่ต้นทาง / ตรวจคีย์ / โอน)
  emit({ type: 'stage', table: recipe.table,
    stage: 'สรุปเวลา: คิวรี่ ' + (timing.queryMs / 1000).toFixed(1) + 'วิ · ตรวจคีย์ ' + (timing.checkMs / 1000).toFixed(1) + 'วิ · โอน ' + (timing.insertMs / 1000).toFixed(1) + 'วิ' });
  return result;
}

/* ============================================================
   วินิจฉัยแถวที่ "ขาดหาย" แต่ไม่ถูกโอน (หาเหตุผล + ฟิลด์)
   ============================================================ */
async function diagnoseRecipe(recipe, srcCtx, tgtCtx, from, to, limit) {
  limit = limit || 200;
  const keyFields = keyFieldsOf(recipe);
  const q = recipe.source.sql(from, to);
  const rows = (await srcCtx.eng.query(srcCtx.pool, q.text, q.params)).rows;

  const seen = new Set();
  const uniq = [];
  for (const r of rows) {
    if (r[keyFields[0]] === null || r[keyFields[0]] === undefined || r[keyFields[0]] === '') continue;
    const k = compositeKey(keyFields.map(f => r[f]));
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }
  const stillMissing = await findMissingRows(tgtCtx, recipe, uniq);
  const sample = stillMissing.slice(0, limit);

  const maps = await resolveAllMaps(tgtCtx, recipe, sample);
  const seqBase = {};
  for (const c of recipe.columns) {
    if (c.seqFromMax) seqBase[c.col] = await getMaxColumn(tgtCtx, recipe.schema || 'public', recipe.table, c.col);
  }
  const cols = recipe.columns.map(c => c.col);
  const tgtEng = tgtCtx.eng;
  const grouper = makeReasonGrouper();
  let okInsert = 0;

  // ชนิดข้อมูลคอลัมน์ปลายทาง (ไว้เดาฟิลด์ที่ผิดชนิด)
  const colTypes = {};
  try {
    const t = await tgtCtx.eng.describeTable(tgtCtx.pool, recipe.schema || 'public', recipe.table);
    t.columns.forEach(c => { colTypes[c.name] = c.type; });
  } catch (e) {}

  const tgtEncoding = await detectTargetEncoding(tgtCtx);
  const encStrip = tgtEncoding === 'WIN874' ? (v => (typeof v === 'string' ? stripToWin874(v) : v)) : (v => v);

  for (let i = 0; i < sample.length; i++) {
    const row = sample[i];
    const vals = recipe.columns.map(c => encStrip(valueFor(row, c, maps, {}, { index: i, seqBase })));
    const sql = tgtEng.buildInsertPlain(recipe.schema || 'public', recipe.table, cols, 1, { overriding: false });
    const disp = keyFields.map(f => f + '=' + fmt(row[f])).join(', ');
    const res = await tgtEng.diagnoseInsert(tgtCtx.pool, sql, vals);
    if (res.ok) { okInsert++; grouper.add('__OK__', disp, null); }
    else {
      const rowByCol = {}; cols.forEach((c, idx) => { rowByCol[c] = vals[idx]; });
      grouper.add(shortErr(res.error), disp, extractField(res.error, rowByCol, colTypes));
    }
  }

  const list = grouper.finalize('ลอง insert เดี่ยวได้ปกติ — แถวถูกข้ามตอนโอนเพราะชนคีย์ภายในชุดเดียวกัน หรือคีย์จริงของตารางปลายทางต่างจากคีย์ที่ใช้ตรวจ (เช่น มี unique อื่น)');
  return { table: recipe.table, stillMissing: stillMissing.length, sampled: sample.length, okInsert, groups: list };
}

module.exports = { planRecipe, transferRecipe, diagnoseRecipe };
