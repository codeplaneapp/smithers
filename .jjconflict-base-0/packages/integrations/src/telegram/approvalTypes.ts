import type {
  TelegramInlineKeyboard,
  TelegramInlineKeyboardButton,
} from "./TelegramClientTypes.ts";

/** One choice an approver can make via an inline button. */
export type TelegramApprovalChoice =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "select"; key: string };

/** An option offered in `mode: "select"`. */
export type TelegramApprovalOption = {
  /** Stable key, echoed back as the decision's `selected`. Kept short (callback_data is 64 bytes). */
  key: string;
  /** Button label shown to the approver. */
  label: string;
};

export type TelegramApprovalMode = "approve" | "select";

/** Spec for building the approval keyboard and mapping the press to a decision. */
export type TelegramApprovalKeyboardSpec = {
  mode: TelegramApprovalMode;
  /** Per-approval token that namespaces its buttons (see `approvalToken`). */
  token?: string;
  /** Options for `mode: "select"` (required, non-empty). */
  options?: TelegramApprovalOption[];
  /** Approve-button label. @default "✅ Approve" */
  approveText?: string;
  /** Reject-button label. @default "🚫 Reject" */
  rejectText?: string;
  /** When set, adds a Mini App (`web_app`) button opening this HTTPS url. */
  miniAppUrl?: string;
  /** Mini App button label. @default "🔍 Open review" */
  miniAppText?: string;
};

/** Decision shape for `mode: "approve"` (matches the core `approvalDecisionSchema`). */
export type TelegramApprovalDecision = {
  approved: boolean;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
};

/** Decision shape for `mode: "select"` (matches the core `approvalSelectionSchema`). */
export type TelegramApprovalSelection = {
  selected: string;
  notes: string | null;
};

export type { TelegramInlineKeyboard, TelegramInlineKeyboardButton };
