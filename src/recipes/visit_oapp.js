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
    // sargable: ใช้ index บน record_date_time (ผลเท่ากับ SUBSTRING(...,1,10) BETWEEN)
    dateFilter = "app.record_date_time >= $1::date AND app.record_date_time < ($2::date + interval '1 day')";
  }

  const text = `
SELECT
    ROW_NUMBER() OVER () AS oapp_id,
    v.visit_hn AS hn,
    (TO_CHAR(v.visit_begin_visit_time::timestamp, 'YY') || LPAD(v.visit_vn, 10, '0')) AS vn,
    v.visit_begin_visit_time::date AS vstdate,
    app.patient_appointment_date::date AS nextdate,
    TO_CHAR(app.patient_appointment_time::time, 'HH24:MI:SS') AS nexttime,
    app.patient_appointment_clinic AS clinic,
    app.patient_appointment_servicepoint AS depcode,
    cur_d.b_service_point_id AS spclty,
    app.patient_appointment_doctor AS doctor,
    (
        SELECT string_agg(apo.patient_appointment_order_common_name, ' , ')
        FROM public.t_patient_appointment_order apo
        WHERE apo.t_patient_appointment_id = app.t_patient_appointment_id
    ) AS note,
    app.patient_appointment_staff AS app_user,
    app.patient_appointment AS app_cause,
    TO_CHAR(app.patient_appointment_end_time::time, 'HH24:MI:SS') AS nexttime_end,
    app.t_patient_appointment_id AS hos_guid,
    SUBSTRING(app.record_date_time::text FROM 1 FOR 19) AS update_datetime,
    CASE
        WHEN app.patient_appointment_status IN ('0', '1', '4') THEN '1'
        WHEN app.patient_appointment_status = '6' THEN '2'
        WHEN app.patient_appointment_status IN ('2', '5') THEN '3'
        WHEN app.patient_appointment_status = '3' THEN '4'
        ELSE '1'
    END AS oapp_status_id
FROM public.t_patient_appointment app
LEFT JOIN LATERAL (
    SELECT
        CASE
            WHEN LENGTH(app.visit_id_make_appointment) < 18
                 OR app.visit_id_make_appointment IS NULL
                 OR app.visit_id_make_appointment = ''
            THEN (
                SELECT tv.t_visit_id
                FROM public.t_visit tv
                WHERE tv.t_patient_id = app.t_patient_id
                  AND SUBSTRING(tv.visit_begin_visit_time::text, 1, 10) < SUBSTRING(app.record_date_time::text, 1, 10)
                ORDER BY tv.visit_begin_visit_time DESC
                LIMIT 1
            )
            ELSE app.visit_id_make_appointment
        END AS matched_visit_id
) map_v ON true
LEFT JOIN public.t_visit v
       ON v.t_visit_id = map_v.matched_visit_id
LEFT JOIN LATERAL (
    SELECT vs.b_service_point_id
    FROM t_visit_service vs
    WHERE vs.t_visit_id = v.t_visit_id
    ORDER BY vs.assign_date_time ASC
    LIMIT 1
) cur_d ON true
WHERE ${dateFilter}`;

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
    { col: 'vn',              field: 'vn' },
    { col: 'vstdate',         field: 'vstdate' },
    { col: 'nextdate',        field: 'nextdate' },
    { col: 'nexttime',        field: 'nexttime' },
    { col: 'clinic',          field: 'clinic',  lookup: 'clinicCode' },
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
