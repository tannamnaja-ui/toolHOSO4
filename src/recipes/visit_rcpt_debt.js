'use strict';
/* ============================================================
   สูตรเฉพาะ: rcpt_debt (ลูกหนี้ใบเสร็จ / ใบวางบิล)
   ต้นทาง: PostgreSQL (t_billing_invoice + t_visit + ...)
   ปลายทาง: HOSxP (rcpt_debt) — PostgreSQL หรือ MySQL
   กรองตามวันที่บันทึก (record_date_time)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน record_date_time (แทน CAST(...AS DATE) BETWEEN)
    dateFilter = "tbi.record_date_time >= $1::date AND tbi.record_date_time < ($2::date + interval '1 day')";
  }

  const text = `
SELECT
    ROW_NUMBER() OVER (ORDER BY tbi.record_date_time, tbi.t_billing_invoice_id) AS debt_id,
    (SUBSTRING(TO_CHAR(tv.visit_begin_visit_time::timestamp, 'YY') FROM 1 FOR 2) ||
     LPAD(tv.visit_vn, 10, '0')) AS vn,
    tv.visit_hn AS hn,
    CAST(tbi.record_date_time AS DATE) AS debt_date,
    TO_CHAR(tbi.record_date_time::timestamp, 'HH24:MI:SS') AS debt_time,
    tbi.user_record_id AS staff,
    CASE
        WHEN CAST(tbi.billing_invoice_active AS TEXT) = '0' THEN 0
        ELSE COALESCE(tbi.billing_invoice_total, 0)
    END AS amount,
    CASE
        WHEN tv.f_visit_type_id = '1' THEN 'IPD'
        ELSE 'OPD'
    END AS pt_type,
    LPAD(CAST(ROW_NUMBER() OVER (ORDER BY tbi.record_date_time, tbi.t_billing_invoice_id) AS TEXT), 7, '0') AS finance_number,
    vp.b_contract_plans_id AS pttype,
    CASE
        WHEN CAST(tbi.billing_invoice_active AS TEXT) = '0' THEN 0
        ELSE COALESCE(tbi.billing_invoice_total, 0)
    END AS total_amount,
    TO_CHAR(tbi.record_date_time::timestamp, 'YYYY-MM-DD HH24:MI:SS') AS debt_date_time,
    tbi.t_billing_invoice_id AS hos_guid,
    CASE
        WHEN CAST(tbi.billing_invoice_active AS TEXT) = '0' THEN 'ABORT'
        ELSE 'OK'
    END AS status,
    vgp.govoffical_number AS sss_approval_code
FROM public.t_billing_invoice tbi
LEFT JOIN public.t_visit tv
    ON tbi.t_visit_id = tv.t_visit_id
LEFT JOIN (
    SELECT DISTINCT ON (t_visit_payment_id)
        t_visit_payment_id,
        govoffical_number
    FROM public.t_visit_govoffical_plan
    WHERE CAST(govoffical_type AS TEXT) = '1'
    ORDER BY t_visit_payment_id, t_visit_govoffical_plan_id DESC
) vgp ON tbi.t_payment_id = vgp.t_visit_payment_id
LEFT JOIN LATERAL (
    SELECT
        p.visit_payment_main_hospital,
        p.visit_payment_sub_hospital,
        p.b_contract_plans_id,
        p.visit_payment_card_number
    FROM public.t_visit_payment p
    WHERE p.t_visit_id = tv.t_visit_id
      AND CAST(p.visit_payment_active AS TEXT) = '1'
    ORDER BY p.t_visit_payment_id DESC
    LIMIT 1
) vp ON true
WHERE ${dateFilter}
ORDER BY tbi.record_date_time ASC`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'rcpt_debt',
  label: 'ลูกหนี้ใบเสร็จ',
  schema: 'public',
  dateColumn: 'debt_date',
  targetDateColumn: 'debt_date',
  targetKey: ['hos_guid'],   // t_billing_invoice_id — unique ต่อใบ
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode:   { table: 'doctor',  match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer', match: 'officer_doctor_code', ret: 'officer_login_name' },
    pttypeCode:   { table: 'pttype',  match: 'hos_guid',            ret: 'pttype' }
  },

  columns: [
    { col: 'debt_id',           seqFromMax: true },   // รันเลขต่อจาก MAX
    { col: 'vn',                field: 'vn' },
    { col: 'hn',                field: 'hn' },
    { col: 'debt_date',         field: 'debt_date' },
    { col: 'debt_time',         field: 'debt_time' },
    // staff: doctor.oldcode -> code -> officer.officer_doctor_code -> officer_login_name
    { col: 'staff',             field: 'staff', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'amount',            field: 'amount', numeric: true },
    { col: 'pt_type',           field: 'pt_type' },
    { col: 'finance_number',    field: 'finance_number' },
    { col: 'pttype',            field: 'pttype', lookup: 'pttypeCode' },
    { col: 'total_amount',      field: 'total_amount', numeric: true },
    { col: 'hos_guid',          field: 'hos_guid' },
    { col: 'status',            field: 'status' },
    { col: 'sss_approval_code', field: 'sss_approval_code' }
  ]
};
