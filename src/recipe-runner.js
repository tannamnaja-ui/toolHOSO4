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

/** คำนวณค่าของคอลัมน์ปลายทางหนึ่งช่อง */
function valueFor(row, c, maps, unmatched) {
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

/* ---------- หา key ปลายทางที่ยังไม่มี ---------- */
async function findMissingKeyValues(tgtCtx, recipe, keyValues, onProgress) {
  const eng = tgtCtx.eng;
  const col = recipe.targetKey[0];
  const q = eng.quote(col);
  const table = eng.qname(recipe.schema || 'public', recipe.table);
  const distinct = [...new Set(keyValues.map(keyStr).filter(v => v !== ''))];
  const missing = new Set(distinct);
  let done = 0;
  for (const batch of chunk(distinct, 2000)) {
    let p = 1;
    const ph = batch.map(() => eng.ph(p++)).join(', ');
    const r = await eng.query(tgtCtx.pool, 'select ' + q + ' as k from ' + table + ' where ' + q + ' in (' + ph + ')', batch);
    r.rows.forEach(row => missing.delete(keyStr(row.k)));
    done += batch.length;
    if (onProgress) onProgress({ checked: done, total: distinct.length, missing: missing.size });
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

  // 1) รันคิวรี่ต้นทาง
  emit({ type: 'stage', table: recipe.table, stage: 'รันคิวรี่ต้นทาง (สูตรเฉพาะ)...' });
  let rows;
  try {
    const q = recipe.source.sql(from, to);
    rows = (await srcCtx.eng.query(srcCtx.pool, q.text, q.params)).rows;
  } catch (e) {
    result.status = 'error';
    result.error = 'คิวรี่ต้นทางล้มเหลว: ' + shortErr(e);
    return result;
  }
  result.sourceRows = rows.length;

  // dedupe ตาม key (เก็บแถวแรก)
  const seen = new Set();
  const uniq = [];
  for (const r of rows) {
    const k = keyStr(r[recipe.keyField]);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }

  result.targetRows = await countTargetByDate(tgtCtx, recipe, from, to);

  if (!uniq.length) {
    result.status = 'ok'; result.missingRows = 0; result.inserted = 0; result.failed = 0;
    emit({ type: 'stage', table: recipe.table, stage: 'ไม่มีข้อมูลในช่วงวันที่ที่เลือก' });
    return result;
  }

  // 2) หา key ที่ปลายทางยังไม่มี
  emit({ type: 'stage', table: recipe.table, stage: 'ตรวจหาคีย์ที่ขาดในปลายทาง...' });
  const missingSet = await findMissingKeyValues(tgtCtx, recipe, uniq.map(r => r[recipe.keyField]),
    p => emit(Object.assign({ type: 'progress', table: recipe.table, phase: 'check' }, p)));
  const missingRows = uniq.filter(r => missingSet.has(keyStr(r[recipe.keyField])));
  result.missingRows = missingRows.length;

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

  // 4) สร้างแถว insert
  const tgtEng = tgtCtx.eng;
  const cols = recipe.columns.map(c => c.col);
  const unmatched = {};
  const built = missingRows.map(row => recipe.columns.map(c => valueFor(row, c, maps, unmatched)));

  const writeSize = Math.max(50, Math.min(500, Math.floor(MAX_PARAMS / Math.max(1, cols.length))));
  let inserted = 0, failed = 0;
  const errors = [];

  emit({ type: 'stage', table: recipe.table, stage: 'กำลังโอน ' + missingRows.length.toLocaleString() + ' แถว...' });

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

  // สรุปค่าที่ lookup ไม่เจอ (เป็นคำเตือน)
  for (const [name, set] of Object.entries(unmatched)) {
    if (set.size) result.warnings.push('lookup "' + name + '" ไม่พบค่าที่ตรงกัน ' + set.size + ' รายการ (ใส่ NULL)');
  }

  result.status = result.cancelled ? 'cancelled' : (failed ? 'partial' : 'ok');
  result.inserted = inserted;
  result.failed = failed;
  result.errors = errors;
  return result;
}

module.exports = { planRecipe, transferRecipe };
