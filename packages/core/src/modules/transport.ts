import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
import type { AttendanceService } from './attendance.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface RouteInput { name: string; vehicleId?: string | null; startPoint?: string | null; endPoint?: string | null; distanceKm?: number | null; monthlyFee?: number; stops?: { name: string; sequence?: number; latitude?: number | null; longitude?: number | null; geofenceM?: number; pickupTime?: string | null; dropTime?: string | null; feeOverride?: number | null }[] }
export interface GpsPacket { latitude: number; longitude: number; speedKmh?: number | null; heading?: number | null; recordedAt?: string }

const SPEED_LIMIT_KMH = 60;

/**
 * Transport: fleet with its compliance dates, routes and geofenced stops, students assigned to a
 * stop (whose fee joins the monthly invoice), the day's trips created by the scheduler, GPS packets
 * that raise one "bus approaching" push per stop, boardings that also mark the child present, and
 * the alerts nobody wants to send by hand — a late bus, an over-speeding driver, and a child who
 * boarded in the afternoon but never got off.
 */
export class TransportService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private tasks: TaskService, private attendance: AttendanceService) {}

  // ---------- fleet ----------
  async vehicles(schoolId: string) { return this.db.findMany<Row>('vehicles', { school_id: schoolId }, { orderBy: 'registration_no ASC' }); }
  async addVehicle(schoolId: string, v: { registrationNo: string; vehicleType?: 'bus' | 'microbus' | 'van' | 'car'; makeModel?: string | null; capacity: number; driverId?: string | null; helperId?: string | null; gpsDeviceId?: string | null; insuranceExpiry?: string | null; fitnessExpiry?: string | null; taxTokenExpiry?: string | null; routePermitExpiry?: string | null }) {
    if (await this.db.findOne('vehicles', { school_id: schoolId, registration_no: v.registrationNo })) throw new HttpError(409, `${v.registrationNo} is already on the fleet`, 'conflict');
    const id = ulid();
    await this.db.insert('vehicles', { id, school_id: schoolId, campus_id: null, registration_no: v.registrationNo, vehicle_type: v.vehicleType ?? 'bus', make_model: v.makeModel ?? null, capacity: v.capacity, driver_id: v.driverId ?? null, helper_id: v.helperId ?? null, gps_device_id: v.gpsDeviceId ?? null, insurance_expiry: v.insuranceExpiry ?? null, fitness_expiry: v.fitnessExpiry ?? null, tax_token_expiry: v.taxTokenExpiry ?? null, route_permit_expiry: v.routePermitExpiry ?? null, odometer_km: null, status: 'active' });
    return id;
  }

  // ---------- routes ----------
  async routes(schoolId: string) {
    return this.db.query<Row>(`SELECT r.*, v.registration_no, (SELECT COUNT(*) FROM route_stops s WHERE s.route_id = r.id) AS stops, (SELECT COUNT(*) FROM student_transport t WHERE t.route_id = r.id AND t.status = 'active') AS riders FROM transport_routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.school_id = ? ORDER BY r.name`, [schoolId]);
  }
  async createRoute(schoolId: string, r: RouteInput) {
    const id = ulid();
    const head = await this.db.findOne<{ id: string }>('fee_heads', { school_id: schoolId, code: 'TRANSPORT' });
    await this.db.transaction(async tx => {
      await tx.insert('transport_routes', { id, school_id: schoolId, name: r.name, vehicle_id: r.vehicleId ?? null, start_point: r.startPoint ?? null, end_point: r.endPoint ?? null, distance_km: r.distanceKm ?? null, monthly_fee: r.monthlyFee ?? 0, fee_head_id: head?.id ?? null, status: 'active' });
      let seq = 0;
      for (const s of r.stops ?? []) {
        await tx.insert('route_stops', { id: ulid(), school_id: schoolId, route_id: id, name: s.name, sequence: s.sequence ?? ++seq, latitude: s.latitude ?? null, longitude: s.longitude ?? null, geofence_m: s.geofenceM ?? 300, pickup_time: s.pickupTime ?? null, drop_time: s.dropTime ?? null, fee_override: s.feeOverride ?? null });
      }
    });
    return id;
  }
  async stops(schoolId: string, routeId: string) { return this.db.findMany<Row>('route_stops', { school_id: schoolId, route_id: routeId }, { orderBy: 'sequence ASC' }); }

  /** J8: the fee is snapshotted here so a later route price change does not rewrite old invoices. */
  async assignStudent(schoolId: string, a: { studentId: string; academicYearId: string; routeId: string; stopId: string; tripType?: 'pickup' | 'drop' | 'both'; startDate?: string }) {
    const route = await this.db.findOne<Row>('transport_routes', { id: a.routeId, school_id: schoolId });
    if (!route) throw notFound('route');
    const stop = await this.db.findOne<Row>('route_stops', { id: a.stopId, route_id: a.routeId });
    if (!stop) throw badRequest('that stop is not on this route');
    const fee = Number(stop.fee_override ?? route.monthly_fee);
    const ex = await this.db.findOne<Row>('student_transport', { student_id: a.studentId, academic_year_id: a.academicYearId });
    const row = { school_id: schoolId, student_id: a.studentId, academic_year_id: a.academicYearId, route_id: a.routeId, stop_id: a.stopId, trip_type: a.tripType ?? 'both', start_date: a.startDate ?? nowSql().slice(0, 10), end_date: null, monthly_fee: fee, status: 'active' };
    const id = (ex?.id as string) ?? ulid();
    if (ex) await this.db.update('student_transport', { ...row, updated_at: nowSql() }, { id });
    else await this.db.insert('student_transport', { id, ...row });
    await this.outbox.emitNow({ type: 'transport.assigned', schoolId, aggregateType: 'transport.student', aggregateId: id, payload: { studentId: a.studentId, routeId: a.routeId, stopId: a.stopId, monthlyFee: fee } });
    return { id, monthlyFee: fee };
  }
  async riders(schoolId: string, routeId: string) {
    return this.db.query<Row>(`SELECT t.*, s.first_name, s.last_name, s.current_class_id, st.name AS stop_name FROM student_transport t JOIN students s ON s.id = t.student_id JOIN route_stops st ON st.id = t.stop_id WHERE t.school_id = ? AND t.route_id = ? AND t.status = 'active' ORDER BY st.sequence, s.first_name`, [schoolId, routeId]);
  }

  // ---------- trips ----------
  /** J1: today's pickup and drop for every active route with a vehicle. */
  async createTrips(schoolId: string, onDate = nowSql().slice(0, 10)) {
    const routes = await this.db.query<Row>(`SELECT * FROM transport_routes WHERE school_id = ? AND status = 'active' AND vehicle_id IS NOT NULL`, [schoolId]);
    let made = 0;
    for (const r of routes) {
      const first = (await this.db.query<Row>(`SELECT * FROM route_stops WHERE route_id = ? ORDER BY sequence LIMIT 1`, [String(r.id)]))[0];
      const vehicle = await this.db.findOne<Row>('vehicles', { id: String(r.vehicle_id) });
      for (const type of ['pickup', 'drop'] as const) {
        if (await this.db.findOne('vehicle_trips', { vehicle_id: String(r.vehicle_id), trip_date: onDate, trip_type: type })) continue;
        await this.db.insert('vehicle_trips', {
          id: ulid(), school_id: schoolId, vehicle_id: String(r.vehicle_id), route_id: String(r.id), trip_date: onDate, trip_type: type,
          driver_id: vehicle?.driver_id ?? null, helper_id: vehicle?.helper_id ?? null, scheduled_start: (type === 'pickup' ? first?.pickup_time : first?.drop_time) ?? null,
          started_at: null, ended_at: null, status: 'scheduled', delay_alert_sent_at: null, checklist: { fuel: false, tyres: false, firstAid: false, doors: false } as never,
        });
        made++;
      }
    }
    return { trips: made };
  }
  async trips(schoolId: string, onDate = nowSql().slice(0, 10)) {
    return this.db.query<Row>(`SELECT t.*, r.name AS route_name, v.registration_no, (SELECT COUNT(*) FROM transport_boardings b WHERE b.trip_id = t.id AND b.boarded_at IS NOT NULL) AS boarded FROM vehicle_trips t JOIN transport_routes r ON r.id = t.route_id JOIN vehicles v ON v.id = t.vehicle_id WHERE t.school_id = ? AND t.trip_date = ? ORDER BY t.trip_type, r.name`, [schoolId, onDate]);
  }
  /**
   * How many buses are out, of how many trips the day has. A school with no trips is not the same
   * as a school with no buses, so the note says which: nought of nought with routes on the books
   * means this morning's trips were never created, and that is worth a line on the dashboard.
   */
  async todaySummary(schoolId: string, onDate: string) {
    const [r] = await this.db.query<Row>(`SELECT COALESCE(SUM(running), 0) AS running, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(routes), 0) AS routes FROM (
        SELECT SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running, COUNT(*) AS total, 0 AS routes
          FROM vehicle_trips WHERE school_id = ? AND trip_date = ?
        UNION ALL
        SELECT 0, 0, COUNT(*) FROM transport_routes WHERE school_id = ? AND status = 'active'
      ) parts`, [schoolId, onDate, schoolId]);
    const running = Number(r?.running ?? 0), total = Number(r?.total ?? 0), routes = Number(r?.routes ?? 0);
    const note = total > 0 ? null : routes > 0 ? 'no trips have been created for today' : null;
    return { running, total, note };
  }

  async startTrip(schoolId: string, tripId: string, checklist?: Record<string, boolean>) {
    const t = await this.db.findOne<Row>('vehicle_trips', { id: tripId, school_id: schoolId });
    if (!t) throw notFound('trip');
    await this.db.update('vehicle_trips', { status: 'running', started_at: nowSql(), checklist: (checklist ?? json(t.checklist) ?? null) as never, updated_at: nowSql() }, { id: tripId });
    return { id: tripId, status: 'running' };
  }
  /** J6: ending a drop trip with a child still on board is the one alert that must never be missed. */
  async endTrip(schoolId: string, tripId: string) {
    const t = await this.db.findOne<Row>('vehicle_trips', { id: tripId, school_id: schoolId });
    if (!t) throw notFound('trip');
    await this.db.update('vehicle_trips', { status: 'completed', ended_at: nowSql(), updated_at: nowSql() }, { id: tripId });
    let stillOnBoard = 0;
    if (t.trip_type === 'drop') {
      const onBoard = await this.db.query<Row>(`SELECT b.*, s.first_name, s.last_name FROM transport_boardings b JOIN students s ON s.id = b.student_id WHERE b.trip_id = ? AND b.boarded_at IS NOT NULL AND b.alighted_at IS NULL`, [tripId]);
      stillOnBoard = onBoard.length;
      for (const b of onBoard) {
        await this.notifyGuardians(schoolId, String(b.student_id), 'transport.not_alighted', 'Child still on the bus', `${b.first_name} boarded but has not been marked off the bus. The helper and the transport manager have been alerted.`, tripId, ['sms', 'push', 'in_app']);
        await this.notifications.notifyRole(schoolId, 'admin', { channels: ['push', 'in_app', 'sms'], eventKey: 'transport.not_alighted', title: 'A child did not get off', body: `${b.first_name} ${b.last_name ?? ''} is still marked on board after the drop trip ended.`, entityType: 'transport.trip', entityId: tripId });
      }
      if (onBoard.length) await this.tasks.create({ schoolId, title: `Account for ${onBoard.length} child(ren) still marked on the bus`, taskType: 'transport.safety', assignedRole: 'admin', entityType: 'transport.trip', entityId: tripId, priority: 'urgent' });
    }
    return { id: tripId, status: 'completed', stillOnBoard };
  }

  // ---------- boardings ----------
  /** J3: an RFID tap or the helper's app. Boarding a pickup trip also marks the child present. */
  async board(schoolId: string, input: { tripId: string; studentId: string; stopId?: string | null; direction?: 'board' | 'alight'; source?: 'rfid' | 'helper_app' | 'manual' }) {
    const trip = await this.db.findOne<Row>('vehicle_trips', { id: input.tripId, school_id: schoolId });
    if (!trip) throw notFound('trip');
    const student = await this.db.findOne<Row>('students', { id: input.studentId, school_id: schoolId });
    if (!student) throw notFound('student');
    const alight = input.direction === 'alight';
    const ex = await this.db.findOne<Row>('transport_boardings', { trip_id: input.tripId, student_id: input.studentId });
    const id = (ex?.id as string) ?? ulid();
    const row = { school_id: schoolId, trip_id: input.tripId, student_id: input.studentId, stop_id: input.stopId ?? null, boarded_at: alight ? (ex?.boarded_at ?? null) : nowSql(), alighted_at: alight ? nowSql() : (ex?.alighted_at ?? null), source: input.source ?? 'rfid', guardian_notified_at: nowSql() };
    if (ex) await this.db.update('transport_boardings', { ...row, updated_at: nowSql() }, { id });
    else await this.db.insert('transport_boardings', { id, ...row });
    await this.notifyGuardians(schoolId, input.studentId, alight ? 'transport.alighted' : 'transport.boarded', alight ? 'Off the bus' : 'On the bus', `${student.first_name} ${alight ? 'got off' : 'got on'} the bus at ${nowSql().slice(11, 16)}.`, id, ['push', 'in_app']);
    // the morning bus is also the register: a child on board is a child at school
    if (!alight && trip.trip_type === 'pickup') await this.attendance.mark(schoolId, input.studentId, String(trip.trip_date).slice(0, 10), 'present', { source: 'bus', notify: false }).catch(() => undefined);
    return { id, direction: alight ? 'alight' : 'board' };
  }

  // ---------- gps ----------
  /** J2 and J5: telemetry in, one approach alert per stop, and a warning when the bus is speeding. */
  async ingestGps(schoolId: string, vehicleId: string, packets: GpsPacket[]) {
    const vehicle = await this.db.findOne<Row>('vehicles', { id: vehicleId, school_id: schoolId });
    if (!vehicle) throw notFound('vehicle');
    const trip = (await this.db.query<Row>(`SELECT * FROM vehicle_trips WHERE school_id = ? AND vehicle_id = ? AND trip_date = ? AND status IN ('running','scheduled','delayed') ORDER BY trip_type LIMIT 1`, [schoolId, vehicleId, nowSql().slice(0, 10)]))[0] ?? null;
    const stops = trip ? await this.db.query<Row>(`SELECT * FROM route_stops WHERE route_id = ? ORDER BY sequence`, [String(trip.route_id)]) : [];
    let stored = 0, alerts = 0, overspeed = 0;
    for (const p of packets) {
      await this.db.insert('vehicle_gps_logs', { id: ulid(), school_id: schoolId, vehicle_id: vehicleId, trip_id: trip ? String(trip.id) : null, latitude: p.latitude, longitude: p.longitude, speed_kmh: p.speedKmh ?? null, heading: p.heading ?? null, recorded_at: p.recordedAt ?? nowSql() });
      stored++;
      if (Number(p.speedKmh ?? 0) > SPEED_LIMIT_KMH) {
        overspeed++;
        await this.db.insert('driver_incidents', { id: ulid(), school_id: schoolId, vehicle_id: vehicleId, driver_id: (vehicle.driver_id as string) ?? null, kind: 'overspeed', occurred_at: p.recordedAt ?? nowSql(), details: `${p.speedKmh} km/h (limit ${SPEED_LIMIT_KMH})`, severity: Number(p.speedKmh) > SPEED_LIMIT_KMH + 20 ? 'high' : 'medium' });
        await this.notifications.notifyRole(schoolId, 'admin', { channels: ['push', 'in_app'], eventKey: 'transport.overspeed', title: 'Bus over the speed limit', body: `${vehicle.registration_no} was doing ${p.speedKmh} km/h.`, entityType: 'transport.vehicle', entityId: vehicleId });
      }
      if (!trip) continue;
      for (const s of stops) {
        if (s.latitude == null || s.longitude == null) continue;
        if (metres(p.latitude, p.longitude, Number(s.latitude), Number(s.longitude)) > Number(s.geofence_m ?? 300)) continue;
        if (await this.db.findOne('stop_alerts', { trip_id: String(trip.id), stop_id: String(s.id), alert_type: 'approaching' })) continue;
        await this.db.insert('stop_alerts', { id: ulid(), school_id: schoolId, trip_id: String(trip.id), stop_id: String(s.id), alert_type: 'approaching', sent_at: nowSql() });
        const waiting = await this.db.query<Row>(`SELECT t.student_id, s.first_name FROM student_transport t JOIN students s ON s.id = t.student_id WHERE t.stop_id = ? AND t.status = 'active'`, [String(s.id)]);
        for (const w of waiting) await this.notifyGuardians(schoolId, String(w.student_id), 'transport.bus_approaching', 'The bus is near your stop', `The bus is approaching ${s.name}. Please be ready.`, String(trip.id), ['push', 'in_app']);
        alerts++;
      }
    }
    return { stored, alerts, overspeed };
  }

  private async notifyGuardians(schoolId: string, studentId: string, eventKey: string, title: string, body: string, entityId: string, channels: ('sms' | 'push' | 'in_app' | 'email')[]) {
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels, eventKey, title, body, entityType: 'transport.trip', entityId });
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      'transport.create_trips': async ({ schoolId }) => this.createTrips(schoolId),
      // J4: a bus that has not moved ten minutes after its time is a bus the parents should hear about
      'transport.delay_watch': async ({ schoolId }) => {
        const now = nowSql();
        const due = await this.db.query<Row>(`SELECT t.*, r.name AS route_name, v.registration_no FROM vehicle_trips t JOIN transport_routes r ON r.id = t.route_id JOIN vehicles v ON v.id = t.vehicle_id
          WHERE t.school_id = ? AND t.trip_date = ? AND t.status = 'scheduled' AND t.scheduled_start IS NOT NULL AND t.delay_alert_sent_at IS NULL`, [schoolId, now.slice(0, 10)]);
        let alerted = 0;
        for (const t of due) {
          const scheduled = `${String(t.trip_date).slice(0, 10)} ${String(t.scheduled_start).slice(0, 8)}`;
          if (Date.parse(`${scheduled.replace(' ', 'T')}Z`) + 10 * 60_000 > Date.parse(`${now.replace(' ', 'T')}Z`)) continue;
          await this.db.update('vehicle_trips', { status: 'delayed', delay_alert_sent_at: now, updated_at: nowSql() }, { id: String(t.id) });
          await this.notifications.notifyRole(schoolId, 'admin', { channels: ['push', 'in_app'], eventKey: 'transport.delayed', title: 'Bus has not started', body: `${t.route_name} (${t.registration_no}) was due to start at ${String(t.scheduled_start).slice(0, 5)}.`, entityType: 'transport.trip', entityId: String(t.id) });
          const riders = await this.db.query<{ student_id: string }>(`SELECT student_id FROM student_transport WHERE route_id = ? AND status = 'active'`, [String(t.route_id)]);
          for (const r of riders) await this.notifyGuardians(schoolId, String(r.student_id), 'transport.delayed', 'The bus is running late', `${t.route_name} has not started yet. We will update you.`, String(t.id), ['push', 'in_app']);
          alerted++;
        }
        return { alerted };
      },
      /**
       * J7 and J10: papers and servicing.
       *
       * Two things were wrong with the old pass. It raised a fresh task every night for thirty
       * nights, so a bus with an insurance renewal due left thirty identical rows in the office's
       * list; and a date that had already gone by dropped out of the window entirely, so the one
       * state that matters — the fitness certificate expired last week and the bus went out this
       * morning — was the one state nobody was told about. The window now runs from "whenever" to
       * thirty days out, an expired paper is called expired, and `tasks.ensure` keeps it to one task
       * per vehicle per paper until somebody closes it.
       */
      'transport.document_expiry': async ({ schoolId }) => {
        const soon = addDays(nowSql().slice(0, 10), 30), today = nowSql().slice(0, 10);
        const fields: [string, string][] = [['insurance_expiry', 'insurance'], ['fitness_expiry', 'fitness certificate'], ['tax_token_expiry', 'tax token'], ['route_permit_expiry', 'route permit']];
        let raised = 0, expired = 0;
        for (const [col, label] of fields) {
          const rows = await this.db.query<Row>(`SELECT * FROM vehicles WHERE school_id = ? AND ${col} IS NOT NULL AND ${col} <= ? AND status <> 'inactive'`, [schoolId, soon]);
          for (const v of rows) {
            const on = String(v[col]).slice(0, 10);
            const gone = on < today;
            if (gone) expired++;
            // one task per vehicle *per paper*, so the entity is the paper and not the bus
            const made = await this.tasks.ensure({ schoolId, title: gone ? `${v.registration_no}: the ${label} expired on ${on}` : `Renew the ${label} of ${v.registration_no} by ${on}`, description: gone ? 'A vehicle without valid papers should not be carrying children. Renew it or take the vehicle off the road.' : null, taskType: 'transport.compliance', assignedRole: 'admin', entityType: `transport.paper.${col}`, entityId: String(v.id), dueAt: on, priority: gone ? 'urgent' : 'high' });
            if (made) raised++;
          }
        }
        const service = await this.db.query<Row>(`SELECT m.*, v.registration_no FROM vehicle_maintenance m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.school_id = ? AND m.next_due_date IS NOT NULL AND m.next_due_date <= ?`, [schoolId, soon]);
        for (const m of service) { if (await this.tasks.ensure({ schoolId, title: `Service due for ${m.registration_no} (${m.service_type})`, taskType: 'transport.maintenance', assignedRole: 'admin', entityType: 'transport.maintenance', entityId: String(m.id), dueAt: String(m.next_due_date).slice(0, 10), priority: String(m.next_due_date).slice(0, 10) < today ? 'high' : 'normal' })) raised++; }
        return { tasks: raised, expired };
      },
      /**
       * J9: is the fleet fit to run tomorrow?
       *
       * This is the question the transport manager asks at five in the afternoon and the one nobody
       * asks on the afternoon it matters. A route is checked against the three things that stop it
       * leaving: no vehicle on it at all, a vehicle with nobody assigned to drive it, and a vehicle
       * whose papers have run out. The answer goes out once for that date — a second run of the job
       * the same evening says nothing again — and it names the routes rather than counting them,
       * because "2 routes have a problem" sends somebody looking for the routes.
       *
       * It reports; it never cancels a route or reassigns a driver. Who drives tomorrow is a person's
       * decision about people.
       */
      'transport.readiness': async ({ schoolId, payload }) => {
        const forDate = typeof payload?.forDate === 'string' ? payload.forDate : addDays(nowSql().slice(0, 10), 1);
        const routes = await this.db.query<Row>(`SELECT r.*, v.registration_no, v.driver_id, v.status AS vehicle_status, v.insurance_expiry, v.fitness_expiry, v.tax_token_expiry, v.route_permit_expiry,
            (SELECT COUNT(*) FROM student_transport t WHERE t.route_id = r.id AND t.status = 'active') AS riders
          FROM transport_routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.school_id = ? AND r.status = 'active' ORDER BY r.name`, [schoolId]);
        const problems: { routeId: string; route: string; riders: number; reasons: string[] }[] = [];
        for (const r of routes) {
          if (!Number(r.riders)) continue;                       // a route nobody rides is not tomorrow's problem
          const reasons: string[] = [];
          if (!r.vehicle_id) reasons.push('no vehicle is on the route');
          else {
            if (!r.driver_id) reasons.push(`${r.registration_no} has no driver`);
            if (r.vehicle_status === 'inactive' || r.vehicle_status === 'maintenance') reasons.push(`${r.registration_no} is ${r.vehicle_status}`);
            for (const [col, label] of [['insurance_expiry', 'insurance'], ['fitness_expiry', 'fitness certificate'], ['tax_token_expiry', 'tax token'], ['route_permit_expiry', 'route permit']] as [string, string][]) {
              if (r[col] && String(r[col]).slice(0, 10) < forDate) reasons.push(`${label} expired on ${String(r[col]).slice(0, 10)}`);
            }
          }
          if (!reasons.length) continue;
          problems.push({ routeId: String(r.id), route: String(r.name), riders: Number(r.riders), reasons });
          if (r.vehicle_id) await this.outbox.emitNow({ type: 'vehicle.unfit', schoolId, aggregateType: 'transport.vehicle', aggregateId: String(r.vehicle_id), payload: { vehicleId: String(r.vehicle_id), registrationNo: String(r.registration_no ?? ''), reasons: reasons.join('; '), forDate } });
        }
        if (problems.length) {
          const body = problems.map(p => `${p.route} (${p.riders} riders): ${p.reasons.join(', ')}`).join(' · ');
          await this.notifications.notifyRoleOnce(schoolId, 'admin', 20, { channels: ['push', 'in_app'], eventKey: 'transport.not_ready', title: `${problems.length} route(s) are not ready for ${forDate}`, body: body.slice(0, 600), entityType: 'transport.readiness', entityId: forDate });
          await this.tasks.ensure({ schoolId, title: `${problems.length} route(s) cannot run on ${forDate}`, description: body.slice(0, 2000), taskType: 'transport.readiness', assignedRole: 'admin', entityType: 'transport.readiness', entityId: forDate, dueAt: forDate, priority: 'urgent' });
        }
        return { forDate, checked: routes.length, problems: problems.length, routes: problems.map(p => p.route) };
      },
    };
  }
}

/** Great-circle distance in metres — good enough to tell a bus is at a stop. */
function metres(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const addDays = (date: string, days: number) => { const d = new Date(`${date.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
