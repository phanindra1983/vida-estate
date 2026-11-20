// Demo data for Vida OS. Run: npm run db:reset
// All names, projects and numbers are fictional demo data.
// Demo login: every user below shares the password in DEMO_PASSWORD (also in README).
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { importData } from "./import-data.mjs";

const db = new PrismaClient();
const DEMO_PASSWORD = "VidaDemo@2026";
const DAY = 864e5;
const now = Date.now();
const daysAgo = (d) => new Date(now - d * DAY);
const daysFromNow = (d) => new Date(now + d * DAY);
const minsAgo = (m) => new Date(now - m * 60000);

// deterministic pseudo-random
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

async function main() {
  // Triggers make the audit trail append-only.
  // One trigger per line in triggers.sql.
  for (const stmt of readFileSync(new URL("./triggers.sql", import.meta.url), "utf8").split("\n").map((s) => s.trim()).filter(Boolean)) {
    try { await db.$executeRawUnsafe(stmt); } catch (e) { if (!String(e).includes("already exists")) throw e; }
  }

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const people = [
    ["Ananya Rao", "md", "MD", "Leadership", "Managing Director"],
    ["Vikram Shah", "finance", "FINANCE_HEAD", "Finance", "Finance Head"],
    ["Lakshmi Iyer", "accounts", "ACCOUNTS", "Finance", "Accounts Executive"],
    ["Rahul Menon", "saleshead", "SALES_HEAD", "Sales", "Sales Head"],
    ["Priya Nair", "salesmanager", "SALES_MANAGER", "Sales", "Sales Manager"],
    ["Arjun Reddy", "arjun", "SALES_EXEC", "Sales", "Sales Executive"],
    ["Sneha Kapoor", "sneha", "SALES_EXEC", "Sales", "Sales Executive"],
    ["Karthik Varma", "gm", "GM_PROJECTS", "Projects", "GM Projects"],
    ["Ravi Teja", "pm.aurum", "PROJECT_MANAGER", "Projects", "Project Manager"],
    ["Meera Joshi", "pm.luxora", "PROJECT_MANAGER", "Projects", "Project Manager"],
    ["Suresh Kumar", "site", "SITE_ENGINEER", "Projects", "Site Engineer"],
    ["Imran Khan", "purchase", "PURCHASE", "Procurement", "Purchase Officer"],
    ["Gopal Das", "stores", "STOREKEEPER", "Procurement", "Storekeeper"],
    ["Divya Pillai", "hr", "HR", "HR", "HR Manager"],
    ["Nikhil Jain", "marketing", "MARKETING", "Marketing", "Marketing Manager"],
  ];
  const U = {};
  for (const [name, handle, role, dept, desig] of people) {
    const u = await db.user.create({ data: { name, email: `${handle}@vidaestates.demo`, passwordHash: hash, role, phone: "9" + String(Math.floor(rnd() * 1e9)).padStart(9, "0") } });
    await db.employee.create({ data: { name, department: dept, designation: desig, joinedOn: daysAgo(200 + Math.floor(rnd() * 100)), userId: u.id, phone: u.phone } });
    U[handle] = u;
  }

  // Delegation of authority (example values, editable in Control → Approval limits)
  const rules = {
    PURCHASE_ORDER: [["PROJECT_MANAGER", 100000], ["GM_PROJECTS", 1000000], ["MD", null]],
    BUDGET_REVISION: [["GM_PROJECTS", 100000], ["FINANCE_HEAD", 1000000], ["MD", null]],
    VENDOR_PAYMENT: [["FINANCE_HEAD", 1000000], ["MD", null]],
    PAYOUT: [["SALES_HEAD", 100000], ["FINANCE_HEAD", 1000000], ["MD", null]],
    DISCOUNT: [["SALES_MANAGER", 100000], ["SALES_HEAD", 500000], ["MD", null]],
    MILESTONE: [["GM_PROJECTS", null]],
    RFQ_AWARD: [["PROJECT_MANAGER", 100000], ["GM_PROJECTS", 1000000], ["MD", null]],
  };
  for (const [action, levels] of Object.entries(rules))
    for (const [i, [role, upTo]] of levels.entries()) await db.approvalRule.create({ data: { action, level: i + 1, role, upToAmount: upTo } });

  const codes = [
    ["01", "Land & approvals"], ["02", "Design & consultants"], ["03", "Excavation & foundation"], ["04", "Steel"],
    ["05", "Cement & concrete"], ["06", "Masonry & plaster"], ["07", "Electrical"], ["08", "Plumbing & sanitary"],
    ["09", "Finishes & flooring"], ["10", "Lifts & MEP equipment"], ["11", "Site overheads"], ["12", "Marketing & sales"],
  ];
  const CC = {};
  for (const [code, name] of codes) CC[code] = await db.costCode.create({ data: { code, name } });

  const vendorList = [
    ["Deccan Steel Traders", "Steel & couplers", "36AABCD1234E1Z5"], ["Sri Sai Cements", "Cement", "36AACCS5678F1Z2"],
    ["Hyderabad Ready Mix", "Ready-mix concrete", "36AADCH9012G1Z8"], ["Bright Electricals", "Electrical (cables, wires & switchgear)", "36AAECB3456H1Z1"],
    ["AquaFlow Plumbing", "Plumbing pipes & fittings", "36AAFCA7890J1Z4"], ["Stonecraft Tiles", "Tiles & stone", "36AAGCS2345K1Z7"],
    ["Telangana Infra Works", "Excavation & foundation", "36AAHCT6789L1Z3"], ["Red Earth Blocks", "AAC blocks & masonry", "36AAJCR1357M1Z6"],
    ["Skyline Elevators", "Lifts", "36AAKCS2468N1Z9"],
    ["Studio Arc Architects", "Design & consultants", "36AALCS3579P1Z2"], ["Deccan Approvals Consultancy", "Land & approvals", "36AAMCD4680Q1Z5"],
  ];
  const V = {};
  for (const [name, category, gstin] of vendorList) V[category + name] = await db.vendor.create({ data: { name, category, gstin, rating: 3 + Math.floor(rnd() * 3), phone: "98" + String(Math.floor(rnd() * 1e8)).padStart(8, "0") } });
  const CAT = { "Steel": "Steel & couplers", "Cement & concrete": "Ready-mix concrete", "Masonry & plaster": "AAC blocks & masonry", "Electrical": "Electrical (cables, wires & switchgear)", "Plumbing & sanitary": "Plumbing pipes & fittings", "Finishes & flooring": "Tiles & stone", "Lifts & MEP equipment": "Lifts" };
  const vendor = (cat) => Object.values(V).find((v) => v.category === (CAT[cat] ?? cat)) ?? Object.values(V)[0];

  const cps = [];
  for (const [name, firm, pct] of [["Ramesh Gupta", "Gupta Realty", 2], ["Fatima Begum", "Charminar Homes", 2.5], ["Sanjay Rao", "WestSide Properties", 2]])
    cps.push(await db.channelPartner.create({ data: { name, firm, commissionPct: pct, phone: "97" + String(Math.floor(rnd() * 1e8)).padStart(8, "0"), reraAgentNo: "A0" + Math.floor(1e5 + rnd() * 8e5) } }));

  // ── Projects ──
  const projects = [
    { code: "VA", name: "Vida Aurum", location: "Kokapet, Hyderabad", rate: 9500, towers: [["Tower A", 20], ["Tower B", 20]], reraNo: "P02400008xxx (demo)", started: 260, status: "UNDER_CONSTRUCTION", desc: "Premium 2, 3 and 4 BHK residences on the Kokapet ridge." },
    // Vida Luxora: layout from the project deck (3 blocks, 28 floors, 3 BHK only). Price per sq ft is a demo placeholder.
    { code: "VL", name: "Vida Luxora", location: "GOCL, Kukatpally, Hyderabad", rate: 9200, towers: [["Block A", 28], ["Block B", 28], ["Block C", 28]], reraNo: null, started: -180, status: "PLANNING", desc: "Three 28-floor towers of 3 BHK homes on 80% open land, with a 300 ft central courtyard and a 70,000 sq ft clubhouse." },
  ];
  const P = {};
  for (const p of projects) {
    const proj = await db.project.create({ data: { code: p.code, name: p.name, location: p.location, type: "Apartments", status: p.status, reraNo: p.reraNo, description: p.desc, published: true, launchDate: daysAgo(p.started - 20) } });
    P[p.code] = { ...p, proj, units: [], towersDb: [] };

    // access: PMs, site, purchase, store, sales execs and manager
    const access = p.code === "VA" ? ["pm.aurum", "site", "purchase", "stores", "arjun", "sneha", "salesmanager"] : ["pm.luxora", "site", "purchase", "stores", "arjun", "sneha", "salesmanager"];
    for (const h of access) await db.projectAccess.create({ data: { userId: U[h].id, projectId: proj.id } });

    // Per-floor layouts: [type, carpet, super built-up, facing]
    const AURUM = [["2BHK", 1180, 1460, "East"], ["3BHK", 1520, 1960, "East"], ["3BHK", 1560, 2010, "West"], ["4BHK", 2280, 2920, "North"]];
    // Vida Luxora sizes per unit number, from the deck. Blocks A and C: 10 homes a floor; Block B: 8.
    const L = (sba, facing) => ["3BHK", Math.round(sba * 0.74), sba, facing];
    const LUXORA_AC = [L(2550, "North"), L(2040, "North"), L(2340, "North"), L(2040, "East"), L(2550, "East"), L(2550, "West"), L(2040, "West"), L(2040, "West"), L(2040, "East"), L(2550, "North")];
    const LUXORA_B = [L(2550, "North"), L(2550, "North"), L(2040, "East"), L(2040, "East"), L(2550, "West"), L(2550, "West"), L(2340, "North"), L(2340, "North")];
    for (const [tname, floors] of p.towers) {
      const t = await db.tower.create({ data: { projectId: proj.id, name: tname, floors } });
      P[p.code].towersDb.push(t);
      const layout = p.code === "VA" ? AURUM : tname === "Block B" ? LUXORA_B : LUXORA_AC;
      const rows = [];
      for (let f = 1; f <= floors; f++)
        for (let i = 0; i < layout.length; i++) {
          const [type, carpet, sba, facing] = layout[i];
          const price = Math.round((sba * (p.rate + f * 30)) / 10000) * 10000;
          rows.push({ projectId: proj.id, towerId: t.id, number: `${tname.split(" ")[1]}-${f}${String(i + 1).padStart(2, "0")}`, floor: f, type, carpetSqft: carpet, sbaSqft: sba, facing, price });
        }
      await db.unit.createMany({ data: rows });
      P[p.code].units.push(...(await db.unit.findMany({ where: { towerId: t.id }, orderBy: [{ floor: "asc" }, { number: "asc" }] })));
    }
    const min = Math.min(...P[p.code].units.map((u) => u.price));
    await db.project.update({ where: { id: proj.id }, data: { startingPrice: min } });

    // Payment plans
    const clpStages = p.code === "VA"
      ? [["On booking", 10, null], ["Foundation complete", 10, "FOUNDATION"], ["Slab 5 complete", 10, "SLAB_5"], ["Slab 10 complete", 10, "SLAB_10"], ["Slab 15 complete", 10, "SLAB_15"], ["Slab 20 complete", 10, "SLAB_20"], ["Brickwork complete", 15, "BRICKWORK"], ["Finishes complete", 15, "FINISHES"], ["On possession", 10, "POSSESSION"]]
      : [["On booking", 10, null], ["Foundation complete", 10, "FOUNDATION"], ["Slab 7 complete", 10, "SLAB_7"], ["Slab 14 complete", 10, "SLAB_14"], ["Slab 21 complete", 10, "SLAB_21"], ["Slab 28 complete", 10, "SLAB_28"], ["Brickwork complete", 15, "BRICKWORK"], ["Finishes complete", 15, "FINISHES"], ["On possession", 10, "POSSESSION"]];
    const clp = await db.paymentPlan.create({ data: { projectId: proj.id, name: "Construction-linked plan", type: "CLP", stages: { create: clpStages.map(([name, pct, key], i) => ({ seq: i + 1, name, pct, milestoneKey: key })) } }, include: { stages: true } });
    const dpp = await db.paymentPlan.create({ data: { projectId: proj.id, name: "Down-payment plan (3% off)", type: "DOWN_PAYMENT", stages: { create: [{ seq: 1, name: "On booking", pct: 10 }, { seq: 2, name: "Within 30 days of booking", pct: 85 }, { seq: 3, name: "On possession", pct: 5, milestoneKey: "POSSESSION" }] } }, include: { stages: true } });
    P[p.code].plans = [clp, dpp];

    // Milestones per tower
    for (const t of P[p.code].towersDb) {
      const keys = p.code === "VA"
        ? [["FOUNDATION", "Foundation"], ["SLAB_5", "Slab 5"], ["SLAB_10", "Slab 10"], ["SLAB_15", "Slab 15"], ["SLAB_20", "Slab 20"], ["BRICKWORK", "Brickwork"], ["FINISHES", "Finishes"], ["POSSESSION", "Possession"]]
        : [["FOUNDATION", "Foundation"], ["SLAB_7", "Slab 7"], ["SLAB_14", "Slab 14"], ["SLAB_21", "Slab 21"], ["SLAB_28", "Slab 28"], ["BRICKWORK", "Brickwork"], ["FINISHES", "Finishes"], ["POSSESSION", "Possession"]];
      // Vida Luxora is awaiting RERA: every milestone is planned to start after approval.
      const start = p.started - (t.name === "Tower B" || t.name === "Block B" ? 40 : t.name === "Block C" ? 80 : 0);
      for (let i = 0; i < keys.length; i++) {
        const plannedStart = daysAgo(start - i * 55);
        const plannedEnd = daysAgo(start - (i + 1) * 55);
        let status = "NOT_STARTED", progressPct = 0, actualEnd = null, actualStart = null;
        const doneCount = p.code === "VA" ? (t.name === "Tower A" ? 2 : 1) : 0;
        if (i < doneCount) { status = "DONE"; progressPct = 100; actualStart = plannedStart; actualEnd = new Date(plannedEnd.getTime() + (i + 1) * 2 * DAY); }
        else if (i === doneCount && p.code === "VA") { status = "IN_PROGRESS"; actualStart = plannedStart; progressPct = p.code === "VA" ? (t.name === "Tower A" ? 70 : 85) : 40; }
        await db.milestone.create({ data: { projectId: proj.id, towerId: t.id, key: keys[i][0], name: `${keys[i][1]} · ${t.name}`, seq: i + 1, plannedStart, plannedEnd, actualStart, actualEnd, status, progressPct } });
      }
    }

    // Budgets (₹)
    const scale = p.code === "VA" ? 1 : 4.2; // Vida Luxora is about 4x Aurum's built-up area
    const budget = { "01": 18e7, "02": 4.5e7, "03": 9e7, "04": 14e7, "05": 16e7, "06": 7e7, "07": 6.5e7, "08": 4.8e7, "09": 11e7, "10": 5.2e7, "11": 3.6e7, "12": 4e7 };
    for (const [code, amt] of Object.entries(budget))
      await db.budgetLine.create({ data: { projectId: proj.id, costCodeId: CC[code].id, description: `${CC[code].name} · ${p.name}`, amount: Math.round(amt * scale) } });
  }

  // ── Leads, bookings, collections ──
  const first = ["Aditya", "Kavya", "Rohit", "Sanjana", "Varun", "Pooja", "Harsha", "Nandini", "Siddharth", "Ishita", "Manoj", "Deepika", "Pranav", "Swathi", "Ajay", "Bhavana", "Tarun", "Keerthi", "Naveen", "Shruti", "Gautam", "Anjali", "Rakesh", "Madhuri"];
  const last = ["Reddy", "Rao", "Sharma", "Gupta", "Naidu", "Chowdary", "Iyer", "Patel", "Varma", "Kumar", "Agarwal", "Menon"];
  const sources = ["WEBSITE", "META", "99ACRES", "MAGICBRICKS", "HOUSING", "WHATSAPP", "REFERRAL", "WALK_IN", "CHANNEL_PARTNER"];
  const execs = [U.arjun, U.sneha];
  const leads = [];
  const stagesMix = ["NEW", "CONTACTED", "CONTACTED", "VISIT_SCHEDULED", "VISIT_DONE", "VISIT_DONE", "NEGOTIATION", "LOST"];
  for (let i = 0; i < 64; i++) {
    const code = rnd() < 0.62 ? "VA" : "VL";
    const source = pick(sources);
    const created = daysAgo(1 + Math.floor(rnd() * 75));
    // Vida Luxora is pre-RERA: interest registrations only, no visits or negotiation yet.
    const stage = code === "VL" ? pick(["NEW", "CONTACTED", "CONTACTED", "LOST"]) : pick(stagesMix);
    const owner = execs[i % 2];
    const lead = await db.lead.create({
      data: {
        name: `${pick(first)} ${pick(last)}`, phone: "9" + String(Math.floor(1e8 + rnd() * 8.9e8)), email: rnd() < 0.7 ? `buyer${i}@example.com` : null,
        projectId: P[code].proj.id, source, campaign: source === "META" ? "Diwali launch" : null, channelPartnerId: source === "CHANNEL_PARTNER" ? pick(cps).id : null,
        ownerId: owner.id, stage, lostReason: stage === "LOST" ? pick(["Budget", "Bought elsewhere", "Location", "Not responding"]) : null,
        budget: pick(["₹1–1.5 Cr", "₹1.5–2 Cr", "₹2–3 Cr", "₹3 Cr+"]), preferredType: pick(["2BHK", "3BHK", "3BHK", "4BHK"]),
        consentAt: ["WEBSITE", "META"].includes(source) ? created : null, createdAt: created,
        firstCallAt: stage === "NEW" ? null : new Date(created.getTime() + (5 + rnd() * 90) * 60000),
        lastActivityAt: new Date(created.getTime() + rnd() * 5 * DAY),
        nextFollowUp: ["CONTACTED", "VISIT_SCHEDULED", "VISIT_DONE", "NEGOTIATION"].includes(stage) ? daysFromNow(Math.floor(rnd() * 6) - 2) : null,
      },
    });
    if (stage !== "NEW") {
      await db.activity.create({ data: { leadId: lead.id, userId: owner.id, type: "CALL", note: "Intro call. Shared brochure and price sheet on WhatsApp.", createdAt: lead.firstCallAt } });
      if (["VISIT_DONE", "NEGOTIATION"].includes(stage)) await db.activity.create({ data: { leadId: lead.id, userId: owner.id, type: "SITE_VISIT", note: "Visited sample flat with family.", createdAt: new Date(created.getTime() + 3 * DAY) } });
    }
    leads.push({ lead, code });
  }
  // Fresh leads with no call yet: these show the 15-minute escalation.
  for (const [n, m, src] of [["Rajesh Kumar", 34, "99ACRES"], ["Neha Verma", 22, "WEBSITE"], ["Farhan Ali", 6, "META"]])
    await db.lead.create({ data: { name: n, phone: "9" + String(Math.floor(1e8 + rnd() * 8.9e8)), projectId: P.VA.proj.id, source: src, ownerId: U.arjun.id, createdAt: minsAgo(m), consentAt: src !== "99ACRES" ? minsAgo(m) : null, preferredType: "3BHK" } });

  // Bookings
  let dl = { VA: 0, VL: 0 }, rc = { VA: 0, VL: 0 };
  const bookingPlan = [["VA", 24]]; // no bookings for Vida Luxora before RERA registration
  for (const [code, count] of bookingPlan) {
    const p = P[code];
    const avail = p.units.filter((u) => u.floor <= 14);
    for (let i = 0; i < count; i++) {
      const unit = avail.splice(Math.floor(rnd() * avail.length), 1)[0];
      const viaCp = i % 4 === 0;
      const bookedAt = daysAgo(code === "VA" ? 20 + Math.floor(rnd() * 220) : 5 + Math.floor(rnd() * 50));
      const owner = execs[i % 2];
      const lead = await db.lead.create({ data: { name: `${pick(first)} ${pick(last)}`, phone: "9" + String(Math.floor(1e8 + rnd() * 8.9e8)), projectId: p.proj.id, source: viaCp ? "CHANNEL_PARTNER" : pick(sources.slice(0, 8)), channelPartnerId: viaCp ? cps[i % 3].id : null, ownerId: owner.id, stage: "BOOKED", createdAt: new Date(bookedAt.getTime() - 20 * DAY), firstCallAt: new Date(bookedAt.getTime() - 20 * DAY + 600000), lastActivityAt: bookedAt } });
      const plan = i % 5 === 4 ? p.plans[1] : p.plans[0];
      const agreementValue = plan.type === "DOWN_PAYMENT" ? Math.round(unit.price * 0.97) : unit.price;
      const b = await db.booking.create({ data: { unitId: unit.id, leadId: lead.id, planId: plan.id, buyerName: lead.name, buyerPhone: lead.phone, agreementValue, tokenAmount: 500000, paymentRef: "UTR" + Math.floor(1e9 + rnd() * 9e9), bookedAt, bookedById: owner.id, status: rnd() < 0.6 ? "AGREEMENT_SIGNED" : "BOOKED" } });
      await db.unit.update({ where: { id: unit.id }, data: { status: "BOOKED" } });
      // demands for stages already due
      const tower = p.towersDb.find((t) => t.id === unit.towerId);
      const doneKeys = code === "VA" ? (tower.name === "Tower A" ? ["FOUNDATION", "SLAB_5"] : ["FOUNDATION"]) : [];
      for (const st of plan.stages) {
        const due = st.milestoneKey === null || doneKeys.includes(st.milestoneKey);
        if (!due) continue;
        const raisedAt = st.milestoneKey ? daysAgo(30 + Math.floor(rnd() * 60)) : bookedAt;
        const dueDate = new Date(Math.max(raisedAt.getTime(), bookedAt.getTime()) + (st.seq === 2 && plan.type === "DOWN_PAYMENT" ? 30 : 15) * DAY);
        const amount = Math.round((agreementValue * st.pct) / 100);
        const paidShare = dueDate.getTime() > now ? (rnd() < 0.4 ? 1 : 0) : rnd() < 0.78 ? 1 : rnd() < 0.5 ? 0.5 : 0;
        const status = paidShare >= 1 ? "PAID" : paidShare > 0 ? "PART_PAID" : "DUE";
        const d = await db.demand.create({ data: { bookingId: b.id, planStageId: st.id, number: `DL-${code}-${String(++dl[code]).padStart(4, "0")}`, amount, raisedAt, dueDate, status } });
        if (paidShare > 0) await db.receipt.create({ data: { bookingId: b.id, demandId: d.id, number: `RC-${code}-${String(++rc[code]).padStart(4, "0")}`, amount: Math.round(amount * paidShare), mode: pick(["NEFT", "RTGS", "UPI", "CHEQUE"]), reference: "TXN" + Math.floor(1e8 + rnd() * 9e8), receivedAt: new Date(raisedAt.getTime() + rnd() * 14 * DAY), enteredById: U.accounts.id } });
      }
      // payouts
      if (viaCp) {
        const cp = cps[i % 3];
        await db.payout.create({ data: { bookingId: b.id, type: "CP_COMMISSION", payeeName: `${cp.name} (${cp.firm})`, channelPartnerId: cp.id, ratePct: cp.commissionPct, amount: Math.round((agreementValue * cp.commissionPct) / 100), status: pick(["PENDING", "APPROVED", "PAID"]), createdAt: bookedAt } });
      }
      await db.payout.create({ data: { bookingId: b.id, type: "SALES_INCENTIVE", payeeName: owner.name, userId: owner.id, ratePct: 0.25, amount: Math.round(agreementValue * 0.0025), status: pick(["PENDING", "APPROVED", "PAID"]), createdAt: bookedAt } });
    }
  }
  // one unit blocked right now
  const blockUnit = P.VA.units.find((u) => u.status === "AVAILABLE" && u.floor === 12 && u.type === "3BHK");
  const negotiation = leads.find((l) => l.code === "VA" && l.lead.stage === "NEGOTIATION");
  if (blockUnit && negotiation) {
    await db.unit.update({ where: { id: blockUnit.id }, data: { status: "BLOCKED", blockedById: negotiation.lead.ownerId, blockedLeadId: negotiation.lead.id, blockedUntil: new Date(now + 30 * 3600000) } });
    await db.lead.update({ where: { id: negotiation.lead.id }, data: { stage: "UNIT_BLOCKED" } });
  }

  // ── Procurement ──
  let mrN = { VA: 0, VL: 0 }, poN = { VA: 0, VL: 0 }, grN = { VA: 0, VL: 0 };
  async function order(code, cc, item, qty, unit, rate, gst, status, opts = {}) {
    const p = P[code];
    const mr = await db.materialRequest.create({ data: { number: `MR-${code}-${String(++mrN[code]).padStart(4, "0")}`, projectId: p.proj.id, costCodeId: CC[cc].id, item, qty, unit, neededBy: daysFromNow(10), status: "ORDERED", requestedById: U.site.id, createdAt: daysAgo(opts.age ?? 40) } });
    const v = vendor(CC[cc].name);
    for (const [k, vv] of [[0, v], [1, Object.values(V)[(Object.values(V).indexOf(v) + 1) % Object.keys(V).length]], [2, Object.values(V)[(Object.values(V).indexOf(v) + 2) % Object.keys(V).length]]])
      await db.quote.create({ data: { requestId: mr.id, vendorId: vv.id, rate: rate * (1 + k * 0.035), gstPct: gst, deliveryDays: 5 + k * 3, selected: k === 0 } });
    const amount = Math.round(qty * rate * (1 + gst / 100));
    const po = await db.purchaseOrder.create({ data: { number: `PO-${code}-${String(++poN[code]).padStart(4, "0")}`, requestId: mr.id, projectId: p.proj.id, costCodeId: CC[cc].id, vendorId: v.id, item, qty, unit, rate, gstPct: gst, amount, status, createdById: U.purchase.id, createdAt: daysAgo((opts.age ?? 40) - 2) } });
    if (opts.received) {
      const g = await db.goodsReceipt.create({ data: { number: `GRN-${code}-${String(++grN[code]).padStart(4, "0")}`, poId: po.id, qty: qty * opts.received, challanNo: "DC" + Math.floor(1000 + rnd() * 9000), receivedById: U.stores.id, receivedAt: daysAgo((opts.age ?? 40) - 8) } });
      await db.stockMove.create({ data: { projectId: p.proj.id, item, unit, qty: g.qty, type: "RECEIPT", reference: g.number, userId: U.stores.id, at: g.receivedAt } });
      if (opts.issued) await db.stockMove.create({ data: { projectId: p.proj.id, item, unit, qty: -g.qty * opts.issued, type: "ISSUE", reference: "Issued to site", userId: U.stores.id, at: daysAgo(5) } });
    }
    if (opts.bill) {
      const [bqty, brate, bstatus] = opts.bill;
      const mismatch = Math.abs(brate - rate) / rate * 100 > 2 || bqty > qty * (opts.received ?? 0);
      await db.vendorBill.create({ data: { poId: po.id, vendorId: v.id, billNo: "INV/" + Math.floor(100 + rnd() * 900), billDate: daysAgo((opts.age ?? 40) - 12), qty: bqty, rate: brate, amount: Math.round(bqty * brate * (1 + gst / 100)), match: mismatch ? "MISMATCH" : "MATCHED", matchNote: mismatch ? "Billed rate is more than 2% above the PO rate" : null, status: mismatch ? "ON_HOLD" : bstatus, enteredById: U.accounts.id, paidAt: bstatus === "PAID" ? daysAgo(5) : null } });
    }
    return po;
  }
  // Big historical commitments so budgets look real
  // Steel is deliberately close to its ₹14 Cr budget, so a new ₹38 lakh order hits the budget gate.
  await order("VA", "04", "TMT steel Fe550D, 8–32 mm", 1050, "MT", 62000, 18, "RECEIVED", { age: 150, received: 1, issued: 0.82, bill: [1050, 62000, "PAID"] });
  await order("VA", "04", "TMT steel Fe550D, 8–32 mm", 820, "MT", 63500, 18, "RECEIVED", { age: 60, received: 1, issued: 0.6, bill: [820, 63500, "PAYABLE"] });
  await order("VA", "05", "Ready-mix concrete M30", 18000, "cum", 5600, 18, "PARTLY_RECEIVED", { age: 90, received: 0.7, issued: 0.95, bill: [12600, 5600, "PAID"] });
  await order("VA", "05", "OPC 53 grade cement", 42000, "bags", 380, 28, "RECEIVED", { age: 45, received: 1, issued: 0.7, bill: [42000, 392, "ENTERED"] });
  await order("VA", "07", "FR copper wiring and conduits, Tower A", 1, "lot", 4800000, 18, "APPROVED", { age: 12 });
  // Vida Luxora: only pre-approval design spend, no construction before RERA.
  await order("VL", "02", "Architecture and structural design consultancy, stage 1", 1, "lot", 18000000, 18, "RECEIVED", { age: 50, received: 1, bill: [1, 18000000, "PAID"] });
  await order("VL", "01", "Approval drawings, HMDA and fire NOC liaison", 1, "lot", 6500000, 18, "APPROVED", { age: 12 });

  // Pending approvals (as if raised by the purchase officer)
  async function pendingPo(code, cc, item, qty, unit, rate, level) {
    const po = await order(code, cc, item, qty, unit, rate, 18, "PENDING_APPROVAL", { age: 2 });
    const levels = await db.approvalRule.findMany({ where: { action: "PURCHASE_ORDER" }, orderBy: { level: "asc" } });
    let req = 0; for (const r of levels) { req = r.level; if (r.upToAmount == null || po.amount <= r.upToAmount) break; }
    const ar = await db.approvalRequest.create({ data: { action: "PURCHASE_ORDER", entityType: "PurchaseOrder", entityId: po.id, title: `${po.number} · ${po.item}`, amount: po.amount, projectId: po.projectId, requiredLevel: req, currentLevel: level, requestedById: U.purchase.id, createdAt: daysAgo(1) } });
    if (level > 1) await db.approvalStep.create({ data: { requestId: ar.id, level: 1, role: "PROJECT_MANAGER", decision: "APPROVED", decidedById: U["pm.aurum"].id, comment: "Needed for slab 11 pour" } });
    if (level > 2) await db.approvalStep.create({ data: { requestId: ar.id, level: 2, role: "GM_PROJECTS", decision: "APPROVED", decidedById: U.gm.id } });
  }
  await pendingPo("VA", "06", "AAC blocks 600×200×200", 18000, "nos", 62, 1);
  await pendingPo("VA", "08", "CPVC pipes and fittings, Tower A", 1, "lot", 640000, 2);
  await pendingPo("VA", "10", "Passenger lifts, 13 passenger, advance", 1, "lot", 3200000, 3);

  // Material requests waiting
  for (const [code, cc, item, qty, unit] of [["VA", "04", "TMT steel Fe550D, 12 mm", 60, "MT"], ["VA", "09", "Vitrified tiles 800×800, sample flat", 900, "sqft"], ["VL", "02", "Soil investigation and topographic survey", 1, "lot"]])
    await db.materialRequest.create({ data: { number: `MR-${code}-${String(++mrN[code]).padStart(4, "0")}`, projectId: P[code].proj.id, costCodeId: CC[cc].id, item, qty, unit, neededBy: daysFromNow(7), status: "SUBMITTED", requestedById: U.site.id, createdAt: daysAgo(1) } });

  // Daily progress reports
  const aurumA = await db.milestone.findFirst({ where: { projectId: P.VA.proj.id, status: "IN_PROGRESS", tower: { name: "Tower A" } } });
  for (let d = 6; d >= 1; d--)
    await db.dailyReport.create({ data: { projectId: P.VA.proj.id, milestoneId: aurumA.id, date: daysAgo(d), engineerId: U.site.id, workDone: pick(["Slab 9 shuttering and reinforcement, grid C–F", "Column casting level 10, grid A–D", "Slab 9 concrete pour, 210 cum", "De-shuttering slab 8, block work level 6", "Reinforcement checks with consultant, slab 10"]), labourCount: 120 + Math.floor(rnd() * 60), materialsUsed: "Steel 18 MT, RMC 140 cum", issues: d === 3 ? "RMC supply delayed by 4 hours" : null, progressPct: 58 + (6 - d) * 2, photos: "[]" } });

  // ── Procurement engine: more vendors (3+ per category), materials with lead times, quantities per milestone ──
  const more = [
    ["Bhagyanagar TMT Mart", "Steel & couplers"], ["Godavari Steels", "Steel & couplers"],
    ["Kakatiya Blocks", "AAC blocks & masonry"], ["BlockMart Hyderabad", "AAC blocks & masonry"],
    ["Cyberabad Cement Depot", "Cement"], ["Telangana Concrete Works", "Ready-mix concrete"], ["Metro RMC", "Ready-mix concrete"],
    ["TileCraft Studio", "Tiles & stone"], ["Granite Hub", "Tiles & stone"],
    ["Sanjay Pipes & Fittings", "Plumbing pipes & fittings"], ["Deccan Sanitaryware", "Plumbing pipes & fittings"],
    ["Hitech Cables & Conduits", "Electrical (cables, wires & switchgear)"], ["Charminar Electricals", "Electrical (cables, wires & switchgear)"],
    ["Vertex Lifts", "Lifts"], ["Altus Elevators", "Lifts"],
  ];
  for (const [name, category] of more) await db.vendor.create({ data: { name, category, rating: 3 + Math.floor(rnd() * 3), phone: "98" + String(Math.floor(rnd() * 1e8)).padStart(8, "0"), gstin: "36AA" + Math.floor(1e5 + rnd() * 8e5) + "Z" + Math.floor(rnd() * 9) } });
  for (const v of await db.vendor.findMany()) await db.vendor.update({ where: { id: v.id }, data: { email: `sales@${v.name.toLowerCase().replace(/[^a-z]+/g, "")}.example`, isDemo: true, notes: "Fictional demo vendor" } });

  const mats = [
    ["M-001", "TMT steel Fe550D, 8 to 32 mm", "MT", "Steel & couplers", "04", 10, 4, 63500, "IS 1786, Fe550D, with mill test certificates"],
    ["M-002", "Ready-mix concrete M30", "cum", "Ready-mix concrete", "05", 2, 3, 5600, "IS 4926, pumped"],
    ["M-003", "OPC 53 grade cement", "bags", "Cement", "05", 5, 3, 380, "50 kg bags, IS 12269"],
    ["M-004", "AAC blocks 600×200×200", "nos", "AAC blocks & masonry", "06", 14, 4, 62, "IS 2185 Part 3, density 551 to 650"],
    ["M-005", "Vitrified tiles 800×800, double charge", "sqft", "Tiles & stone", "09", 45, 5, 78, "Matt finish, first quality"],
    ["M-006", "CPVC pipes and fittings, per tower", "lot", "Plumbing pipes & fittings", "08", 21, 5, 640000, "SDR 11, with fittings"],
    ["M-007", "FR copper wiring and conduits, per tower", "lot", "Electrical (cables, wires & switchgear)", "07", 30, 5, 4800000, "FRLS, ISI marked"],
    ["M-008", "Passenger lift, 13 passenger, 20 stops", "nos", "Lifts", "10", 120, 7, 2400000, "1.5 m/s, machine-room-less"],
  ];
  const M = {};
  for (const [code, name, unit, category, cc, lead, qd, ref, specs] of mats)
    M[code] = await db.material.create({ data: { code, name, unit, category, costCodeId: CC[cc].id, leadTimeDays: lead, quoteDays: qd, refRate: ref, specs } });
  const ms = async (code, key, tower) => db.milestone.findFirst({ where: { project: { code }, key, tower: { name: tower } } });
  const need = async (code, key, tower, mat, qty, buffer = 7) => {
    const m = await ms(code, key, tower);
    if (m) await db.materialRequirement.create({ data: { projectId: m.projectId, milestoneId: m.id, materialId: M[mat].id, qty, neededDaysBeforeStart: buffer } });
  };
  await need("VA", "BRICKWORK", "Tower A", "M-004", 140000);
  await need("VA", "BRICKWORK", "Tower A", "M-003", 9000);
  await need("VA", "FINISHES", "Tower A", "M-005", 95000);
  await need("VA", "FINISHES", "Tower A", "M-006", 1);
  await need("VA", "FINISHES", "Tower A", "M-007", 1);
  await need("VA", "POSSESSION", "Tower A", "M-008", 4, 30);
  await need("VA", "BRICKWORK", "Tower B", "M-004", 140000);
  await need("VA", "FINISHES", "Tower B", "M-005", 95000);
  await need("VA", "POSSESSION", "Tower B", "M-008", 4, 30);
  for (const b of ["Block A", "Block B", "Block C"]) {
    await need("VL", "FOUNDATION", b, "M-001", 900);
    await need("VL", "FOUNDATION", b, "M-002", 9000);
  }

  // Real-world data: the high-rise materials master and the researched West Hyderabad supplier database.
  console.log("Imported research data:", await importData(db));

  await db.setting.create({ data: { key: "company", value: JSON.stringify({ name: "Vida Estates", city: "Hyderabad" }) } });
  await db.auditLog.create({ data: { action: "CREATE", entityType: "System", summary: "Demo data loaded", userName: "System" } });
  console.log("Seeded: users", Object.keys(U).length, "| units", P.VA.units.length + P.VL.units.length);
}

main().finally(() => db.$disconnect());
