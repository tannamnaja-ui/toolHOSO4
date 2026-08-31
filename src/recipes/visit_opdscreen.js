'use strict';
/* ============================================================
   สูตรเฉพาะ: opdscreen (คัดกรอง/สัญญาณชีพ OPD)
   ต้นทาง: PostgreSQL (t_visit_vital_sign + t_visit + t_visit_primary_symptom)
   ปลายทาง: HOSxP (opdscreen) — PostgreSQL หรือ MySQL
   ============================================================ */

/** คิวรี่ต้นทางตามช่วงวันที่ที่เลือก — กรองตามวันที่มารับบริการ (visit_begin_visit_time) */
function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    // เทียบแบบช่วง (sargable) เพื่อให้ใช้ index บน visit_begin_visit_time ได้ — เร็วกว่า ::date มาก
    dateFilter = "visit_begin_visit_time >= $1::date AND visit_begin_visit_time < ($2::date + interval '1 day')";
  }

  const text = `
SELECT
    v.visit_dx AS systom,
    ('{' || UPPER(gen_random_uuid()::text) || '}') AS hos_guid,
    (TO_CHAR(v.visit_begin_visit_time::timestamp, 'YY') || LPAD(v.visit_vn, 10, '0')) AS vn,
    v.visit_hn AS hn,
    v.visit_begin_visit_time::date AS vstdate,
    v.visit_begin_visit_time::time AS vsttime,
    NULLIF(SPLIT_PART(vs.visit_vital_sign_blood_presure, '/', 2), '') AS bpd,
    NULLIF(SPLIT_PART(vs.visit_vital_sign_blood_presure, '/', 1), '') AS bps,
    vs.visit_vital_sign_weight AS bw,
    ps.visit_primary_symptom_main_symptom AS cc,
    vs.visit_vital_sign_heart_rate AS hr,
    (
        SELECT string_agg(pe_sub.pe_item, chr(13))
        FROM (
            SELECT concat(visit_physical_exam_body, ' : ', string_agg(visit_physical_exam_detail, ', ')) AS pe_item
            FROM public.t_visit_physical_exam
            WHERE t_visit_id = vs.t_visit_id
            GROUP BY visit_physical_exam_body
            ORDER BY visit_physical_exam_body
        ) pe_sub
    ) AS pe,
    vs.visit_vital_sign_heart_rate AS pulse,
    vs.visit_vital_sign_temperature AS temperature,
    vs.visit_vital_sign_note AS note,
    vs.visit_vital_sign_respiratory_rate AS rr,
    vs.visit_vital_sign_height AS height,
    vs.visit_vital_sign_bmi AS bmi,
    vs.visit_vital_sign_waistline_inch AS waist,
    ps.visit_primary_symptom_current_illness AS hpi
FROM public.t_visit_vital_sign vs
LEFT JOIN public.t_visit v
       ON vs.t_visit_id = v.t_visit_id
LEFT JOIN public.t_visit_primary_symptom ps
       ON vs.t_visit_id = ps.t_visit_id
WHERE vs.t_visit_id IN (
    SELECT t_visit_id
    FROM public.t_visit
    WHERE ${dateFilter}
)`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'opdscreen',
  label: 'คัดกรอง OPD',
  schema: 'public',
  dateColumn: 'vstdate',
  targetDateColumn: 'vstdate',
  targetKey: ['vn'],   // opdscreen: 1 แถวต่อ visit — hos_guid gen ใหม่ทุกครั้ง ใช้เป็นคีย์ไม่ได้
  keyField: 'vn',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {},

  columns: [
    { col: 'symptom',     field: 'systom' },
    { col: 'hos_guid',    field: 'hos_guid' },
    { col: 'vn',          field: 'vn' },
    { col: 'hn',          field: 'hn' },
    { col: 'vstdate',     field: 'vstdate' },
    { col: 'vsttime',     field: 'vsttime' },
    { col: 'bpd',         field: 'bpd',         numeric: true },
    { col: 'bps',         field: 'bps',         numeric: true },
    { col: 'bw',          field: 'bw',          numeric: true },
    { col: 'cc',          field: 'cc' },
    { col: 'hr',          field: 'hr',          numeric: true },
    { col: 'pe',          field: 'pe' },
    { col: 'pulse',       field: 'pulse',       numeric: true },
    { col: 'temperature', field: 'temperature', numeric: true },
    { col: 'note',        field: 'note' },
    { col: 'rr',          field: 'rr',          numeric: true },
    { col: 'height',      field: 'height',      numeric: true },
    { col: 'bmi',         field: 'bmi',         numeric: true },
    { col: 'waist',       field: 'waist',       numeric: true },
    { col: 'hpi',         field: 'hpi' }
  ]
};
