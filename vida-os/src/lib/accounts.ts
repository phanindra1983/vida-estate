/** Corporate accounts pushed from the micromarket dashboard. */
export const ACCOUNTS_SOURCE = "CORPORATE_ACCOUNTS"; // key name in the Setting table (leads.key.CORPORATE_ACCOUNTS)
export const ACCOUNT_STATUSES = [
  { key: "NEW", label: "New" },
  { key: "CONTACTED", label: "Contacted" },
  { key: "YES", label: "Qualified" },
  { key: "NO", label: "Not a fit" },
] as const;
