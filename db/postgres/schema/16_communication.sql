-- =====================================================================
--  16 · COMMUNICATION: providers, templates, notifications, preferences, notices, events, messaging, PTM
-- =====================================================================

CREATE TABLE messaging_providers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  channel     notification_channel NOT NULL,
  provider    text NOT NULL,                           -- ssl_wireless | banglalink | robi | twilio | smtp | ses | fcm | whatsapp_cloud
  credentials jsonb NOT NULL,                          -- encrypted at rest
  sender_id   text,                                    -- SMS masking name / from address
  is_default  boolean NOT NULL DEFAULT false,
  balance     numeric(14,2),                           -- prepaid SMS balance, synced by worker
  low_balance_threshold numeric(14,2),
  is_active   boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX ux_provider_default ON messaging_providers(school_id, channel) WHERE is_default;

-- Event-keyed, per-channel, per-locale message templates with {{placeholders}}
CREATE TABLE notification_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid REFERENCES schools(id) ON DELETE CASCADE,      -- NULL = platform default
  event_key   text NOT NULL,                           -- attendance.absent | fee.invoice.issued | exam.result.published ...
  channel     notification_channel NOT NULL,
  locale      text NOT NULL DEFAULT 'bn',
  subject     text,
  body        text NOT NULL,                           -- "{{student_name}} was absent on {{date}} ..."
  variables   text[] NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, event_key, channel, locale)
);

CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  recipient_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  recipient_address text,                              -- phone/email/push token used (guardian w/o account)
  channel          notification_channel NOT NULL,
  event_key        text,
  template_id      uuid REFERENCES notification_templates(id) ON DELETE SET NULL,
  title            text,
  body             text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}',        -- deep-link payload
  entity_type      text,
  entity_id        uuid,
  status           notification_status NOT NULL DEFAULT 'queued',
  provider_id      uuid REFERENCES messaging_providers(id) ON DELETE SET NULL,
  provider_msg_id  text,
  cost             numeric(10,4),
  attempts         smallint NOT NULL DEFAULT 0,
  error            text,
  scheduled_for    timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  delivered_at     timestamptz,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_queue ON notifications(scheduled_for) WHERE status = 'queued';
CREATE INDEX ix_notifications_user ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX ix_notifications_entity ON notifications(entity_type, entity_id);

CREATE TABLE notification_preferences (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key text NOT NULL,                             -- '*' = all
  channel   notification_channel NOT NULL,
  enabled   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, event_key, channel)
);

CREATE TABLE notices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL,
  notice_type  text NOT NULL DEFAULT 'general',        -- general | academic | exam | fee | holiday | urgent
  audience     jsonb NOT NULL DEFAULT '{"all":true}',  -- {"roles":["guardian"],"class_ids":[],"section_ids":[],"campus_ids":[]}
  attachments  uuid[] NOT NULL DEFAULT '{}',
  publish_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  is_pinned    boolean NOT NULL DEFAULT false,
  send_push    boolean NOT NULL DEFAULT true,
  send_sms     boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'published',      -- draft | scheduled | published | archived
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notices_publish ON notices(school_id, publish_at DESC);

CREATE TABLE notice_reads (
  notice_id uuid NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, user_id)
);

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  calendar_event_id uuid REFERENCES calendar_events(id) ON DELETE SET NULL,
  title         text NOT NULL,
  description   text,
  event_type    text NOT NULL,                         -- sports | cultural | ptm | seminar | trip
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  venue         text,
  audience      jsonb NOT NULL DEFAULT '{"all":true}',
  rsvp_required boolean NOT NULL DEFAULT false,
  fee_amount    numeric(14,2),                         -- optional paid event → invoice item
  banner_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  organiser_id  uuid REFERENCES staff(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'scheduled',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_rsvps (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE CASCADE,
  response   text NOT NULL,                            -- yes | no | maybe
  guests     smallint NOT NULL DEFAULT 0,
  responded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- In-app messaging (teacher ↔ guardian, admin broadcast groups)
CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'direct',          -- direct | group | section_channel
  subject     text,
  section_id  uuid REFERENCES sections(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member',      -- member | admin
  muted           boolean NOT NULL DEFAULT false,
  last_read_at    timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text,
  attachments     uuid[] NOT NULL DEFAULT '{}',
  sent_at         timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz
);
CREATE INDEX ix_messages_conv ON messages(conversation_id, sent_at DESC);

-- Parent–teacher meeting slots & bookings
CREATE TABLE ptm_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  event_id    uuid REFERENCES events(id) ON DELETE CASCADE,
  teacher_id  uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  capacity    smallint NOT NULL DEFAULT 1,
  room_id     uuid REFERENCES rooms(id) ON DELETE SET NULL,
  EXCLUDE USING gist (teacher_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
);

CREATE TABLE ptm_bookings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id     uuid NOT NULL REFERENCES ptm_slots(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id uuid NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'booked',          -- booked | attended | no_show | cancelled
  notes       text,
  reminder_sent_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slot_id, student_id)
);
