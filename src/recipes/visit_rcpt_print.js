'use strict';
/* ============================================================
   สูตรเฉพาะ: rcpt_print (ใบเสร็จรับเงิน)
   ต้นทาง: PostgreSQL (t_billing_receipt + t_visit + t_visit_payment)
   ปลายทาง: HOSxP (rcpt_print) — PostgreSQL หรือ MySQL
   กรองตามวันที่บันทึก (record_date_time)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน record_date_time
    dateFilter = "tbr.record_date_time >= $1::date AND tbr.record_date_time < ($2::date + interval '1 day')";
  }

  const text = `
WITH receipt_base AS (
    SELECT
        tbr.t_billing_receipt_id,
        tbr.billing_receipt_number,
        tbr.record_date_time,
        tbr.transaction_date,
        tbr.billing_receipt_paid,
        tbr.billing_receipt_active,
        tbr.user_record_id,
        tbr.t_patient_id,
        tbr.t_visit_id,
        tv.visit_hn,
        tv.visit_vn,
        tv.visit_an,
        tv.visit_begin_visit_time,
        COUNT(*) OVER(PARTITION BY tbr.billing_receipt_number) AS receipt_num_count,
        ROW_NUMBER() OVER(ORDER BY tbr.record_date_time, tbr.t_billing_receipt_id) AS running_no
    FROM public.t_billing_receipt tbr
    LEFT JOIN public.t_visit tv ON tbr.t_visit_id = tv.t_visit_id
    WHERE tbr.billing_receipt_paid >= 0
      AND ${dateFilter}
),
receipt_processed AS (
    SELECT
        rb.*,
        NULLIF(REGEXP_REPLACE(rb.billing_receipt_number, '^0+', ''), '') AS clean_receipt_number,
        rb.running_no::text AS gen_serial_num,
        CASE
            WHEN rb.visit_begin_visit_time IS NOT NULL AND rb.visit_vn IS NOT NULL THEN
                TO_CHAR(rb.visit_begin_visit_time::timestamp, 'YY') || LPAD(rb.visit_vn::text, 10, '0')
            ELSE rb.visit_vn
        END AS formatted_vn
    FROM receipt_base rb
)
SELECT
    LPAD(rp.running_no::text, 7, '0') AS finance_number,
    CASE
        WHEN rp.receipt_num_count > 1 THEN CONCAT('9', ':', rp.gen_serial_num)
        ELSE CONCAT('99', ';', COALESCE(rp.clean_receipt_number, '0'))
    END AS rcpno,
    CASE
        WHEN rp.billing_receipt_active = '0' THEN 0
        ELSE rp.billing_receipt_paid::numeric
    END AS bill_amount,
    TO_CHAR(rp.record_date_time::timestamp, 'YYYY-MM-DD HH24:MI:SS') AS bill_date_time,
    rp.user_record_id AS "user",
    rp.user_record_id AS bill_staff,
    rp.visit_hn AS hn,
    CASE
        WHEN NULLIF(TRIM(rp.visit_an), '') IS NOT NULL THEN rp.visit_an
        ELSE rp.formatted_vn
    END AS vn,
    CASE
        WHEN rp.billing_receipt_active = '1' THEN 'OK'
        WHEN rp.billing_receipt_active = '0' THEN 'ABORT'
        ELSE 'OK'
    END AS status,
    vp.b_contract_plans_id AS pttype,
    CASE
        WHEN rp.billing_receipt_active = '0' THEN 0
        ELSE rp.billing_receipt_paid::numeric
    END AS remain_money,
    CASE
        WHEN rp.receipt_num_count > 1 THEN 9
        ELSE 99
    END AS book_number,
    CASE
        WHEN rp.receipt_num_count > 1 THEN rp.gen_serial_num
        ELSE COALESCE(rp.clean_receipt_number, '0')
    END AS bill_number,
    CASE
        WHEN rp.billing_receipt_active = '0' THEN 0
        ELSE rp.billing_receipt_paid::numeric
    END AS total_amount,
    rp.t_billing_receipt_id AS hos_guid,
    rp.billing_receipt_number AS hos_guid_ext,
    rp.record_date_time::date AS bill_date,
    TO_CHAR(rp.record_date_time::timestamp, 'HH24:MI:SS') AS bill_time,
    '1'::varchar AS hospital_department_id
FROM receipt_processed rp
LEFT JOIN LATERAL (
    SELECT
        p.visit_payment_main_hospital,
        p.visit_payment_sub_hospital,
        p.b_contract_plans_id,
        p.visit_payment_card_number
    FROM public.t_visit_payment p
    WHERE p.t_visit_id = rp.t_visit_id
      AND p.visit_payment_active = '1'
    ORDER BY p.t_visit_payment_id DESC
    LIMIT 1
) vp ON true
ORDER BY rp.record_date_time`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'rcpt_print',
  label: 'ใบเสร็จรับเงิน',
  schema: 'public',
  dateColumn: 'bill_date',
  targetDateColumn: 'bill_date',
  targetKey: ['hos_guid'],   // t_billing_receipt_id — unique/เสถียร (เพิ่มเข้ามาเป็นคีย์เช็กซ้ำ)
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode:   { table: 'doctor',  match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer', match: 'officer_doctor_code', ret: 'officer_login_name' },
    pttypeCode:   { table: 'pttype',  match: 'hos_guid',            ret: 'pttype' }
  },

  columns: [
    { col: 'finance_number',        seqFromMax: { pad: 7 } },   // รันเลข 7 หลักต่อจาก MAX
    { col: 'rcpno',                 field: 'rcpno' },
    { col: 'bill_amount',           field: 'bill_amount', numeric: true },
    { col: 'bill_date_time',        field: 'bill_date_time' },
    // bill_staff: doctor.oldcode -> code -> officer.officer_doctor_code -> officer_login_name
    { col: 'bill_staff',            field: 'bill_staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'hn',                    field: 'hn' },
    { col: 'vn',                    field: 'vn' },
    { col: 'status',                field: 'status' },
    { col: 'pttype',                field: 'pttype', lookup: 'pttypeCode' },
    { col: 'remain_money',          field: 'remain_money', numeric: true },
    { col: 'book_number',           field: 'book_number', numeric: true },
    { col: 'bill_number',           field: 'bill_number' },
    { col: 'total_amount',          field: 'total_amount', numeric: true },
    { col: 'hos_guid',              field: 'hos_guid' },        // เพิ่มเข้ามาเป็นคีย์เช็กซ้ำ
    { col: 'hos_guid_ext',          field: 'hos_guid_ext' },
    { col: 'bill_time',             field: 'bill_time' },
    { col: 'hospital_department_id', field: 'hospital_department_id' }
  ]
};
