import { BookingError } from "./errors.js";
import type { Actor, AllocationStatus, BookingStatus, CancellationPolicy, HoldState } from "./model.js";

const TERMINAL_HOLD_STATES: ReadonlySet<HoldState> = new Set(["converted", "released", "expired"]);
const TERMINAL_BOOKING_STATUSES: ReadonlySet<BookingStatus> = new Set(["cancelled", "completed", "no_show"]);

export function isHoldExpiredAt(state: HoldState, expiresAt: Date, decisionTime: Date): boolean {
  return state === "expired" || (state === "active" && expiresAt.getTime() <= decisionTime.getTime());
}

export function effectiveHoldState(state: HoldState, expiresAt: Date, decisionTime: Date): HoldState {
  if (state === "active" && expiresAt.getTime() <= decisionTime.getTime()) {
    return "expired";
  }
  return state;
}

export function isTerminalHoldState(state: HoldState): boolean {
  return TERMINAL_HOLD_STATES.has(state);
}

export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return TERMINAL_BOOKING_STATUSES.has(status);
}

export function assertHoldTransition(from: HoldState, to: HoldState): void {
  if (from === to && isTerminalHoldState(from)) return;
  if (from !== "active") {
    if (from === "expired" && to === "converted") {
      throw new BookingError("HOLD_EXPIRED", "Hold has expired and cannot be converted", {
        details: { reconciliationHint: "PAYMENT_RECONCILIATION_REQUIRED" },
      });
    }
    throw new BookingError("INVALID_STATE_TRANSITION", `Cannot transition hold from ${from} to ${to}`);
  }
  if (to === "active") {
    throw new BookingError("INVALID_STATE_TRANSITION", "Hold is already active");
  }
}

export function assertBookingTransition(
  from: BookingStatus,
  to: BookingStatus,
  ctx: {
    startsAt: Date;
    endsAt: Date;
    decisionTime: Date;
    cancellationPolicy: CancellationPolicy;
    actor: Actor;
    overrideReason?: string | undefined;
  },
): { idempotentReplay: boolean } {
  if (from === to) {
    if (isTerminalBookingStatus(from)) {
      return { idempotentReplay: true };
    }
    throw new BookingError("INVALID_STATE_TRANSITION", `Booking is already ${from}`);
  }
  if (from !== "confirmed") {
    throw new BookingError("INVALID_STATE_TRANSITION", `Cannot transition booking from ${from} to ${to}`);
  }

  const nowMs = ctx.decisionTime.getTime();
  const startMs = ctx.startsAt.getTime();
  const endMs = ctx.endsAt.getTime();

  if (to === "cancelled") {
    if (nowMs >= startMs) {
      throw new BookingError("POLICY_VIOLATION", "Bookings cannot be cancelled after service start");
    }
    const isAdminOverride = ctx.actor.capabilities.includes("booking:override_cancellation");
    const noticeMs = ctx.cancellationPolicy.minNoticeMinutes * 60_000;
    const noticeSatisfied = startMs - nowMs >= noticeMs;

    if (!ctx.cancellationPolicy.customerCancellationAllowed && !isAdminOverride) {
      throw new BookingError("POLICY_VIOLATION", "Customer cancellation is not permitted for this booking");
    }
    if (!noticeSatisfied) {
      if (isAdminOverride && ctx.cancellationPolicy.adminOverrideAllowed) {
        if (!ctx.overrideReason?.trim()) {
          throw new BookingError("INVALID_INPUT", "An override reason is required when bypassing cancellation notice");
        }
      } else {
        throw new BookingError("MINIMUM_NOTICE_REQUIRED", "Cancellation notice period has elapsed");
      }
    }
    return { idempotentReplay: false };
  }

  if (to === "completed") {
    if (nowMs < endMs) {
      throw new BookingError("INVALID_STATE_TRANSITION", "Booking cannot be marked completed before service end");
    }
    return { idempotentReplay: false };
  }

  if (to === "no_show") {
    if (nowMs < startMs) {
      throw new BookingError("INVALID_STATE_TRANSITION", "Booking cannot be marked no-show before service start");
    }
    return { idempotentReplay: false };
  }

  throw new BookingError("INVALID_STATE_TRANSITION", `Unsupported booking transition to ${to}`);
}

export function assertAllocationTransition(from: AllocationStatus, to: AllocationStatus): void {
  const allowed: Record<AllocationStatus, readonly AllocationStatus[]> = {
    held: ["reserved", "released"],
    reserved: ["released"],
    released: [],
  };
  if (!allowed[from].includes(to)) {
    throw new BookingError("INVALID_STATE_TRANSITION", `Cannot transition allocation from ${from} to ${to}`);
  }
}

