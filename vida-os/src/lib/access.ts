/**
 * Record-level access rules (pure, so they can be unit tested).
 * A role check alone is not enough: the record must belong to a project the person can see,
 * and linked records must belong together (e.g. a demand to the booking it is paid against).
 */
export type Who = { role: string; projectIds: string[] | "ALL" };

export const seesProject = (u: Who, projectId: string | null | undefined) =>
  u.projectIds === "ALL" || (!!projectId && u.projectIds.includes(projectId));

/** Receipt: the booking must be in the person's projects, and the demand (if any) must be this booking's. */
export function receiptTargetError(u: Who, booking: { id: string; unit: { projectId: string } } | null, demand: { bookingId: string } | null, demandId: string | null) {
  if (!booking) return "Booking not found";
  if (!seesProject(u, booking.unit.projectId)) return "Booking not found";
  if (demandId && (!demand || demand.bookingId !== booking.id)) return "That demand does not belong to this booking";
  return null;
}

/** Booking status change: the booking must be in the person's projects. */
export function bookingAccessError(u: Who, booking: { unit: { projectId: string } } | null) {
  if (!booking || !seesProject(u, booking.unit.projectId)) return "Booking not found";
  return null;
}

/** Enquiry (RFQ) actions: the enquiry must be for one of the person's projects. */
export function rfqAccessError(u: Who, rfq: { projectId: string } | null) {
  if (!rfq || !seesProject(u, rfq.projectId)) return "Enquiry not found";
  return null;
}
