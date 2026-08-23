import type { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "../middleware/errorHandler.js";
import {
  isProtectedAccount,
  setUsersActive,
  type SetActiveResult,
} from "./userAdminService.js";

/**
 * Year-end cohort promotion.
 *
 * Roll numbers encode the intake in their leading digits — 2420090001 is
 * intake 24 — so "the students who joined in 2024" is expressible as a
 * roll-number prefix and nothing else in the schema records it. Promotion at
 * year end therefore means: resolve a prefix to a set of accounts, and soft
 * deactivate them.
 *
 * TWO THINGS MAKE THIS SAFE TO POINT AT 150 REAL ACCOUNTS.
 *
 * 1. It is a deactivation, never a delete. Every order those students placed
 *    stays attributed to them; the canteen's books do not develop holes when a
 *    batch graduates. (Order.studentId is onDelete: Restrict, so a delete
 *    would fail anyway — but the point is that it should never be attempted.)
 *
 * 2. Dry run is the default and the real run has to agree with it. A caller
 *    must first preview, then re-send the same prefix with `dryRun: false`,
 *    `confirm` equal to the prefix, and `expectedCount` equal to the number
 *    the preview reported. If anyone created or deactivated a matching account
 *    in between, the counts disagree and the write is refused rather than
 *    silently sweeping up more accounts than the admin was shown.
 */

/** Leading digits of a roll number that identify the intake year. */
export const INTAKE_PREFIX_LENGTH = 2;
/** Shortest selectable prefix. One character would match most of the table. */
export const MIN_COHORT_PREFIX_LENGTH = 2;
/** Ceiling on a single promotion, well above a real intake. */
export const MAX_COHORT_SIZE = 1000;
/** Rows echoed back in a preview so an admin can eyeball the selection. */
export const COHORT_PREVIEW_SAMPLE_SIZE = 25;

const PREFIX_PATTERN = /^[A-Za-z0-9]+$/;

export function assertValidPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length < MIN_COHORT_PREFIX_LENGTH || !PREFIX_PATTERN.test(trimmed)) {
    throw new ApiError(
      400,
      "INVALID_COHORT_PREFIX",
      `Cohort prefix must be at least ${MIN_COHORT_PREFIX_LENGTH} alphanumeric characters`,
    );
  }
  return trimmed;
}

export function intakeFromRollNumber(rollNumber: string): string {
  return rollNumber.slice(0, INTAKE_PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface CohortSummary {
  intake: string;
  total: number;
  active: number;
  inactive: number;
  rollNumberMin: string;
  rollNumberMax: string;
}

/**
 * The intakes present in the roster, so an admin can pick one instead of
 * guessing a prefix. Grouped in SQL rather than by pulling every roll number
 * back and reducing in the Worker — this stays O(1) memory as the roster grows
 * across intakes.
 */
export async function listCohorts(prisma: PrismaClient): Promise<CohortSummary[]> {
  const rows = await prisma.$queryRaw<
    { intake: string; total: number; active: number; rollNumberMin: string; rollNumberMax: string }[]
  >`
    SELECT left("rollNumber", ${INTAKE_PREFIX_LENGTH}) AS "intake",
           COUNT(*)::int                               AS "total",
           COUNT(*) FILTER (WHERE "isActive")::int     AS "active",
           MIN("rollNumber")                           AS "rollNumberMin",
           MAX("rollNumber")                           AS "rollNumberMax"
    FROM "User"
    WHERE "rollNumber" IS NOT NULL AND "role" = 'STUDENT'
    GROUP BY 1
    ORDER BY 1 DESC
  `;

  return rows.map((r) => ({ ...r, inactive: r.total - r.active }));
}

// ---------------------------------------------------------------------------
// Preview + promotion
// ---------------------------------------------------------------------------

interface CohortMember {
  id: string;
  name: string;
  email: string;
  rollNumber: string | null;
  isActive: boolean;
}

export interface CohortPreview {
  prefix: string;
  dryRun: boolean;
  /** Every STUDENT whose roll number starts with `prefix`. */
  matched: number;
  /** Of those, the ones this operation would flip to inactive. */
  wouldDeactivate: number;
  /** Of those, the ones already inactive — a re-run is a no-op on them. */
  alreadyInactive: number;
  /** Held back by PROTECTED_ACCOUNT_EMAILS, listed so the exclusion is visible. */
  protectedSkipped: { rollNumber: string | null; email: string }[];
  rollNumberRange: { first: string; last: string } | null;
  sample: { id: string; name: string; rollNumber: string | null; email: string }[];
  sampleTruncated: boolean;
}

export interface CohortPromotionResult extends CohortPreview {
  applied: boolean;
  changed: number;
  tokensValidFrom: string | null;
  /**
   * Exactly who moved. A cohort promotion has no undo button; the only way
   * back is to know the ids, so they are returned and written to the audit log
   * rather than left to be re-derived from a prefix that will match different
   * accounts tomorrow.
   */
  changedUsers: { id: string; rollNumber: string | null; email: string }[];
}

function studentsWithPrefix(prefix: string): Prisma.UserWhereInput {
  return { role: "STUDENT", rollNumber: { startsWith: prefix } };
}

async function loadCohort(prisma: PrismaClient, prefix: string): Promise<CohortMember[]> {
  const members = await prisma.user.findMany({
    where: studentsWithPrefix(prefix),
    select: { id: true, name: true, email: true, rollNumber: true, isActive: true },
    orderBy: { rollNumber: "asc" },
    // One over the ceiling, so an oversized selection is detected rather than
    // silently truncated into a partial deactivation.
    take: MAX_COHORT_SIZE + 1,
  });

  if (members.length > MAX_COHORT_SIZE) {
    throw new ApiError(
      400,
      "COHORT_TOO_LARGE",
      `Prefix "${prefix}" matches more than ${MAX_COHORT_SIZE} students — use a longer prefix`,
    );
  }
  return members;
}

function summarise(prefix: string, members: CohortMember[], dryRun: boolean): CohortPreview & {
  targets: CohortMember[];
} {
  const protectedMembers = members.filter((m) => isProtectedAccount(m.email));
  const alreadyInactive = members.filter((m) => !m.isActive);
  const targets = members.filter((m) => m.isActive && !isProtectedAccount(m.email));

  const rolls = members.map((m) => m.rollNumber).filter((r): r is string => !!r);

  return {
    prefix,
    dryRun,
    matched: members.length,
    wouldDeactivate: targets.length,
    alreadyInactive: alreadyInactive.length,
    protectedSkipped: protectedMembers.map((m) => ({ rollNumber: m.rollNumber, email: m.email })),
    rollNumberRange: rolls.length ? { first: rolls[0], last: rolls[rolls.length - 1] } : null,
    sample: targets.slice(0, COHORT_PREVIEW_SAMPLE_SIZE).map((m) => ({
      id: m.id,
      name: m.name,
      rollNumber: m.rollNumber,
      email: m.email,
    })),
    sampleTruncated: targets.length > COHORT_PREVIEW_SAMPLE_SIZE,
    targets,
  };
}

/** Read-only. Reports exactly what a promotion would change, and writes nothing. */
export async function previewCohortDeactivation(
  prisma: PrismaClient,
  rawPrefix: string,
): Promise<CohortPreview> {
  const prefix = assertValidPrefix(rawPrefix);
  const { targets: _targets, ...preview } = summarise(prefix, await loadCohort(prisma, prefix), true);
  return preview;
}

export interface PromoteCohortInput {
  prefix: string;
  actorId: string;
  dryRun: boolean;
  /** Must equal the prefix on a real run. Guards against a mistyped body. */
  confirm?: string;
  /** Must equal the preview's `wouldDeactivate` on a real run. */
  expectedCount?: number;
}

export async function promoteCohort(
  prisma: PrismaClient,
  input: PromoteCohortInput,
): Promise<CohortPromotionResult> {
  const prefix = assertValidPrefix(input.prefix);
  const { targets, ...preview } = summarise(prefix, await loadCohort(prisma, prefix), input.dryRun);

  if (input.dryRun) {
    return { ...preview, applied: false, changed: 0, tokensValidFrom: null, changedUsers: [] };
  }

  if (input.confirm !== prefix) {
    throw new ApiError(
      400,
      "CONFIRMATION_REQUIRED",
      `A real cohort promotion requires "confirm" to equal the prefix ("${prefix}")`,
    );
  }
  if (input.expectedCount !== preview.wouldDeactivate) {
    throw new ApiError(
      409,
      "COHORT_CHANGED",
      `The cohort now has ${preview.wouldDeactivate} account(s) to deactivate, not the ${input.expectedCount} you confirmed. Re-run the dry run and confirm the new count.`,
    );
  }
  if (targets.length === 0) {
    return { ...preview, applied: true, changed: 0, tokensValidFrom: null, changedUsers: [] };
  }

  const result: SetActiveResult = await setUsersActive(
    prisma,
    targets.map((t) => t.id),
    false,
    input.actorId,
    { maxIds: MAX_COHORT_SIZE },
  );

  return {
    ...preview,
    applied: true,
    changed: result.changed,
    tokensValidFrom: result.tokensValidFrom,
    changedUsers: result.changedUsers.map((u) => ({
      id: u.id,
      rollNumber: u.rollNumber,
      email: u.email,
    })),
  };
}
