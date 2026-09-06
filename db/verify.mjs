#!/usr/bin/env node
// Applies db/sqlite/schema.sql to an in-memory SQLite database (node:sqlite) and runs a smoke test.
//   node db/verify.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, 'sqlite', 'schema.sql'), 'utf8');
const db = new DatabaseSync(':memory:');
db.exec(sql);
const n = db.prepare("select count(*) as n from sqlite_master where type='table'").get().n;
const ix = db.prepare("select count(*) as n from sqlite_master where type='index'").get().n;
console.log(`sqlite: ${n} tables, ${ix} indexes created`);
// smoke: tenant → year → class → section → student → enrollment → invoice → payment → allocation
const ulid = (() => { let i = 0; return () => 'S' + String(++i).padStart(25, '0'); })();
const school = ulid(), year = ulid(), cls = ulid(), sec = ulid(), st = ulid(), inv = ulid(), pay = ulid();
db.exec(`INSERT INTO schools(id,code,name) VALUES ('${school}','DEMO','Demo School');
INSERT INTO academic_years(id,school_id,name,start_date,end_date,is_current) VALUES ('${year}','${school}','2026','2026-01-01','2026-12-31',1);
INSERT INTO classes(id,school_id,name,numeric_level) VALUES ('${cls}','${school}','Class 6',6);
INSERT INTO sections(id,school_id,academic_year_id,class_id,name) VALUES ('${sec}','${school}','${year}','${cls}','A');
INSERT INTO students(id,school_id,admission_no,first_name,gender,date_of_birth,admission_date,current_section_id) VALUES ('${st}','${school}','2026-00001','Ayesha','female','2014-03-02','2026-01-10','${sec}');
INSERT INTO student_enrollments(id,school_id,student_id,academic_year_id,class_id,section_id,roll_no,enrolled_on) VALUES ('${ulid()}','${school}','${st}','${year}','${cls}','${sec}','1','2026-01-10');
INSERT INTO invoices(id,school_id,invoice_no,student_id,issue_date,due_date,subtotal,total,balance) VALUES ('${inv}','${school}','INV-1','${st}','2026-09-01','2026-09-10',3800,3800,3800);
INSERT INTO payments(id,school_id,payment_no,student_id,amount,method) VALUES ('${pay}','${school}','RCPT-1','${st}',1500,'bkash');
INSERT INTO payment_allocations(id,school_id,payment_id,invoice_id,amount) VALUES ('${ulid()}','${school}','${pay}','${inv}',1500);`);
console.log('smoke:', db.prepare('select invoice_no, total, balance from invoices').get());
// FK enforcement check: bad student id must fail
let fkOk = false; try { db.exec(`INSERT INTO invoices(id,school_id,invoice_no,student_id,issue_date,due_date) VALUES ('${ulid()}','${school}','INV-2','NOPE','2026-09-01','2026-09-10')`); } catch (e) { fkOk = /FOREIGN KEY/i.test(e.message); }
console.log('fk enforced:', fkOk);
// enum CHECK: invalid status must fail
let ckOk = false; try { db.exec(`UPDATE invoices SET status='bogus' WHERE id='${inv}'`); } catch (e) { ckOk = /CHECK/i.test(e.message); }
console.log('enum check enforced:', ckOk);
if (!fkOk || !ckOk) process.exit(1);
console.log('SQLITE_OK');
