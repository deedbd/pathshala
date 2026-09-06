-- =====================================================================
--  01 · CORE: tenancy, identity, RBAC, audit, settings, files
-- =====================================================================

CREATE TABLE schools (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,                  -- short slug, used in numbering prefixes
  name          text NOT NULL,
  name_bn       text,
  school_type   text NOT NULL DEFAULT 'school',        -- school | college | school_and_college | madrasa | kindergarten
  board         text,                                  -- Dhaka | Cambridge | Edexcel | Madrasah | IB ...
  eiin          text,                                  -- BD Education Institute Identification Number
  address       jsonb NOT NULL DEFAULT '{}',
  phone         text,
  email         citext,
  website       text,
  logo_file_id  uuid,
  timezone      text NOT NULL DEFAULT 'Asia/Dhaka',
  currency      char(3) NOT NULL DEFAULT 'BDT',
  locale        text NOT NULL DEFAULT 'bn-BD',
  plan          text NOT NULL DEFAULT 'standard',
  status        record_status NOT NULL DEFAULT 'active',
  settings      jsonb NOT NULL DEFAULT '{}',           -- feature flags, policies (see docs/ARCHITECTURE.md)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campuses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text NOT NULL,
  address     jsonb NOT NULL DEFAULT '{}',
  phone       text,
  is_main     boolean NOT NULL DEFAULT false,
  status      record_status NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, code)
);

-- Platform-level operators (SaaS owner), outside tenant RLS
CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_type      user_type NOT NULL,
  username       citext,
  email          citext,
  phone          text,                                 -- E.164, primary login for guardians in BD
  password_hash  text,
  display_name   text NOT NULL,
  avatar_file_id uuid,
  locale         text,
  timezone       text,
  is_active      boolean NOT NULL DEFAULT true,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  mfa_secret     text,
  last_login_at  timestamptz,
  failed_logins  smallint NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (school_id, username),
  UNIQUE (school_id, email),
  UNIQUE (school_id, phone)
);
CREATE INDEX ix_users_school_type ON users(school_id, user_type);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,                           -- principal | accountant | teacher | librarian ...
  description text,
  is_system   boolean NOT NULL DEFAULT false,          -- seeded, cannot be deleted
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, slug)
);

-- Global permission catalogue: "<module>.<resource>.<action>"  e.g. fees.invoice.create
CREATE TABLE permissions (
  key         text PRIMARY KEY,
  module      text NOT NULL,
  description text
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  campus_id  uuid REFERENCES campuses(id) ON DELETE CASCADE,   -- NULL = all campuses
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,                   -- refresh token (sha256)
  device_name  text,
  device_id    text,
  push_token   text,                                   -- FCM / APNs token for this device
  ip           inet,
  user_agent   text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_auth_sessions_user ON auth_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  target      text NOT NULL,                           -- phone or email
  channel     notification_channel NOT NULL,
  purpose     text NOT NULL,                           -- login | password_reset | verify | invite
  code_hash   text NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Object storage metadata (S3 / MinIO). Actual bytes live in the bucket.
CREATE TABLE files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  bucket       text NOT NULL,
  object_key   text NOT NULL,
  file_name    text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL,
  checksum     text,
  visibility   text NOT NULL DEFAULT 'private',        -- private | school | public
  entity_type  text,                                   -- polymorphic owner, e.g. 'student'
  entity_id    uuid,
  purpose      text,                                   -- photo | document | receipt | report_card ...
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key)
);
CREATE INDEX ix_files_entity ON files(entity_type, entity_id);

ALTER TABLE schools ADD FOREIGN KEY (logo_file_id) REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE users   ADD FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL;

-- Key/value configuration (school-wide policies). Typed JSON, validated in app layer.
CREATE TABLE settings (
  school_id  uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  key        text NOT NULL,                            -- attendance.late_after_minutes, fees.invoice_day ...
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, key)
);

-- Immutable change log; written by application middleware for every mutation
CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  actor_user_id uuid,
  actor_type    text NOT NULL DEFAULT 'user',          -- user | system | automation | api_key
  action        text NOT NULL,                         -- create | update | delete | login | export ...
  entity_type   text NOT NULL,
  entity_id     uuid,
  before_data   jsonb,
  after_data    jsonb,
  ip            inet,
  user_agent    text,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_logs(school_id, entity_type, entity_id);
CREATE INDEX ix_audit_time   ON audit_logs(school_id, created_at DESC);
