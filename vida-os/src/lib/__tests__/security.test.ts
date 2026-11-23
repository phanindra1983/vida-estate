import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptTargetError, bookingAccessError, rfqAccessError, seesProject } from "../access";
import { rateLimit, _resetRateLimits, isEmail, cap, safeEqual, publicError } from "../security";

const exec = { role: "SALES_EXEC", projectIds: ["P1"] };
const md = { role: "MD", projectIds: "ALL" as const };
const booking = (projectId: string) => ({ id: "B1", unit: { projectId } });

test("project visibility", () => {
  assert.equal(seesProject(md, "ANY"), true);
  assert.equal(seesProject(exec, "P1"), true);
  assert.equal(seesProject(exec, "P2"), false);
  assert.equal(seesProject(exec, null), false);
});

test("IDOR: receipt only on a visible booking, with its own demand", () => {
  assert.equal(receiptTargetError(exec, booking("P1"), null, null), null);
  assert.equal(receiptTargetError(exec, booking("P2"), null, null), "Booking not found");
  assert.equal(receiptTargetError(exec, null, null, null), "Booking not found");
  assert.equal(receiptTargetError(exec, booking("P1"), { bookingId: "B1" }, "D1"), null);
  assert.equal(receiptTargetError(exec, booking("P1"), { bookingId: "OTHER" }, "D1"), "That demand does not belong to this booking");
  assert.equal(receiptTargetError(exec, booking("P1"), null, "MISSING"), "That demand does not belong to this booking");
  assert.equal(receiptTargetError(md, booking("P9"), { bookingId: "B1" }, "D1"), null);
});

test("IDOR: booking status only on a visible booking", () => {
  assert.equal(bookingAccessError(exec, booking("P1")), null);
  assert.equal(bookingAccessError(exec, booking("P2")), "Booking not found");
  assert.equal(bookingAccessError(exec, null), "Booking not found");
});

test("IDOR: enquiry actions only on a visible project", () => {
  assert.equal(rfqAccessError(exec, { projectId: "P1" }), null);
  assert.equal(rfqAccessError(exec, { projectId: "P2" }), "Enquiry not found");
  assert.equal(rfqAccessError(md, { projectId: "P2" }), null);
  assert.equal(rfqAccessError(exec, null), "Enquiry not found");
});

test("rate limit allows N hits per window, then blocks, then resets", () => {
  _resetRateLimits();
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rateLimit("k", 3, 1000, t), true);
  assert.equal(rateLimit("k", 3, 1000, t), false);
  assert.equal(rateLimit("k", 3, 1000, t + 1001), true);
});

test("input helpers", () => {
  assert.equal(isEmail("ravi@example.com"), true);
  assert.equal(isEmail("not-an-email"), false);
  assert.equal(isEmail("a@b.c<script>"), false);
  assert.equal(cap("x".repeat(500), 80).length, 80);
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual(null, "abc"), false);
  assert.equal(publicError(new Error("Enter a valid 10-digit mobile number")), "Enter a valid 10-digit mobile number");
  assert.equal(publicError(new Error("PrismaClientKnownRequestError: unique constraint")), "Could not save this record");
});
