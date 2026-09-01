'use strict';
/* ============================================================
   สูตรเฉพาะ: ipt_order_no (เลขที่ order IPD สรุปต่อ visit/ประเภท/วัน)
   ต้นทาง: PostgreSQL (t_order + t_visit + b_item_subgroup)
   ปลายทาง: HOSxP (ipt_order_no) — PostgreSQL หรือ MySQL
   เช็กซ้ำด้วย hos_guid (ตามที่ผู้ใช้เลือก)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน order_date_time (อยู่ใน subquery ชั้นใน)
    dateFilter = "o.order_date_time >= $1::date AND o.order_date_time < ($2::date + interval '1 day')";
  }

  const text = `
SELECT
    row_number() OVER () AS ipt_order_id,
    ip.an AS an,
    ip.order_date AS rxdate,
    row_number() OVER () ::text AS order_no,
    ip.order_type AS order_type,
    min(ip.order_staff_order) AS entry_staff,
    ip.t_visit_id AS ward,
    min(ip.order_time) AS rxtime,
    count(ip.t_order_id) AS item_count,
    sum(ip.sum_price) AS amount,
    ip.t_visit_id AS hos_guid,
    min(ip.order_staff_order) AS doctor_code,
    TO_CHAR(ip.order_date + min(ip.order_time), 'YYYY-MM-DD HH24:MI:SS') AS update_datetime,
    ip.t_order_id AS oldcode
FROM (
    SELECT
        o.t_visit_id,
        CASE
            WHEN v.f_visit_type_id = '1' THEN
                SUBSTRING(v.visit_vn FROM 2 FOR 2) || LPAD(SUBSTRING(v.visit_vn FROM 4), 7, '0')
            ELSE NULL
        END AS an,
        CASE
            WHEN s.f_item_group_id IN ('1', '4') THEN 'IRx'
            WHEN s.f_item_group_id IN ('2', '3', '5', '6', '7') THEN 'ATO'
        END AS order_type,
        o.order_date_time::date AS order_date,
        o.order_date_time::time AS order_time,
        o.order_staff_order,
        (coalesce(o.order_price, 0) * coalesce(o.order_qty, 0)) AS sum_price,
        o.t_order_id
    FROM public.t_order o
    LEFT JOIN public.b_item_subgroup s ON s.b_item_subgroup_id = o.b_item_subgroup_id
    INNER JOIN public.t_visit v ON v.t_visit_id = o.t_visit_id
    WHERE o.f_order_status_id <> '3'
      AND v.f_visit_type_id = '1'
      AND ${dateFilter}
) ip
GROUP BY
    ip.t_visit_id,
    ip.an,
    ip.order_type,
    ip.order_date,
    ip.t_order_id`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'ipt_order_no',
  label: 'เลขที่ order IPD',
  schema: 'public',
  dateColumn: 'rxdate',
  targetDateColumn: 'rxdate',
  targetKey: ['oldcode'],   // grain เป็น 1 แถวต่อ 1 order -> ใช้ oldcode (t_order_id) เป็นคีย์เช็กซ้ำ (unique/เสถียร)
  keyField: 'oldcode',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode:   { table: 'doctor',  match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer', match: 'officer_doctor_code', ret: 'officer_login_name' },
    wardCode:     { table: 'ipt',     match: 'hos_guid',            ret: 'ward' }
  },

  columns: [
    { col: 'ipt_order_id',    seqFromMax: true },   // รันเลขต่อจาก MAX
    { col: 'an',              field: 'an' },
    { col: 'rxdate',          field: 'rxdate' },
    { col: 'order_no',        seqFromMax: true },   // รันเลขต่อจาก MAX
    { col: 'order_type',      field: 'order_type' },
    // entry_staff: doctor.oldcode -> code -> officer.officer_doctor_code -> officer_login_name
    { col: 'entry_staff',     field: 'entry_staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'ward',            field: 'ward', lookup: 'wardCode' },
    { col: 'rxtime',          field: 'rxtime' },
    { col: 'item_count',      field: 'item_count', numeric: true },
    { col: 'amount',          field: 'amount', numeric: true },
    { col: 'hos_guid',        field: 'hos_guid' },
    { col: 'doctor_code',     field: 'doctor_code', lookup: 'doctorCode' },
    { col: 'update_datetime', field: 'update_datetime' },
    { col: 'oldcode',         field: 'oldcode' }
  ]
};
