'use strict';
/* ============================================================
   สูตรเฉพาะ: oapp (นัดหมาย OPD)
   ต้นทาง: PostgreSQL (t_patient_appointment + t_visit + ...)
   ปลายทาง: HOSxP (oapp) — PostgreSQL หรือ MySQL
   กรองตามวันที่บันทึกนัด (record_date_time)
   ============================================================ */

function sourceSql(from, to) {
  const params = [];
  let dateFilter = 'true';
  if (from && to) {
    params.push(from, to);
    dateFilter = "app.record_date_time >= $1::date AND app.record_date_time < ($2::date + interval '1 day')";
  }

  // เขียนแบบ set-based ด้วย CTE:
  //  - appt: กรองนัดตามวันก่อน (materialize ครั้งเดียว)
  //  - matched: หา visit ที่ผูกกับนัด (subquery เฉพาะแถวที่ visit_id ไม่ครบ)
  //  - note_agg / svc: รวม note และแผนกแรก แบบ hash join ครั้งเดียว (แทน subquery ต่อแถว) → เร็วขึ้นมาก
  const text = `
WITH appt AS MATERIALIZED (
    SELECT
        app.t_patient_appointment_id, app.t_patient_id, app.visit_id_make_appointment,
        app.record_date_time, app.patient_appointment_date, app.patient_appointment_time,
        app.patient_appointment_clinic, app.patient_appointment_servicepoint,
        app.patient_appointment_doctor, app.patient_appointment_staff,
        app.patient_appointment, app.patient_appointment_end_time, app.patient_appointment_status
    FROM public.t_patient_appointment app
    WHERE ${dateFilter}
),
matched AS (
    SELECT a.*,
        CASE
            WHEN LENGTH(a.visit_id_make_appointment) < 18
                 OR a.visit_id_make_appointment IS NULL
                 OR a.visit_id_make_appointment = ''
            THEN (
                SELECT tv.t_visit_id
                FROM public.t_visit tv
                WHERE tv.t_patient_id = a.t_patient_id
                  AND tv.visit_begin_visit_time < date_trunc('day', a.record_date_time)
                ORDER BY tv.visit_begin_visit_time DESC
                LIMIT 1
            )
            ELSE a.visit_id_make_appointment
        END AS matched_visit_id
    FROM appt a
),
note_agg AS (
    SELECT apo.t_patient_appointment_id, string_agg(apo.patient_appointment_order_common_name, ' , ') AS note
    FROM public.t_patient_appointment_order apo
    JOIN appt a ON a.t_patient_appointment_id = apo.t_patient_appointment_id
    GROUP BY apo.t_patient_appointment_id
),
svc AS (
    SELECT DISTINCT ON (vs.t_visit_id) vs.t_visit_id, vs.b_service_point_id
    FROM public.t_visit_service vs
    JOIN matched m ON m.matched_visit_id = vs.t_visit_id
    ORDER BY vs.t_visit_id, vs.assign_date_time ASC
)
SELECT
    ROW_NUMBER() OVER () AS oapp_id,
    v.visit_hn AS hn,
    (TO_CHAR(v.visit_begin_visit_time::timestamp, 'YY') || LPAD(v.visit_vn, 10, '0')) AS vn,
    v.visit_begin_visit_time::date AS vstdate,
    m.patient_appointment_date::date AS nextdate,
    TO_CHAR(m.patient_appointment_time::time, 'HH24:MI:SS') AS nexttime,
    m.patient_appointment_clinic AS clinic,
    m.patient_appointment_servicepoint AS depcode,
    svc.b_service_point_id AS spclty,
    m.patient_appointment_doctor AS doctor,
    n.note AS note,
    m.patient_appointment_staff AS app_user,
    m.patient_appointment AS app_cause,
    TO_CHAR(m.patient_appointment_end_time::time, 'HH24:MI:SS') AS nexttime_end,
    m.t_patient_appointment_id AS hos_guid,
    SUBSTRING(m.record_date_time::text FROM 1 FOR 19) AS update_datetime,
    CASE
        WHEN m.patient_appointment_status IN ('0', '1', '4') THEN '1'
        WHEN m.patient_appointment_status = '6' THEN '2'
        WHEN m.patient_appointment_status IN ('2', '5') THEN '3'
        WHEN m.patient_appointment_status = '3' THEN '4'
        ELSE '1'
    END AS oapp_status_id
FROM matched m
LEFT JOIN public.t_visit v ON v.t_visit_id = m.matched_visit_id
LEFT JOIN svc ON svc.t_visit_id = m.matched_visit_id
LEFT JOIN note_agg n ON n.t_patient_appointment_id = m.t_patient_appointment_id`;

  return { text, params };
}

module.exports = {
  group: 'visit',
  table: 'oapp',
  label: 'นัดหมาย OPD',
  schema: 'public',
  dateColumn: 'update_datetime',
  targetKey: ['hos_guid'],   // t_patient_appointment_id — unique ต่อรายการนัด
  keyField: 'hos_guid',

  source: { engine: 'postgres', sql: sourceSql },

  lookups: {
    clinicCode:   { table: 'clinic',        match: 'oldcode',             ret: 'clinic' },
    depCode:      { table: 'kskdepartment', match: 'oldcode',             ret: 'depcode' },
    depSpclty:    { table: 'kskdepartment', match: 'oldcode',             ret: 'spclty' },
    doctorCode:   { table: 'doctor',        match: 'oldcode',             ret: 'code' },
    officerLogin: { table: 'officer',       match: 'officer_doctor_code', ret: 'officer_login_name' }
  },

  columns: [
    { col: 'oapp_id',         seqFromMax: true },   // รันเลขต่อจาก MAX ในปลายทาง
    { col: 'hn',              field: 'hn' },
    { col: 'vn',              field: 'vn', defaultIfEmpty: '0' },   // vn ว่าง -> 0
    { col: 'vstdate',         field: 'vstdate' },
    { col: 'nextdate',        field: 'nextdate' },
    { col: 'nexttime',        field: 'nexttime' },
    { col: 'clinic',          field: 'clinic',  lookup: 'clinicCode', lookupDefault: '999' },  // เทียบไม่เจอ/ว่าง -> 999
    { col: 'depcode',         field: 'depcode', lookup: 'depCode' },
    { col: 'spclty',          field: 'spclty',  lookup: 'depSpclty' },
    { col: 'doctor',          field: 'doctor',  lookup: 'doctorCode' },
    { col: 'note',            field: 'note' },
    // app_user: doctor.oldcode -> code -> officer.officer_doctor_code -> officer_login_name
    { col: 'app_user',        field: 'app_user', lookupChain: ['doctorCode', 'officerLogin'] },
    { col: 'app_cause',       field: 'app_cause' },
    { col: 'nexttime_end',    field: 'nexttime_end' },
    { col: 'hos_guid',        field: 'hos_guid' },
    { col: 'update_datetime', field: 'update_datetime' },
    { col: 'oapp_status_id',  field: 'oapp_status_id' }
  ]
};
