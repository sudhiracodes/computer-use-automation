/**
 * Seed data for MERIDIAN Core.
 *
 * ALL OF THIS IS SYNTHETIC. Names are invented, member numbers are sequential from
 * an arbitrary base, and no field corresponds to a real person or account. The
 * brief forbids real credentials and real PII; a mock target is the only way to
 * exercise a member-servicing flow without either.
 */

export interface Member {
  memberId: string;
  fullName: string;
  /** Membership open date — deliberately not a date of birth. */
  memberSince: string;
  branch: string;
  status: "Active" | "Dormant";
  accounts: Account[];
}

export interface Account {
  accountNumber: string;
  kind: "Savings" | "Checking" | "Certificate";
  /** Cents, to keep currency formatting out of the data. */
  balanceCents: number;
}

export const MEMBERS: readonly Member[] = [
  {
    memberId: "100234",
    fullName: "Dana Whitfield",
    memberSince: "2016-03-14",
    branch: "Riverbend",
    status: "Active",
    accounts: [
      { accountNumber: "SV-100234-01", kind: "Savings", balanceCents: 128436 },
      { accountNumber: "CK-100234-01", kind: "Checking", balanceCents: 23109 },
    ],
  },
  {
    memberId: "100235",
    fullName: "Marcus Oyelaran",
    memberSince: "2019-11-02",
    branch: "Northgate",
    status: "Active",
    accounts: [{ accountNumber: "SV-100235-01", kind: "Savings", balanceCents: 1540288 }],
  },
  {
    memberId: "100236",
    fullName: "Priya Raghunathan",
    memberSince: "2012-06-30",
    branch: "Riverbend",
    status: "Active",
    accounts: [
      { accountNumber: "SV-100236-01", kind: "Savings", balanceCents: 74210 },
      { accountNumber: "CD-100236-01", kind: "Certificate", balanceCents: 2500000 },
    ],
  },
  {
    memberId: "100237",
    fullName: "Eleanor Vance",
    memberSince: "2021-01-19",
    branch: "Southfield",
    status: "Dormant",
    accounts: [{ accountNumber: "SV-100237-01", kind: "Savings", balanceCents: 0 }],
  },
  {
    memberId: "100238",
    fullName: "Tobias Grant",
    memberSince: "2018-08-08",
    branch: "Northgate",
    status: "Active",
    accounts: [
      { accountNumber: "SV-100238-01", kind: "Savings", balanceCents: 391547 },
      { accountNumber: "CK-100238-01", kind: "Checking", balanceCents: 100200 },
    ],
  },
  {
    memberId: "100239",
    fullName: "Anneke de Vries",
    memberSince: "2023-05-21",
    branch: "Riverbend",
    status: "Active",
    accounts: [{ accountNumber: "SV-100239-01", kind: "Savings", balanceCents: 8825 }],
  },
];

export function findMember(memberId: string): Member | undefined {
  return MEMBERS.find((m) => m.memberId === memberId.trim());
}

/**
 * A member id that is well-formed but absent from the data.
 *
 * The MEMBER_NOT_FOUND business outcome is reachable *naturally* by searching for
 * this, without arming a fault. That matters: the outcome a caller most needs to
 * handle correctly should be provable on the ordinary code path, not only under a
 * test hook a sceptical reviewer could dismiss as staged.
 */
export const ABSENT_MEMBER_ID = "999999";

export function formatCurrency(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const remainder = Math.abs(cents) % 100;
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

/** Sequence for newly opened sub-accounts, so the confirmation screen has a real value. */
let subAccountSequence = 40;

export function nextSubAccountNumber(memberId: string): string {
  subAccountSequence += 1;
  return `SV-${memberId}-${String(subAccountSequence).padStart(2, "0")}`;
}

export const SUB_ACCOUNT_TYPES = [
  "Regular Savings",
  "Holiday Club",
  "Vacation Club",
  "Youth Savings",
] as const;

export const SUB_ACCOUNT_PURPOSES = ["Personal", "Household", "Education", "Other"] as const;
