'use strict';
/* ============================================================
   สูตรเฉพาะ: opitemrece (รายการค่าใช้จ่าย/เวชภัณฑ์)
   ต้นทาง: PostgreSQL (t_order + t_visit + t_order_drug + hosxp.ipt_order_no)
   ปลายทาง: HOSxP (opitemrece) — PostgreSQL หรือ MySQL
   ตรวจแถวซ้ำด้วย idr (t_order_id) — hos_guid ถูก gen ใหม่ทุกครั้ง ใช้เป็นคีย์ไม่ได้
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = "o.f_order_status_id <> '3'";
  if (from && to) {
    params.push(from, to);
    // sargable: เทียบ order_date_time ตรง ๆ ทั้งช่วง ค.ศ. และ พ.ศ. (+543 ปี)
    dateFilter =
      "o.f_order_status_id <> '3'\n" +
      "    AND (\n" +
      "        (o.order_date_time >= $1::date AND o.order_date_time < ($2::date + interval '1 day'))\n" +
      "        OR\n" +
      "        (o.order_date_time >= ($1::date + interval '543 years') AND o.order_date_time < ($2::date + interval '543 years' + interval '1 day'))\n" +
      "    )";
  }

  const text = `
SELECT
    '{' || UPPER(gen_random_uuid()::TEXT) || '}' AS hos_guid,
    CASE
        WHEN v.f_visit_type_id = '1' THEN NULL
        ELSE (SUBSTRING(TO_CHAR(v.visit_begin_visit_time::timestamp, 'YY') FROM 1 FOR 2) ||
              LPAD(v.visit_vn, 10, '0'))
    END AS vn,
    v.visit_hn AS hn,
    CASE
        WHEN v.f_visit_type_id = '1' THEN
            SUBSTRING(v.visit_vn FROM 2 FOR 2) || LPAD(SUBSTRING(v.visit_vn FROM 4), 7, '0')
        ELSE NULL
    END AS an,
    o.b_item_id AS icode,
    o.order_qty AS qty,
    CONCAT(od.b_item_drug_instruction_id, od.order_drug_dose::varchar, od.b_item_drug_uom_id_use, od.b_item_drug_frequency_id) AS drugusage,
    CONCAT(od.b_item_drug_instruction_id, od.order_drug_dose::varchar, od.b_item_drug_uom_id_use, od.b_item_drug_frequency_id) AS sp_use,
    o.order_price AS unitprice,
    v.visit_begin_visit_time::date AS vstdate,
    TO_CHAR(v.visit_begin_visit_time::timestamp, 'HH24:MI:SS') AS vsttime,
    o.order_staff_order AS doctor,
    CASE
        WHEN SUBSTRING(o.order_date_time::text FROM 1 FOR 4)::int >= 2400 THEN
            TO_DATE((SUBSTRING(o.order_date_time::text FROM 1 FOR 4)::int - 543)::text || SUBSTRING(o.order_date_time::text FROM 5 FOR 6), 'YYYY-MM-DD')
        ELSE
            TO_DATE(SUBSTRING(o.order_date_time::text FROM 1 FOR 10), 'YYYY-MM-DD')
    END AS rxdate,
    SUBSTRING(o.order_date_time::text FROM 12 FOR 8) AS rxtime,
    o.order_service_point AS dep_code,
    CASE WHEN v.f_visit_type_id = '1' THEN ion.order_no ELSE NULL END AS order_no,
    vp.b_contract_plans_id AS pttype,
    o.b_item_id AS income,
    o.order_staff_order AS staff,
    vp.b_contract_plans_id AS paidst,
    CASE
        WHEN SUBSTRING(o.order_date_time::text FROM 1 FOR 4)::int >= 2400 THEN
            TO_TIMESTAMP((SUBSTRING(o.order_date_time::text FROM 1 FOR 4)::int - 543)::text || SUBSTRING(o.order_date_time::text FROM 5 FOR 15), 'YYYY-MM-DD HH24:MI:SS')
        ELSE
            TO_TIMESTAMP(SUBSTRING(o.order_date_time::text FROM 1 FOR 19), 'YYYY-MM-DD HH24:MI:SS')
    END AS last_modified,
    (o.order_qty * o.order_price) AS sum_price,
    o.order_cost AS cost,
    o.t_order_id AS idr
FROM public.t_order o
INNER JOIN public.t_visit v
    ON v.t_visit_id = o.t_visit_id
LEFT JOIN LATERAL (
    SELECT ipt.order_no
    FROM hosxp.ipt_order_no ipt
    WHERE v.f_visit_type_id = '1'
      AND ipt.an = (SUBSTRING(v.visit_vn FROM 2 FOR 2) || LPAD(SUBSTRING(v.visit_vn FROM 4), 7, '0'))
      AND (',' || ipt.oldcode || ',' LIKE '%,' || o.t_order_id || ',%')
    LIMIT 1
) ion ON true
LEFT JOIN LATERAL (
    SELECT b_contract_plans_id
    FROM public.t_visit_payment
    WHERE t_visit_id = v.t_visit_id
      AND visit_payment_active = '1'
    ORDER BY visit_payment_priority ASC
    LIMIT 1
) vp ON true
LEFT JOIN public.t_order_drug od
    ON od.t_order_id = o.t_order_id
   AND od.order_drug_active = '1'
WHERE ${dateFilter}`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'opitemrece',
  label: 'รายการค่าใช้จ่าย/เวชภัณฑ์',
  schema: 'public',
  dateColumn: 'rxdate',
  targetDateColumn: 'rxdate',
  targetKey: ['idr'],   // t_order_id — unique/เสถียรต่อรายการ (hos_guid ถูก gen ใหม่ทุกครั้ง)
  keyField: 'idr',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    sDrugIcode:   { table: 's_drugitems',   match: 'oldcode',             ret: 'icode' },
    sDrugIncome:  { table: 's_drugitems',   match: 'oldcode',             ret: 'income' },
    drugusageCode:{ table: 'drugusage',     match: 'hos_guid',            ret: 'drugusage' },
    doctorCode:   { table: 'doctor',        match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer',       match: 'officer_doctor_code', ret: 'officer_login_name' },
    depCode:      { table: 'kskdepartment', match: 'oldcode',             ret: 'depcode' },
    pttypeCode:   { table: 'pttype',        match: 'hos_guid',            ret: 'pttype' }
  },

  columns: [
    { col: 'hos_guid',      field: 'hos_guid' },   // gen ในคิวรี่ (unique)
    { col: 'vn',            field: 'vn' },
    { col: 'hn',            field: 'hn' },
    { col: 'an',            field: 'an' },
    { col: 'icode',         field: 'icode',  lookup: 'sDrugIcode', lookupKeepIfMissing: true },  // เทียบไม่เจอ -> ใช้ค่า icode เดิม
    { col: 'qty',           field: 'qty', numeric: true },
    { col: 'drugusage',     field: 'drugusage', lookup: 'drugusageCode' },  // ว่าง/null -> ไม่ lookup, ใส่ null
    { col: 'sp_use',        field: 'sp_use' },
    { col: 'unitprice',     field: 'unitprice', numeric: true },
    { col: 'vstdate',       field: 'vstdate' },
    { col: 'vsttime',       field: 'vsttime' },
    { col: 'doctor',        field: 'doctor', lookup: 'doctorCode' },
    { col: 'rxdate',        field: 'rxdate' },
    { col: 'rxtime',        field: 'rxtime' },
    { col: 'dep_code',      field: 'dep_code', lookup: 'depCode' },
    { col: 'order_no',      field: 'order_no' },   // ดึงจาก hosxp.ipt_order_no ในคิวรี่แล้ว (ไม่ต้อง lookup)
    { col: 'pttype',        field: 'pttype', lookup: 'pttypeCode' },
    { col: 'income',        field: 'income', lookup: 'sDrugIncome' },
    // staff: doctor.oldcode -> code -> officer.officer_doctor_code -> officer_login_name
    { col: 'staff',         field: 'staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'paidst',        field: 'paidst', lookup: 'pttypeCode' },
    { col: 'last_modified', field: 'last_modified' },
    { col: 'sum_price',     field: 'sum_price', numeric: true },
    { col: 'cost',          field: 'cost', numeric: true },
    { col: 'idr',           field: 'idr' }
  ]
};
