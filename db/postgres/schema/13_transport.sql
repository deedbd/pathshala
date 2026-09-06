-- =====================================================================
--  13 · TRANSPORT: vehicles, routes, stops, assignments, trips, GPS, boarding, maintenance
-- =====================================================================

CREATE TABLE vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  campus_id        uuid REFERENCES campuses(id) ON DELETE SET NULL,
  registration_no  text NOT NULL,
  vehicle_type     text NOT NULL DEFAULT 'bus',        -- bus | microbus | van
  make_model       text,
  capacity         smallint NOT NULL,
  driver_id        uuid REFERENCES staff(id) ON DELETE SET NULL,
  helper_id        uuid REFERENCES staff(id) ON DELETE SET NULL,
  gps_device_id    text,                               -- IMEI of tracker
  insurance_expiry date,                               -- automation: expiry alerts
  fitness_expiry   date,
  tax_token_expiry date,
  route_permit_expiry date,
  odometer_km      integer,
  status           record_status NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, registration_no)
);

CREATE TABLE transport_routes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name         text NOT NULL,                          -- 'Route 3 – Mirpur'
  vehicle_id   uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  start_point  text,
  end_point    text,
  distance_km  numeric(6,2),
  monthly_fee  numeric(14,2) NOT NULL DEFAULT 0,       -- default; stop can override
  fee_head_id  uuid REFERENCES fee_heads(id) ON DELETE SET NULL,
  status       record_status NOT NULL DEFAULT 'active',
  UNIQUE (school_id, name)
);

CREATE TABLE route_stops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id    uuid NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sequence    smallint NOT NULL,
  latitude    numeric(9,6),
  longitude   numeric(9,6),
  geofence_m  smallint NOT NULL DEFAULT 300,           -- radius for "bus approaching" push
  pickup_time time,
  drop_time   time,
  fee_override numeric(14,2),
  UNIQUE (route_id, sequence)
);

CREATE TABLE student_transport (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year_id uuid NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  route_id         uuid NOT NULL REFERENCES transport_routes(id) ON DELETE RESTRICT,
  stop_id          uuid NOT NULL REFERENCES route_stops(id) ON DELETE RESTRICT,
  trip_type        trip_type NOT NULL DEFAULT 'both',
  start_date       date NOT NULL,
  end_date         date,
  monthly_fee      numeric(14,2) NOT NULL,             -- snapshot used by invoicing
  status           record_status NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, academic_year_id)
);

CREATE TABLE vehicle_trips (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  route_id    uuid NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  trip_date   date NOT NULL,
  trip_type   trip_type NOT NULL,
  driver_id   uuid REFERENCES staff(id) ON DELETE SET NULL,
  scheduled_start time,
  started_at  timestamptz,
  ended_at    timestamptz,
  status      text NOT NULL DEFAULT 'scheduled',       -- scheduled | running | completed | cancelled | delayed
  delay_alert_sent_at timestamptz,
  UNIQUE (vehicle_id, trip_date, trip_type)
);

-- High-volume time series; partition by month in production
CREATE TABLE vehicle_gps_logs (
  id          bigserial PRIMARY KEY,
  vehicle_id  uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  trip_id     uuid REFERENCES vehicle_trips(id) ON DELETE SET NULL,
  latitude    numeric(9,6) NOT NULL,
  longitude   numeric(9,6) NOT NULL,
  speed_kmh   numeric(5,1),
  heading     smallint,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX ix_gps_vehicle_time ON vehicle_gps_logs(vehicle_id, recorded_at DESC);

CREATE TABLE transport_boardings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid NOT NULL REFERENCES vehicle_trips(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  stop_id     uuid REFERENCES route_stops(id) ON DELETE SET NULL,
  boarded_at  timestamptz,
  alighted_at timestamptz,
  source      attendance_source NOT NULL DEFAULT 'device',   -- rfid on bus / helper app
  guardian_notified_at timestamptz,
  UNIQUE (trip_id, student_id)
);

CREATE TABLE stop_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid NOT NULL REFERENCES vehicle_trips(id) ON DELETE CASCADE,
  stop_id     uuid NOT NULL REFERENCES route_stops(id) ON DELETE CASCADE,
  alert_type  text NOT NULL,                           -- approaching | arrived | departed
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, stop_id, alert_type)
);

CREATE TABLE vehicle_maintenance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  service_type text NOT NULL,                          -- oil | tyre | repair | inspection
  service_date date NOT NULL,
  odometer_km  integer,
  cost         numeric(14,2),
  vendor_id    uuid REFERENCES vendors(id) ON DELETE SET NULL,
  expense_id   uuid REFERENCES expenses(id) ON DELETE SET NULL,
  next_due_date date,
  next_due_km  integer,
  notes        text
);

CREATE TABLE fuel_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  filled_at  timestamptz NOT NULL DEFAULT now(),
  litres     numeric(7,2) NOT NULL,
  cost       numeric(14,2) NOT NULL,
  odometer_km integer,
  expense_id uuid REFERENCES expenses(id) ON DELETE SET NULL
);
