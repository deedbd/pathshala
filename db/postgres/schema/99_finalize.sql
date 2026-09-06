-- =====================================================================
--  99 · FINALIZE: updated_at triggers + tenant RLS on every table carrying school_id,
--       plus cross-module reporting views.
-- =====================================================================

DO $$
DECLARE r record;
BEGIN
  -- tenant tables: RLS + updated_at
  FOR r IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'school_id' AND t.table_type = 'BASE TABLE'
  LOOP
    PERFORM tenant_table(r.table_name::regclass);
  END LOOP;

  -- non-tenant tables that still have updated_at (child tables scoped via parent)
  FOR r IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND t.table_type = 'BASE TABLE'
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns x
                      WHERE x.table_schema = 'public' AND x.table_name = c.table_name AND x.column_name = 'school_id')
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', r.table_name, r.table_name);
  END LOOP;
END $$;

-- schools itself: a tenant may only see its own row
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schools USING (id = current_school_id());

-- Application roles
--   app_api     : normal request path, RLS enforced (SET LOCAL app.school_id per request)
--   app_worker  : background workers, may BYPASSRLS for cross-tenant schedulers
--   app_readonly: BI / Metabase
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api')      THEN CREATE ROLE app_api NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker')   THEN CREATE ROLE app_worker NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readonly') THEN CREATE ROLE app_readonly NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_api, app_worker, app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_api, app_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_api, app_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_readonly;

-- ---------- cross-module views ----------

-- 360° student card used by parent app / admin profile
CREATE VIEW v_student_overview AS
SELECT s.school_id, s.id AS student_id, s.admission_no,
       s.first_name || ' ' || coalesce(s.last_name,'') AS full_name,
       c.name AS class_name, sec.name AS section_name, s.current_roll_no,
       s.status,
       g.full_name AS primary_guardian, g.phone AS guardian_phone,
       d.outstanding, d.overdue,
       (SELECT round(100.0 * sum(present_days) / nullif(sum(working_days),0), 2)
          FROM mv_student_attendance_monthly m WHERE m.student_id = s.id) AS attendance_pct,
       (SELECT gpa FROM exam_results r JOIN exams e ON e.id = r.exam_id
         WHERE r.student_id = s.id AND r.published_at IS NOT NULL ORDER BY e.end_date DESC LIMIT 1) AS last_gpa
FROM students s
LEFT JOIN classes c   ON c.id = s.current_class_id
LEFT JOIN sections sec ON sec.id = s.current_section_id
LEFT JOIN student_guardians sg ON sg.student_id = s.id AND sg.is_primary
LEFT JOIN guardians g ON g.id = sg.guardian_id
LEFT JOIN v_student_dues d ON d.student_id = s.id;

-- Teacher workload (periods/week) for timetable balancing
CREATE VIEW v_teacher_workload AS
SELECT st.school_id, st.id AS staff_id, st.first_name || ' ' || coalesce(st.last_name,'') AS teacher,
       count(ts.id) AS weekly_periods,
       count(DISTINCT ts.section_id) AS sections
FROM staff st
LEFT JOIN timetable_slots ts ON ts.teacher_id = st.id AND (ts.effective_to IS NULL OR ts.effective_to >= CURRENT_DATE)
WHERE st.staff_category = 'teaching' AND st.status = 'active'
GROUP BY st.school_id, st.id;

-- Trial balance
CREATE VIEW v_trial_balance AS
SELECT a.school_id, a.code, a.name, a.account_type,
       coalesce(sum(l.debit),0)  AS total_debit,
       coalesce(sum(l.credit),0) AS total_credit,
       coalesce(sum(l.debit),0) - coalesce(sum(l.credit),0) AS balance
FROM gl_accounts a
LEFT JOIN journal_lines l ON l.account_id = a.id
LEFT JOIN journal_entries j ON j.id = l.entry_id AND j.status = 'posted'
WHERE NOT a.is_group
GROUP BY a.school_id, a.code, a.name, a.account_type;
