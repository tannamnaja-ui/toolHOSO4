'use strict';
/* ============================================================
   สูตรเฉพาะ: drugusage (นิยามวิธีใช้ยา)
   ต้นทาง: PostgreSQL (t_order + t_order_drug + ...)
   ปลายทาง: HOSxP (drugusage) — PostgreSQL หรือ MySQL
   เช็กซ้ำด้วย hos_guid (มีแล้วไม่นำเข้าซ้ำ)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน order_date_time
    dateFilter = "t_order.order_date_time >= $1::date AND t_order.order_date_time < ($2::date + interval '1 day')";
  }

  const text = `
SELECT DISTINCT ON (hos_guid)
    LPAD((row_number() OVER ())::text, 7, '0') AS drugusage,
    concat(us.item_drug_instruction_number, t_order_drug.order_drug_dose::VARCHAR, uo.item_drug_uom_number, uf.item_drug_frequency_number) AS code,
    concat(us.item_drug_instruction_description, ' ', t_order_drug.order_drug_dose::VARCHAR, ' ', uo.item_drug_uom_description) AS name1,
    uf.item_drug_frequency_description AS name2,
    concat(us.item_drug_instruction_description, ' ', t_order_drug.order_drug_dose::VARCHAR, ' ', uo.item_drug_uom_description, ' ', uf.item_drug_frequency_description) AS shortlist,
    t_order_drug.order_drug_caution AS common_name,
    us.item_drug_instruction_number AS opi_usage_code,
    t_order_drug.order_drug_dose AS opi_dose,
    uo.item_drug_uom_number AS opi_usage_unit_code,
    uf.item_drug_frequency_number AS opi_frequency_code,
    concat(t_order_drug.b_item_drug_instruction_id, t_order_drug.order_drug_dose::VARCHAR, t_order_drug.b_item_drug_uom_id_use, t_order_drug.b_item_drug_frequency_id) AS hos_guid,
    concat(t_order_drug.b_item_drug_instruction_id, t_order_drug.order_drug_dose::VARCHAR, t_order_drug.b_item_drug_uom_id_use, t_order_drug.b_item_drug_frequency_id) AS idrlink
FROM t_order
INNER JOIN t_visit ON t_visit.t_visit_id = t_order.t_visit_id
LEFT JOIN b_item_subgroup sub ON sub.b_item_subgroup_id = t_order.b_item_subgroup_id
LEFT JOIN t_order_drug ON t_order_drug.t_order_id = t_order.t_order_id AND t_order_drug.order_drug_active = '1'
LEFT JOIN b_item_drug_instruction us ON us.b_item_drug_instruction_id = t_order_drug.b_item_drug_instruction_id
LEFT JOIN b_item_drug_uom uo ON uo.b_item_drug_uom_id = t_order_drug.b_item_drug_uom_id_use
LEFT JOIN b_item_drug_frequency uf ON uf.b_item_drug_frequency_id = t_order_drug.b_item_drug_frequency_id
WHERE t_order.f_order_status_id <> '3'
    AND concat(us.item_drug_instruction_number, t_order_drug.order_drug_dose::VARCHAR, uo.item_drug_uom_number, uf.item_drug_frequency_number) <> ''
    AND ${dateFilter}`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'drugusage',
  label: 'วิธีใช้ยา (drugusage)',
  schema: 'public',
  dateColumn: '',
  targetKey: ['hos_guid'],   // เช็กซ้ำด้วย hos_guid
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {},

  columns: [
    { col: 'drugusage',           seqFromMax: { pad: 7 } },   // เลข 7 หลักเติมศูนย์ รันต่อจาก MAX
    { col: 'code',                field: 'code' },
    { col: 'name1',               field: 'name1' },
    { col: 'name2',               field: 'name2' },
    { col: 'shortlist',           field: 'shortlist' },
    { col: 'common_name',         field: 'common_name' },
    { col: 'opi_usage_code',      field: 'opi_usage_code' },
    { col: 'opi_dose',            field: 'opi_dose', numeric: true },
    { col: 'opi_usage_unit_code', field: 'opi_usage_unit_code' },
    { col: 'opi_frequency_code',  field: 'opi_frequency_code' },
    { col: 'hos_guid',            field: 'hos_guid' },
    { col: 'idrlink',             field: 'idrlink' }
  ]
};
