'use strict';
/* ============================================================
   สูตรเฉพาะ: lab_order_service (รายการบริการตรวจแล็บของ order)
   ต้นทาง: PostgreSQL (t_order + t_visit + t_result_lab + b_item + b_item_lab_set)
   ปลายทาง: HOSxP (lab_order_service) — PostgreSQL หรือ MySQL
   กรองตามวันที่สั่ง (order_date_time)
   คีย์เช็กซ้ำ = lab_order_number + lab_code (ค่า "หลัง lookup" ที่เก็บจริงในปลายทาง)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    dateFilter = "t_order.order_date_time >= $1::date AND t_order.order_date_time < ($2::date + interval '1 day')";
  }

  const text = `
WITH lh AS (
    SELECT
        t_order.t_visit_id,
        t_order.t_order_id,
        t_visit.f_visit_type_id,
        t_visit.visit_vn,
        t_visit.visit_hn,
        t_visit.visit_begin_visit_time,
        t_order.order_service_point,
        t_order.order_price,
        t_order.order_verify_date_time,
        CASE
            WHEN (t_order.b_item_id = t_result_lab.b_item_id OR bils.b_item_lab_set_id IS NULL OR bils.b_item_lab_set_id = '')
            THEN 'ITEM'
            ELSE 'PROFILE'
        END AS lab_order_type,
        CASE
            WHEN (t_order.b_item_id = t_result_lab.b_item_id OR bils.b_item_lab_set_id IS NULL OR bils.b_item_lab_set_id = '')
            THEN t_result_lab.b_item_id
            ELSE bils.b_item_lab_set_id
        END AS lab_code,
        CASE
            WHEN (t_order.b_item_id = t_result_lab.b_item_id OR bils.b_item_lab_set_id IS NULL OR bils.b_item_lab_set_id = '')
            THEN b1.item_common_name
            ELSE b2.item_common_name
        END AS lab_name
    FROM public.t_order AS t_order
    INNER JOIN public.t_visit AS t_visit
        ON t_visit.t_visit_id = t_order.t_visit_id
    INNER JOIN public.t_result_lab AS t_result_lab
        ON t_result_lab.t_order_id = t_order.t_order_id
        AND t_result_lab.t_visit_id = t_order.t_visit_id
    LEFT JOIN public.b_item AS b1
        ON b1.b_item_id = t_result_lab.b_item_id
    LEFT JOIN public.b_item AS b2
        ON b2.b_item_id = t_order.b_item_id
    LEFT JOIN public.b_item_lab_set AS bils
        ON bils.b_item_id = t_order.b_item_id
    WHERE ${dateFilter}
      AND t_order.f_order_status_id <> '3'
    GROUP BY
        t_order.t_visit_id,
        t_order.t_order_id,
        t_visit.f_visit_type_id,
        t_visit.visit_vn,
        t_visit.visit_hn,
        t_visit.visit_begin_visit_time,
        t_order.order_service_point,
        t_order.order_price,
        t_order.order_verify_date_time,
        t_result_lab.b_item_id,
        t_order.b_item_id,
        b1.item_common_name,
        b2.item_common_name,
        bils.b_item_lab_set_id
)
SELECT
    lh.t_order_id AS lab_order_number,
    lh.lab_order_type AS lab_order_type,
    lh.lab_code AS lab_code,
    lh.lab_name AS lab_name,
    lh.order_price AS price,
    NULL AS opi_guid,
    lh.lab_code AS icode,
    CASE
        WHEN lh.f_visit_type_id = '1' THEN
            SUBSTRING(lh.visit_vn FROM 2 FOR 2) || LPAD(SUBSTRING(lh.visit_vn FROM 4), 7, '0')
        ELSE
            SUBSTRING(TO_CHAR(lh.visit_begin_visit_time::timestamp, 'YY') FROM 1 FOR 2) || LPAD(lh.visit_vn, 10, '0')
    END AS vn,
    lh.order_service_point AS department,
    lh.lab_code AS specimen_code,
    lh.visit_hn AS hn
FROM lh
ORDER BY lh.t_visit_id, lh.t_order_id`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'lab_order_service',
  label: 'บริการตรวจแล็บ (lab_order_service)',
  schema: 'public',
  dateColumn: '',            // กรองวันที่ที่ต้นทางในคิวรี่ (order_date_time) — ปลายทางไม่มีคอลัมน์วันที่ให้นับ

  // 1 order มีได้หลายรายการแล็บ -> คีย์ประกอบ (lab_order_number, lab_code)
  // ค่าทั้งสองเป็น "ค่าหลัง lookup" (lab_head.lab_order_number, lab_items.lab_items_code) => keyAfterLookup
  targetKey: ['lab_order_number', 'lab_code'],
  keyFields: ['lab_order_number', 'lab_code'],   // ฟิลด์ต้นทางที่ป้อนคีย์ (ใช้ dedupe)
  keyAfterLookup: true,

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    labHeadNo:    { table: 'lab_head',      match: 'hos_guid', ret: 'lab_order_number' },
    labItemsCode: { table: 'lab_items',     match: 'hos_guid', ret: 'lab_items_code' },
    sDrugIcode:   { table: 's_drugitems',   match: 'oldcode',  ret: 'icode' },
    depCode:      { table: 'kskdepartment', match: 'oldcode',  ret: 'depcode' }
  },

  columns: [
    { col: 'lab_order_service_id', seqFromMax: true },                                   // รันต่อเลขสุดท้ายของตาราง
    { col: 'lab_order_number',     field: 'lab_order_number', lookup: 'labHeadNo' },     // t_order_id -> lab_head.hos_guid -> lab_order_number
    { col: 'lab_order_type',       field: 'lab_order_type' },                            // ITEM / PROFILE
    { col: 'lab_code',             field: 'lab_code', lookup: 'labItemsCode' },          // -> lab_items.hos_guid -> lab_items_code
    { col: 'lab_name',             field: 'lab_name' },
    { col: 'price',                field: 'price', numeric: true },
    { col: 'opi_guid',             field: 'opi_guid' },                                  // NULL ตามโครงสร้าง
    { col: 'icode',                field: 'icode', lookup: 'sDrugIcode' },               // lab_code -> s_drugitems.oldcode -> icode
    { col: 'vn',                   field: 'vn' },
    { col: 'department',           field: 'department', lookup: 'depCode' },             // order_service_point -> kskdepartment.oldcode -> depcode
    { col: 'hn',                   field: 'hn' }
  ]
};
