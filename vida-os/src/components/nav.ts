import { SALES_ROLES, COLLECTION_ROLES, PROJECT_ROLES, COST_ROLES, PROCUREMENT_ROLES, FINANCE_ROLES, ADMIN_ROLES } from "@/lib/constants";

export type NavItem = { href: string; label: string; roles?: string[] };
export type NavGroup = { label: string; items: NavItem[] };

const ALL = undefined;
const MIS = ["MD", "FINANCE_HEAD", "SALES_HEAD", "GM_PROJECTS"];

export const NAV: NavGroup[] = [
  { label: "Overview", items: [
    { href: "/", label: "Dashboard", roles: ALL },
    { href: "/approvals", label: "Approvals", roles: ALL },
    { href: "/telegram", label: "My Telegram", roles: ALL },
  ] },
  { label: "Sales", items: [
    { href: "/sales/leads", label: "Leads", roles: SALES_ROLES },
    { href: "/sales/pipeline", label: "Pipeline", roles: SALES_ROLES },
    { href: "/sales/calls", label: "AI call centre", roles: SALES_ROLES },
    { href: "/sales/accounts", label: "Corporate accounts", roles: SALES_ROLES },
    { href: "/sales/inventory", label: "Inventory", roles: [...SALES_ROLES, "FINANCE_HEAD"] },
    { href: "/sales/bookings", label: "Bookings", roles: [...COLLECTION_ROLES, "SALES_EXEC"] },
    { href: "/sales/collections", label: "Collections", roles: COLLECTION_ROLES },
    { href: "/sales/payouts", label: "Payouts", roles: ["MD", "SALES_HEAD", "FINANCE_HEAD", "ACCOUNTS"] },
  ] },
  { label: "Projects", items: [
    { href: "/projects/schedule", label: "Schedule", roles: PROJECT_ROLES },
    { href: "/projects/reports", label: "Daily reports", roles: PROJECT_ROLES },
    { href: "/projects/attendance", label: "Site attendance", roles: [...PROJECT_ROLES, "STOREKEEPER"] },
    { href: "/projects/issues", label: "Snags & safety", roles: [...PROJECT_ROLES, "STOREKEEPER"] },
  ] },
  { label: "Cost", items: [
    { href: "/cost/budgets", label: "Budgets", roles: COST_ROLES },
    { href: "/cost/requests", label: "Material requests", roles: PROCUREMENT_ROLES },
    { href: "/cost/orders", label: "Purchase orders", roles: PROCUREMENT_ROLES },
    { href: "/cost/receipts", label: "Goods received", roles: PROCUREMENT_ROLES },
    { href: "/cost/stock", label: "Site stock", roles: PROCUREMENT_ROLES },
    { href: "/cost/bills", label: "Vendor bills", roles: FINANCE_ROLES },
  ] },
  { label: "Procurement engine", items: [
    { href: "/procurement", label: "Buying plan", roles: PROCUREMENT_ROLES },
    { href: "/procurement/enquiries", label: "Enquiries & comparisons", roles: PROCUREMENT_ROLES },
    { href: "/procurement/setup", label: "Materials & quantities", roles: ["MD", "GM_PROJECTS", "PROJECT_MANAGER", "PURCHASE"] },
    { href: "/procurement/outbox", label: "Messages sent", roles: ["MD", "GM_PROJECTS", "PURCHASE"] },
  ] },
  { label: "Reports", items: [
    { href: "/reports/board-pack", label: "Board pack", roles: MIS },
    { href: "/reports/accounting", label: "Accounting export", roles: FINANCE_ROLES },
  ] },
  { label: "Control", items: [
    { href: "/control/audit", label: "Audit trail", roles: ["MD", "FINANCE_HEAD"] },
    { href: "/control/authority", label: "Approval limits", roles: ADMIN_ROLES },
    { href: "/control/users", label: "Users & access", roles: ADMIN_ROLES },
    { href: "/control/telegram", label: "Telegram bot", roles: ADMIN_ROLES },
    { href: "/control/leads", label: "Lead sources", roles: ["MD", "SALES_HEAD", "MARKETING"] },
    { href: "/control/masters", label: "Masters", roles: ["MD", "FINANCE_HEAD", "GM_PROJECTS", "PURCHASE", "SALES_HEAD", "HR"] },
  ] },
];

export function navFor(role: string): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.roles || i.roles.includes(role)) })).filter((g) => g.items.length);
}
