import type { CompanyStatus, PauseReason, QuietHoursOnBlock } from "../constants.js";

/**
 * A single recurring window during which agents are not autonomously executed.
 * `end` may be numerically less than `start` to express a window that crosses
 * midnight (e.g. "22:00" → "08:00"). `days` empty means every day of the week.
 */
export interface QuietHoursWindow {
  /** ISO weekdays 0–6 (Sun–Sat). Empty array = every day. */
  days: number[];
  /** Local wall-clock start "HH:MM" (24h), inclusive. */
  start: string;
  /** Local wall-clock end "HH:MM" (24h), exclusive. */
  end: string;
}

/** Per-company quiet-hours configuration. `null` on a company means disabled. */
export interface QuietHoursConfig {
  enabled: boolean;
  /** IANA timezone the windows are interpreted in, e.g. "America/Sao_Paulo". */
  timezone: string;
  windows: QuietHoursWindow[];
  /**
   * What the scheduler does when an execution is blocked by a window:
   * - `defer`: reschedule to the moment the window closes (nothing is lost).
   * - `skip`: do not run now; resume on the next natural tick (a discrete
   *   scheduled occurrence that fell inside the window is lost).
   */
  onBlock: QuietHoursOnBlock;
}

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  attachmentMaxBytes: number;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  quietHours: QuietHoursConfig | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
