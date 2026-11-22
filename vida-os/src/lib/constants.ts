export const ROLES = {
  MD: "MD",
  FINANCE_HEAD: "FINANCE_HEAD",
  ACCOUNTS: "ACCOUNTS",
  SALES_HEAD: "SALES_HEAD",
  SALES_MANAGER: "SALES_MANAGER",
  SALES_EXEC: "SALES_EXEC",
  GM_PROJECTS: "GM_PROJECTS",
  PROJECT_MANAGER: "PROJECT_MANAGER",
  SITE_ENGINEER: "SITE_ENGINEER",
  PURCHASE: "PURCHASE",
  STOREKEEPER: "STOREKEEPER",
  HR: "HR",
  MARKETING: "MARKETING",
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_LABEL: Record<string, string> = {
  MD: "Managing Director",
  FINANCE_HEAD: "Finance Head",
  ACCOUNTS: "Accounts",
  SALES_HEAD: "Sales Head",
  SALES_MANAGER: "Sales Manager",
  SALES_EXEC: "Sales Executive",
  GM_PROJECTS: "GM Projects",
  PROJECT_MANAGER: "Project Manager",
  SITE_ENGINEER: "Site Engineer",
  PURCHASE: "Purchase Officer",
  STOREKEEPER: "Storekeeper",
  HR: "HR",
  MARKETING: "Marketing",
};

/** Roles that see every project without explicit access rows. */
export const ALL_PROJECT_ROLES: string[] = ["MD", "FINANCE_HEAD", "ACCOUNTS", "SALES_HEAD", "GM_PROJECTS", "HR", "MARKETING"];

export const SALES_ROLES = ["MD", "SALES_HEAD", "SALES_MANAGER", "SALES_EXEC", "MARKETING"];
export const SALES_MANAGERS = ["MD", "SALES_HEAD", "SALES_MANAGER"];
export const COLLECTION_ROLES = ["MD", "SALES_HEAD", "SALES_MANAGER", "FINANCE_HEAD", "ACCOUNTS"];
export const PROJECT_ROLES = ["MD", "GM_PROJECTS", "PROJECT_MANAGER", "SITE_ENGINEER"];
export const COST_ROLES = ["MD", "GM_PROJECTS", "PROJECT_MANAGER", "PURCHASE", "FINANCE_HEAD", "ACCOUNTS"];
export const PROCUREMENT_ROLES = ["MD", "GM_PROJECTS", "PROJECT_MANAGER", "SITE_ENGINEER", "PURCHASE", "STOREKEEPER", "FINANCE_HEAD"];
export const FINANCE_ROLES = ["MD", "FINANCE_HEAD", "ACCOUNTS"];
export const ADMIN_ROLES = ["MD"];

export const LEAD_SOURCES: Record<string, string> = {
  WEBSITE: "Website",
  META: "Meta ads",
  "99ACRES": "99acres",
  MAGICBRICKS: "MagicBricks",
  HOUSING: "Housing.com",
  GOOGLE: "Google ads",
  NOBROKER: "NoBroker",
  SQUAREYARDS: "Square Yards",
  OTHER_PORTAL: "Other portal",
  WHATSAPP: "WhatsApp",
  REFERRAL: "Referral",
  WALK_IN: "Walk-in",
  CHANNEL_PARTNER: "Channel partner",
  TELEGRAM: "Added on Telegram",
  STAFF: "Added by staff",
};

export const LEAD_STAGES: { key: string; label: string }[] = [
  { key: "NEW", label: "New" },
  { key: "CONTACTED", label: "Contacted" },
  { key: "QUALIFIED", label: "Qualified" },
  { key: "VISIT_SCHEDULED", label: "Site visit scheduled" },
  { key: "VISIT_DONE", label: "Site visit done" },
  { key: "NEGOTIATION", label: "Negotiation" },
  { key: "UNIT_BLOCKED", label: "Unit blocked" },
  { key: "BOOKED", label: "Booked" },
  { key: "AGREEMENT_SIGNED", label: "Agreement signed" },
  { key: "LOST", label: "Lost" },
];

export const PURPOSES: Record<string, string> = { LIVE: "To live in", INVEST: "Investment" };
export const TIMELINES: Record<string, string> = { NOW: "Ready now", "3M": "Within 3 months", "6M": "Within 6 months", "12M": "Within a year", LATER: "Later / exploring" };
export const HOME_TYPES = ["2BHK", "3BHK", "4BHK"];

export const APPROVAL_ACTIONS: Record<string, string> = {
  PURCHASE_ORDER: "Purchase order",
  BUDGET_REVISION: "Budget revision",
  VENDOR_PAYMENT: "Vendor payment",
  PAYOUT: "Payout",
  DISCOUNT: "Unit discount",
  MILESTONE: "Milestone completion",
  RFQ_AWARD: "Vendor award",
};

/** Business-hour window for the 15-minute first-call escalation. */
export const ESCALATION = { minutes: 15, startHour: 9, endHour: 20 };
export const BLOCK_HOURS = 48;
export const SALES_INCENTIVE_PCT = 0.25;
export const MATCH_TOLERANCE_PCT = 2;
