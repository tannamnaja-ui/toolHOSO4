'use strict';
/* ============================================================
   จัดการ connection pool ต่อฝั่ง (source/target) และเลือก engine
   ตามชนิดฐานข้อมูล (postgres / mysql)
   ============================================================ */
const store = require('./store');
const { getEngine, normalizeEngine } = require('./engines');

const pools = new Map(); // side -> { key, pool, eng }

function poolKey(cfg) {
  return [normalizeEngine(cfg.engine), cfg.host, cfg.port, cfg.database, cfg.user, cfg.ssl ? 1 : 0].join('|');
}

/** คืน { pool, eng } ของฝั่งที่ระบุ (แคชและ reuse) */
function getContext(side) {
  const cfg = store.getConnection(side);
  if (!cfg || !cfg.host || !cfg.database) {
    throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฝั่ง' + (side === 'source' ? 'ต้นทาง' : 'ปลายทาง'));
  }
  const eng = getEngine(cfg.engine);
  const encoding = cfg.encoding || '';
  const key = poolKey(cfg);
  const cached = pools.get(side);
  if (cached && cached.key === key) return { pool: cached.pool, eng: cached.eng, encoding: cached.encoding };
  if (cached) { cached.eng.endPool(cached.pool).catch(() => {}); pools.delete(side); }
  const pool = eng.createPool(cfg, 6);
  pools.set(side, { key, pool, eng, encoding });
  return { pool, eng, encoding };
}

function getPool(side) { return getContext(side).pool; }
function getEngineFor(side) { return getContext(side).eng; }

function resetPools() {
  for (const [side, c] of pools) { c.eng.endPool(c.pool).catch(() => {}); pools.delete(side); }
}

/** ทดสอบเชื่อมต่อครั้งเดียว (ไม่แคช) ด้วย engine ที่ระบุใน cfg */
async function testConnection(cfg) {
  const eng = getEngine(cfg.engine);
  return eng.testConnection(cfg);
}

/* proxy ไปยัง engine ของฝั่งนั้น ๆ */
async function listTables(side) {
  const { pool, eng } = getContext(side);
  return eng.listTables(pool);
}
async function describeTable(side, schema, table) {
  const { pool, eng } = getContext(side);
  return eng.describeTable(pool, schema, table);
}

module.exports = {
  getContext, getPool, getEngineFor, resetPools, testConnection,
  listTables, describeTable
};
