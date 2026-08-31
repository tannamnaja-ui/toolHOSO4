'use strict';
/* ============================================================
   ทะเบียนสูตรเฉพาะตาราง (recipe registry)
   key = "<group>:<table>"
   ============================================================ */
const registry = {};

function register(recipe) {
  registry[recipe.group + ':' + recipe.table] = recipe;
}

register(require('./visit_ovst'));
register(require('./visit_visit_pttype'));
register(require('./visit_ovstdiag'));
register(require('./visit_opdscreen'));

function getRecipe(group, table) {
  return registry[group + ':' + table] || null;
}

/** รายชื่อ recipe ทั้งหมด (ไว้แสดง/ตรวจสอบ) */
function listRecipes() {
  return Object.values(registry).map(r => ({
    group: r.group, table: r.table, label: r.label,
    keyColumns: r.targetKey, dateColumn: r.dateColumn || '',
    columns: r.columns.length, lookups: Object.keys(r.lookups || {}).length
  }));
}

module.exports = { getRecipe, listRecipes, registry };
