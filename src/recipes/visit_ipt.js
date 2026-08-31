'use strict';
/* ============================================================
   สูตรเฉพาะ: ipt (การรับไว้ในหอผู้ป่วย IPD)
   ต้นทาง: PostgreSQL (t_visit + t_diag_tdrg + ...)
   ปลายทาง: HOSxP (ipt) — PostgreSQL หรือ MySQL
   กรองตามวันที่รับ admit (visit_begin_admit_date_time)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = "t_visit.f_visit_type_id = '1'";
  if (from && to) {
    params.push(from, to);
    // sargable: ใช้ index บน visit_begin_admit_date_time
    dateFilter = "t_visit.visit_begin_admit_date_time >= $1::date AND t_visit.visit_begin_admit_date_time < ($2::date + interval '1 day')\n"
      + "    AND t_visit.f_visit_type_id = '1'";
  }

  const text = `
SELECT
    CASE
        WHEN t_visit.f_visit_type_id = '1' THEN
            SUBSTRING(t_visit.visit_vn FROM 2 FOR 2)
            || LPAD(SUBSTRING(t_visit.visit_vn FROM 4), 7, '0')
        ELSE NULL
    END AS an,
    t_visit.visit_patient_self_doctor AS admdoctor,
    t_visit.visit_ipd_discharge_date_time::date AS dchdate,
    LPAD(NULLIF(TRIM(t_visit.f_visit_ipd_discharge_status_id::text), ''), 2, '0') AS dchstts,
    t_visit.visit_ipd_discharge_date_time::time AS dchtime,
    LPAD(NULLIF(TRIM(t_visit.f_visit_ipd_discharge_type_id::text), ''), 2, '0') AS dchtype,
    t_visit.visit_hn AS hn,
    t_primary.visit_primary_symptom_main_symptom AS prediag,
    t_payment.b_contract_plans_id AS pttype,
    t_visit.visit_begin_admit_date_time::date AS regdate,
    t_visit.visit_begin_admit_date_time::time AS regtime,
    cur_d.b_service_point_id AS spclty,
    (TO_CHAR(t_visit.visit_begin_visit_time::timestamp, 'YY') || LPAD(t_visit.visit_vn, 10, '0')) AS vn,
    t_visit.b_visit_ward_id AS ward,
    t_visit.visit_patient_self_doctor AS dch_doctor,
    t_tdrg.drg AS drg,
    t_tdrg.mdc AS mdc,
    CASE WHEN NULLIF(TRIM(t_tdrg.rw::text), '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN CAST(TRIM(t_tdrg.rw::text) AS NUMERIC) ELSE NULL END AS rw,
    CASE WHEN NULLIF(TRIM(t_tdrg.wtlos::text), '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN CAST(TRIM(t_tdrg.wtlos::text) AS NUMERIC) ELSE NULL END AS wtlos,
    CASE WHEN NULLIF(TRIM(t_tdrg.ot::text), '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN CAST(TRIM(t_tdrg.ot::text) AS NUMERIC) ELSE NULL END AS ot,
    CASE WHEN NULLIF(TRIM(t_vital.visit_vital_sign_weight::text), '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN TRUNC(CAST(TRIM(t_vital.visit_vital_sign_weight::text) AS NUMERIC) * 1000) ELSE NULL END AS bw,
    CASE WHEN NULLIF(TRIM(t_tdrg.adjrw::text), '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN CAST(TRIM(t_tdrg.adjrw::text) AS NUMERIC) ELSE NULL END AS adjrw,
    cur_d.b_service_point_id AS ipt_spclty,
    t_visit.visit_dx AS provision_dx,
    t_visit.t_visit_id AS hos_guid,
    CASE WHEN NULLIF(TRIM(t_vital.visit_vital_sign_height::text), '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN TRUNC(CAST(TRIM(t_vital.visit_vital_sign_height::text) AS NUMERIC)) ELSE NULL END AS body_height,
    '1' AS ipt_admit_type_id,
    CASE WHEN t_visit.visit_ipd_discharge_date_time IS NOT NULL THEN 'Y' ELSE 'N' END AS confirm_discharge,
    t_tdrg.err AS grouper_err,
    t_tdrg.warn AS grouper_warn,
    REPLACE(t_icd10.diag_icd10_number, '.', '') AS provision_dx_icd,
    t_visit.visit_vn AS oldcode
FROM t_visit
LEFT JOIN t_visit_primary_symptom t_primary
    ON t_primary.t_visit_id = t_visit.t_visit_id
LEFT JOIN t_visit_payment t_payment
    ON t_payment.t_visit_id = t_visit.t_visit_id
    AND t_payment.visit_payment_active = '1'
LEFT JOIN t_diag_tdrg t_tdrg
    ON t_tdrg.t_visit_id = t_visit.t_visit_id
LEFT JOIN t_visit_vital_sign t_vital
    ON t_vital.t_visit_id = t_visit.t_visit_id
LEFT JOIN t_diag_icd10 t_icd10
    ON t_icd10.diag_icd10_vn = t_visit.t_visit_id
    AND t_icd10.f_diag_icd10_type_id = '1'
LEFT JOIN LATERAL (
    SELECT vs.b_service_point_id
    FROM t_visit_service vs
    WHERE vs.t_visit_id = t_visit.t_visit_id
    ORDER BY vs.assign_date_time ASC
    LIMIT 1
) cur_d ON true
WHERE ${dateFilter}`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'ipt',
  label: 'การรับไว้ในหอผู้ป่วย (IPD)',
  schema: 'public',
  dateColumn: 'regdate',
  targetDateColumn: 'regdate',
  targetKey: ['hos_guid'],   // t_visit_id — unique ต่อการ admit
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    doctorCode: { table: 'doctor',        match: 'oldcode',  ret: 'code' },
    pttypeCode: { table: 'pttype',        match: 'hos_guid', ret: 'pttype' },
    depSpclty:  { table: 'kskdepartment', match: 'oldcode',  ret: 'spclty' },
    wardCode:   { table: 'ward',          match: 'hos_guid', ret: 'ward' }
  },

  columns: [
    { col: 'an',                field: 'an' },
    { col: 'admdoctor',         field: 'admdoctor', lookup: 'doctorCode' },
    { col: 'dchdate',           field: 'dchdate' },
    { col: 'dchstts',           field: 'dchstts' },
    { col: 'dchtime',           field: 'dchtime' },
    { col: 'dchtype',           field: 'dchtype' },
    { col: 'hn',                field: 'hn' },
    { col: 'prediag',           field: 'prediag' },
    { col: 'pttype',            field: 'pttype', lookup: 'pttypeCode' },
    { col: 'regdate',           field: 'regdate' },
    { col: 'regtime',           field: 'regtime' },
    { col: 'spclty',            field: 'spclty', lookup: 'depSpclty' },
    { col: 'vn',                field: 'vn' },
    { col: 'ward',              field: 'ward', lookup: 'wardCode' },
    { col: 'dch_doctor',        field: 'dch_doctor', lookup: 'doctorCode' },
    { col: 'drg',               field: 'drg' },
    { col: 'mdc',               field: 'mdc' },
    { col: 'rw',                field: 'rw', numeric: true },
    { col: 'wtlos',             field: 'wtlos', numeric: true },
    { col: 'ot',                field: 'ot', numeric: true },
    { col: 'bw',                field: 'bw', numeric: true },
    { col: 'adjrw',             field: 'adjrw', numeric: true },
    { col: 'ipt_spclty',        field: 'ipt_spclty', lookup: 'depSpclty' },
    { col: 'provision_dx',      field: 'provision_dx' },
    { col: 'hos_guid',          field: 'hos_guid' },
    { col: 'body_height',       field: 'body_height', numeric: true },
    { col: 'ipt_admit_type_id', field: 'ipt_admit_type_id' },
    { col: 'confirm_discharge', field: 'confirm_discharge' },
    { col: 'grouper_err',       field: 'grouper_err' },
    { col: 'grouper_warn',      field: 'grouper_warn' },
    { col: 'provision_dx_icd',  field: 'provision_dx_icd' },
    { col: 'oldcode',           field: 'oldcode' }
  ]
};
