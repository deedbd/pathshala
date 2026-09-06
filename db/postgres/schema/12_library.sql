-- =====================================================================
--  12 · LIBRARY: catalogue, copies, members, issues, reservations, fines
-- =====================================================================

CREATE TABLE library_categories (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name      text NOT NULL,
  parent_id uuid REFERENCES library_categories(id) ON DELETE SET NULL,
  UNIQUE (school_id, name)
);

CREATE TABLE library_books (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  isbn           text,
  title          text NOT NULL,
  subtitle       text,
  authors        text[] NOT NULL DEFAULT '{}',
  publisher      text,
  edition        text,
  published_year smallint,
  language       text NOT NULL DEFAULT 'bn',
  category_id    uuid REFERENCES library_categories(id) ON DELETE SET NULL,
  subject_id     uuid REFERENCES subjects(id) ON DELETE SET NULL,
  class_id       uuid REFERENCES classes(id) ON DELETE SET NULL,    -- recommended for
  pages          smallint,
  price          numeric(14,2),
  cover_file_id  uuid REFERENCES files(id) ON DELETE SET NULL,
  ebook_file_id  uuid REFERENCES files(id) ON DELETE SET NULL,
  description    text,
  total_copies   integer NOT NULL DEFAULT 0,           -- maintained by trigger on copies
  available_copies integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_books_title_trgm ON library_books USING gin (title gin_trgm_ops);

CREATE TABLE library_book_copies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  book_id      uuid NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  accession_no text NOT NULL,
  barcode      text,
  rack         text,
  shelf        text,
  condition    text NOT NULL DEFAULT 'good',           -- new | good | fair | poor
  status       copy_status NOT NULL DEFAULT 'available',
  acquired_on  date,
  source       text,                                   -- purchase | donation
  UNIQUE (school_id, accession_no)
);

CREATE TABLE library_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  member_type  person_type NOT NULL,
  student_id   uuid REFERENCES students(id) ON DELETE CASCADE,
  staff_id     uuid REFERENCES staff(id) ON DELETE CASCADE,
  card_no      text NOT NULL,
  max_books    smallint NOT NULL DEFAULT 2,
  loan_days    smallint NOT NULL DEFAULT 14,
  fine_per_day numeric(14,2) NOT NULL DEFAULT 5,
  status       record_status NOT NULL DEFAULT 'active',
  blocked_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, card_no),
  CHECK ((member_type = 'student' AND student_id IS NOT NULL) OR (member_type = 'staff' AND staff_id IS NOT NULL))
);

CREATE TABLE library_issues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  copy_id       uuid NOT NULL REFERENCES library_book_copies(id) ON DELETE RESTRICT,
  member_id     uuid NOT NULL REFERENCES library_members(id) ON DELETE RESTRICT,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  due_at        date NOT NULL,
  returned_at   timestamptz,
  renew_count   smallint NOT NULL DEFAULT 0,
  issued_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  returned_to   uuid REFERENCES users(id) ON DELETE SET NULL,
  fine_amount   numeric(14,2) NOT NULL DEFAULT 0,      -- computed daily by automation while overdue
  fine_invoice_item_id uuid,                           -- soft ref → invoice_items (fine pushed to student bill)
  fine_waived_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reminder_stage text,                                 -- due_soon | overdue_1 | overdue_7
  status        text NOT NULL DEFAULT 'issued',        -- issued | returned | lost | overdue
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_library_issues_open ON library_issues(school_id, due_at) WHERE returned_at IS NULL;

CREATE TABLE library_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  book_id     uuid NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES library_members(id) ON DELETE CASCADE,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,                             -- copy became available
  expires_at  timestamptz,
  status      text NOT NULL DEFAULT 'waiting',         -- waiting | ready | fulfilled | expired | cancelled
  UNIQUE (book_id, member_id, status)
);

-- keep copy counters on the book row correct
CREATE OR REPLACE FUNCTION sync_book_copy_counts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b uuid := coalesce(NEW.book_id, OLD.book_id);
BEGIN
  UPDATE library_books SET
    total_copies     = (SELECT count(*) FROM library_book_copies WHERE book_id = b AND status <> 'withdrawn'),
    available_copies = (SELECT count(*) FROM library_book_copies WHERE book_id = b AND status = 'available')
  WHERE id = b;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_book_copy_counts AFTER INSERT OR UPDATE OR DELETE ON library_book_copies
  FOR EACH ROW EXECUTE FUNCTION sync_book_copy_counts();
