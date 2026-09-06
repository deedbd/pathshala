// Operations: transport, hostel, procurement & inventory & assets, facilities & maintenance, front office & helpdesk
export default [
{ key:'transport', group:'Operations', title:'Transport & GPS', color:'#B45309', year:1,
  desc:'Routes, geofenced stops, vehicles with document expiry, driver/helper app, daily trips, GPS telemetry, RFID boardings with guardian push, delay/over-speed alerts, fuel and maintenance, route fee into billing.',
  tables:{
  vehicles:{ desc:'Fleet with compliance dates.', cols:`
    campus_id        ulid >campuses:null
    registration_no  str(30) !
    vehicle_type     enum(bus|microbus|van|car) ! =bus
    make_model       str(80)
    capacity         small !
    driver_id        ulid >staff:null
    helper_id        ulid >staff:null
    gps_device_id    str(60)
    insurance_expiry date
    fitness_expiry   date
    tax_token_expiry date
    route_permit_expiry date
    odometer_km      int
    status           enum(active|maintenance|inactive) ! =active
  `, unique:[['school_id','registration_no']] },
  transport_routes:{ desc:'Route with default fee.', cols:`
    name         str(120) !
    vehicle_id   ulid >vehicles:null
    start_point  str(120)
    end_point    str(120)
    distance_km  dec(6,2)
    monthly_fee  money ! =0
    fee_head_id  ulid >fee_heads:null
    status       enum(active|inactive) ! =active
  `, unique:[['school_id','name']] },
  route_stops:{ desc:'Ordered stops with geofence and times.', cols:`
    route_id    ulid ! >transport_routes
    name        str(120) !
    sequence    small !
    latitude    dec(9,6)
    longitude   dec(9,6)
    geofence_m  small ! =300
    pickup_time time
    drop_time   time
    fee_override money
  `, unique:[['route_id','sequence']] },
  student_transport:{ desc:'Student assignment to route/stop with fee snapshot.', cols:`
    student_id       ulid ! >students
    academic_year_id ulid ! >academic_years
    route_id         ulid ! >transport_routes:restrict
    stop_id          ulid ! >route_stops:restrict
    trip_type        enum(pickup|drop|both) ! =both
    start_date       date !
    end_date         date
    monthly_fee      money !
    status           enum(active|inactive) ! =active
  `, unique:[['student_id','academic_year_id']] },
  vehicle_trips:{ desc:'Daily trip instance with status and delay stamp.', cols:`
    vehicle_id  ulid ! >vehicles
    route_id    ulid ! >transport_routes
    trip_date   date !
    trip_type   enum(pickup|drop) !
    driver_id   ulid >staff:null
    helper_id   ulid >staff:null
    scheduled_start time
    started_at  dt
    ended_at    dt
    status      enum(scheduled|running|completed|cancelled|delayed) ! =scheduled
    delay_alert_sent_at dt
    checklist   json
  `, unique:[['vehicle_id','trip_date','trip_type']] },
  vehicle_gps_logs:{ ts:false, desc:'Telemetry (prune/rotate monthly).', cols:`
    vehicle_id  ulid ! >vehicles
    trip_id     ulid >vehicle_trips:null
    latitude    dec(9,6) !
    longitude   dec(9,6) !
    speed_kmh   dec(5,1)
    heading     small
    recorded_at dt !
  `, index:[['vehicle_id','recorded_at']] },
  transport_boardings:{ desc:'Boarded/alighted per student per trip.', cols:`
    trip_id     ulid ! >vehicle_trips
    student_id  ulid ! >students
    stop_id     ulid >route_stops:null
    boarded_at  dt
    alighted_at dt
    source      enum(rfid|helper_app|manual) ! =rfid
    guardian_notified_at dt
  `, unique:[['trip_id','student_id']] },
  stop_alerts:{ ts:false, desc:'Approaching/arrived/departed alerts sent per trip-stop.', cols:`
    trip_id    ulid ! >vehicle_trips
    stop_id    ulid ! >route_stops
    alert_type enum(approaching|arrived|departed) !
    sent_at    dt ! =now
  `, unique:[['trip_id','stop_id','alert_type']] },
  vehicle_maintenance:{ desc:'Service history with next due.', cols:`
    vehicle_id   ulid ! >vehicles
    service_type str(60) !
    service_date date !
    odometer_km  int
    cost         money
    vendor_id    ulid >vendors:null
    expense_id   ulid >expenses:null
    next_due_date date
    next_due_km  int
    notes        text
  `},
  fuel_logs:{ ts:false, desc:'Fuel fills.', cols:`
    vehicle_id  ulid ! >vehicles
    filled_at   dt ! =now
    litres      dec(7,2) !
    cost        money !
    odometer_km int
    expense_id  ulid >expenses:null
  `},
  driver_incidents:{ desc:'Accidents, over-speed, complaints per driver.', cols:`
    vehicle_id  ulid ! >vehicles
    driver_id   ulid >staff:null
    kind        enum(overspeed|accident|complaint|breakdown|other) !
    occurred_at dt !
    details     text
    severity    enum(low|medium|high) ! =low
  `},
}},

{ key:'hostel', group:'Operations', title:'Hostel', color:'#7C2D12', year:1,
  desc:'Hostels, rooms, beds with non-overlapping allocation, out-passes with guardian consent and curfew alerts, roll calls, visitors, mess menu and meal billing, laundry, complaints.',
  tables:{
  hostels:{ desc:'Building with warden, curfew and fee head.', cols:`
    campus_id   ulid >campuses:null
    name        str(120) !
    hostel_type enum(boys|girls|staff) !
    warden_id   ulid >staff:null
    address     json
    curfew_time time
    fee_head_id ulid >fee_heads:null
    status      enum(active|inactive) ! =active
  `, unique:[['school_id','name']] },
  hostel_rooms:{ desc:'Rooms with capacity and fee.', cols:`
    hostel_id   ulid ! >hostels
    room_no     str(20) !
    floor       str(10)
    room_type   enum(single|double|shared|dorm) ! =shared
    capacity    small !
    monthly_fee money ! =0
    amenities   json
    status      enum(active|maintenance|inactive) ! =active
  `, unique:[['hostel_id','room_no']] },
  hostel_beds:{ ts:false, desc:'Individual beds.', cols:`
    room_id ulid ! >hostel_rooms
    bed_no  str(10) !
    status  enum(vacant|occupied|maintenance) ! =vacant
  `, unique:[['room_id','bed_no']] },
  hostel_allocations:{ desc:'Student on a bed for a period (no overlap, app-enforced).', cols:`
    student_id       ulid ! >students
    bed_id           ulid ! >hostel_beds:restrict
    academic_year_id ulid ! >academic_years
    from_date        date !
    to_date          date
    monthly_fee      money !
    status           enum(active|ended) ! =active
  `, index:[['bed_id','from_date']] },
  hostel_outpasses:{ desc:'Leave from hostel with guardian consent, warden approval, QR, late-return alert.', cols:`
    student_id     ulid ! >students
    hostel_id      ulid ! >hostels
    leave_from     dt !
    expected_return dt !
    actual_out_at  dt
    actual_return_at dt
    reason         str(200) !
    destination    str(160)
    guardian_consent_at dt
    status         enum(pending|approved|rejected|out|returned|late) ! =pending
    approved_by    ulid >users:null
    qr_code        str(64)
    late_alert_sent_at dt
  `},
  hostel_visitors:{ desc:'Visitor log per resident.', cols:`
    hostel_id    ulid ! >hostels
    student_id   ulid ! >students
    visitor_name str(160) !
    relation     str(40)
    phone        str(20)
    id_proof     str(60)
    in_at        dt ! =now
    out_at       dt
    approved_by  ulid >users:null
  `},
  hostel_attendance:{ desc:'Morning/night roll call.', cols:`
    hostel_id  ulid ! >hostels
    student_id ulid ! >students
    on_date    date !
    roll_call  enum(morning|night) ! =night
    status     enum(present|absent|on_outpass|sick) !
    marked_by  ulid >users:null
  `, unique:[['student_id','on_date','roll_call']] },
  mess_menus:{ ts:false, desc:'Weekly menu.', cols:`
    hostel_id   ulid ! >hostels
    day_of_week small !
    meal        enum(breakfast|lunch|snack|dinner) !
    items       str(255) !
  `, unique:[['hostel_id','day_of_week','meal']] },
  meal_records:{ ts:false, desc:'Per-meal attendance/billing (optional per-meal mess billing).', cols:`
    hostel_id  ulid ! >hostels
    student_id ulid ! >students
    on_date    date !
    meal       enum(breakfast|lunch|snack|dinner) !
    taken      bool ! =true
    cost       money
  `, unique:[['student_id','on_date','meal']] },
  laundry_records:{ ts:false, desc:'Laundry drop/return tracking.', cols:`
    hostel_id  ulid ! >hostels
    student_id ulid ! >students
    dropped_at dt ! =now
    items      small !
    returned_at dt
    charge     money
  `},
  hostel_complaints:{ desc:'Resident complaints.', cols:`
    hostel_id   ulid ! >hostels
    student_id  ulid >students:null
    category    enum(maintenance|food|safety|cleanliness|other) !
    description text !
    status      enum(open|in_progress|resolved) ! =open
    resolved_at dt
  `},
}},

{ key:'inventory', group:'Operations', title:'Procurement, inventory & assets', color:'#4338CA', year:1,
  desc:'Items and stores, requisitions, quotations/tenders, purchase orders with approvals, goods receipt, append-only stock ledger, issue requests, fixed assets with QR tags, maintenance and depreciation, disposal.',
  tables:{
  inventory_categories:{ desc:'Categories; asset categories create fixed assets on receipt.', cols:`
    name     str(80) !
    is_asset bool ! =false
    gl_account_id ulid >gl_accounts:null
  `, unique:[['school_id','name']] },
  stores:{ desc:'Stores/warehouses with keeper.', cols:`
    name      str(80) !
    campus_id ulid >campuses:null
    keeper_id ulid >staff:null
  `, unique:[['school_id','name']] },
  inventory_items:{ desc:'Item master with reorder rule.', cols:`
    category_id   ulid ! >inventory_categories:restrict
    sku           str(40) !
    name          str(160) !
    unit          str(20) ! =pcs
    reorder_level dec(12,2) ! =0
    reorder_qty   dec(12,2)
    preferred_vendor_id ulid >vendors:null
    last_cost     money
    barcode       str(60)
    status        enum(active|inactive) ! =active
  `, unique:[['school_id','sku']] },
  stock_levels:{ ts:false, desc:'Current quantity per item per store (maintained by app on each movement).', cols:`
    item_id   ulid ! >inventory_items
    store_id  ulid ! >stores
    quantity  dec(12,2) ! =0
    updated_at dt ! =now
  `, unique:[['item_id','store_id']] },
  requisitions:{ desc:'Purchase requests from departments.', cols:`
    requested_by  ulid ! >staff
    department_id ulid >departments:null
    items         json
    justification text
    status        enum(pending|approved|rejected|ordered) ! =pending
    approval_request_id ulid
    approved_by   ulid >users:null
  `},
  quotations:{ desc:'Vendor quotations / tender bids for a requisition.', cols:`
    requisition_id ulid >requisitions:null
    vendor_id      ulid ! >vendors
    quoted_at      date !
    valid_until    date
    items          json
    total          money !
    file_id        ulid >files:null
    is_selected    bool ! =false
  `},
  purchase_orders:{ desc:'PO with approval, receipt and bill link.', cols:`
    po_no        str(30) !
    vendor_id    ulid ! >vendors:restrict
    store_id     ulid ! >stores:restrict
    requisition_id ulid >requisitions:null
    order_date   date !
    expected_date date
    subtotal     money ! =0
    tax_total    money ! =0
    total        money ! =0
    status       enum(draft|pending_approval|approved|ordered|partially_received|received|cancelled) ! =draft
    is_auto      bool ! =false
    approval_request_id ulid
    approved_by  ulid >users:null
    bill_id      ulid >vendor_bills:null
    created_by   ulid >users:null
  `, unique:[['school_id','po_no']] },
  purchase_order_items:{ ts:false, desc:'PO lines with received qty.', cols:`
    po_id        ulid ! >purchase_orders
    item_id      ulid ! >inventory_items:restrict
    quantity     dec(12,2) !
    received_qty dec(12,2) ! =0
    unit_cost    money !
  `, unique:[['po_id','item_id']] },
  goods_receipts:{ desc:'GRN against a PO.', cols:`
    po_id       ulid ! >purchase_orders
    received_at dt ! =now
    received_by ulid >users:null
    items       json
    notes       str(255)
  `},
  stock_movements:{ ts:false, desc:'Append-only ledger: in/out/adjust/transfer/return.', cols:`
    item_id     ulid ! >inventory_items:restrict
    store_id    ulid ! >stores:restrict
    move_type   enum(in|out|adjust|transfer|return|consume) !
    quantity    dec(12,2) !
    unit_cost   money
    ref_type    str(40)
    ref_id      ulid
    issued_to_staff_id ulid >staff:null
    issued_to_room_id  ulid >rooms:null
    note        str(255)
    created_by  ulid >users:null
    created_at  dt ! =now
  `, index:[['item_id','created_at']] },
  issue_requests:{ desc:'Consumable requests → stock-out on approval.', cols:`
    requested_by ulid ! >staff
    store_id     ulid ! >stores:restrict
    items        json
    purpose      str(160)
    status       enum(pending|approved|rejected|issued) ! =pending
    approved_by  ulid >users:null
    issued_at    dt
  `},
  assets:{ desc:'Fixed asset with tag, custodian, warranty and value.', cols:`
    item_id         ulid >inventory_items:null
    asset_tag       str(30) !
    name            str(160) !
    serial_no       str(80)
    purchase_date   date
    purchase_cost   money
    vendor_id       ulid >vendors:null
    po_id           ulid >purchase_orders:null
    warranty_until  date
    depreciation_pct pct
    current_value   money
    location_room_id ulid >rooms:null
    custodian_staff_id ulid >staff:null
    condition_note  enum(new|good|fair|repair|damaged) ! =good
    status          enum(in_use|in_store|repair|disposed|lost) ! =in_use
    qr_file_id      ulid >files:null
    disposed_at     date
    disposal_note   str(255)
  `, unique:[['school_id','asset_tag']] },
  asset_maintenance:{ desc:'Service history with next due.', cols:`
    asset_id      ulid ! >assets
    service_date  date !
    service_type  enum(preventive|repair|calibration|inspection) !
    cost          money
    vendor_id     ulid >vendors:null
    expense_id    ulid >expenses:null
    next_due_date date
    notes         text
  `},
  asset_audits:{ desc:'Periodic physical verification runs.', cols:`
    name        str(120) !
    started_at  date !
    finished_at date
    results     json
    status      enum(running|completed) ! =running
  `},
}},

{ key:'facilities', group:'Operations', title:'Facilities & maintenance', color:'#065F46', year:2,
  desc:'Room/hall/ground bookings, work orders for repairs, cleaning schedules, utility meter readings, safety drills, generator/water logs.',
  tables:{
  room_bookings:{ desc:'Book a room/hall/ground for an event or class (no overlap, app-enforced).', cols:`
    room_id    ulid ! >rooms
    booked_by  ulid ! >users
    purpose    str(160) !
    starts_at  dt !
    ends_at    dt !
    status     enum(pending|approved|rejected|cancelled) ! =pending
    approved_by ulid >users:null
  `, index:[['room_id','starts_at']] },
  work_orders:{ desc:'Repair/maintenance requests with SLA.', cols:`
    title        str(160) !
    description  text
    location_room_id ulid >rooms:null
    asset_id     ulid >assets:null
    category     enum(electrical|plumbing|civil|it|furniture|cleaning|other) !
    priority     enum(low|normal|high|urgent) ! =normal
    reported_by  ulid >users:null
    assigned_to  ulid >staff:null
    vendor_id    ulid >vendors:null
    status       enum(open|assigned|in_progress|done|cancelled) ! =open
    due_at       dt
    cost         money
    expense_id   ulid >expenses:null
    completed_at dt
  `},
  cleaning_schedules:{ desc:'Recurring cleaning tasks with checklist.', cols:`
    area        str(120) !
    frequency   enum(daily|weekly|monthly) !
    assigned_to ulid >staff:null
    checklist   json
    last_done_at dt
  `},
  utility_readings:{ ts:false, desc:'Electricity/water/gas meter readings and bills.', cols:`
    utility    enum(electricity|water|gas|internet|generator_fuel) !
    campus_id  ulid >campuses:null
    read_at    date !
    reading    dec(12,2) !
    cost       money
    expense_id ulid >expenses:null
  `},
  safety_drills:{ desc:'Fire/earthquake drills and inspections.', cols:`
    kind        enum(fire|earthquake|evacuation|first_aid|inspection) !
    held_on     date !
    participants int
    findings    text
    file_id     ulid >files:null
  `},
}},

{ key:'frontoffice', group:'Operations', title:'Front office, helpdesk & gate', color:'#334155', year:1,
  desc:'Visitor log with host notification and photo badge, gate passes, early pickup verification, call log, postal, complaints/helpdesk with SLA and escalation, lost & found.',
  tables:{
  visitor_logs:{ desc:'Check-in/out with purpose, host and badge.', cols:`
    campus_id     ulid >campuses:null
    visitor_name  str(160) !
    phone         str(20)
    id_proof      str(60)
    purpose       enum(admission|meeting|delivery|pickup|interview|vendor|other) ! =other
    to_meet_staff_id ulid >staff:null
    student_id    ulid >students:null
    badge_no      str(20)
    photo_file_id ulid >files:null
    in_at         dt ! =now
    out_at        dt
    host_notified_at dt
    logged_by     ulid >users:null
  `},
  gate_passes:{ desc:'Student early leave / staff out pass with QR.', cols:`
    person_type  enum(student|staff) !
    student_id   ulid >students:null
    staff_id     ulid >staff:null
    reason       str(160) !
    out_at       dt !
    expected_in  dt
    actual_in    dt
    picked_by    str(160)
    authorisation_id ulid >pickup_authorisations:null
    approved_by  ulid >users:null
    qr_code      str(64)
    status       enum(pending|approved|out|returned|rejected) ! =pending
  `},
  call_logs:{ desc:'Inbound/outbound calls with follow-up.', cols:`
    direction    enum(inbound|outbound) !
    caller_name  str(160)
    phone        str(20) !
    purpose      str(160)
    notes        text
    related_type str(40)
    related_id   ulid
    follow_up_at dt
    logged_by    ulid >users:null
    called_at    dt ! =now
  `},
  postal_records:{ desc:'Dispatch/receive register.', cols:`
    direction    enum(dispatch|receive) !
    reference_no str(60)
    from_party   str(160)
    to_party     str(160)
    subject      str(200)
    record_date  date !
    file_id      ulid >files:null
    logged_by    ulid >users:null
  `},
  complaints:{ desc:'Helpdesk tickets with category, priority, SLA, escalation and satisfaction.', cols:`
    ticket_no      str(30) !
    complainant_user_id ulid >users:null
    complainant_name str(160)
    complainant_phone str(20)
    student_id     ulid >students:null
    category       enum(academic|fees|transport|hostel|staff_behaviour|facility|safety|it|other) !
    subject        str(200) !
    description    text !
    priority       enum(low|normal|high|urgent) ! =normal
    assigned_to    ulid >staff:null
    sla_due_at     dt
    escalated_at   dt
    status         enum(open|in_progress|resolved|closed|reopened) ! =open
    resolution     text
    resolved_at    dt
    satisfaction   small
  `, unique:[['school_id','ticket_no']] },
  complaint_updates:{ ts:false, desc:'Thread of updates.', cols:`
    complaint_id ulid ! >complaints
    by_user_id   ulid >users:null
    note         text !
    is_internal  bool ! =false
    created_at   dt ! =now
  `},
  lost_found_items:{ desc:'Lost & found register.', cols:`
    description   str(200) !
    found_at      dt
    location      str(120)
    photo_file_id ulid >files:null
    claimed_by    str(160)
    claimed_at    dt
    status        enum(found|claimed|disposed) ! =found
  `},
}},
];
