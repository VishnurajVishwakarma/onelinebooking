import React, { useEffect, useMemo, useState } from "react";
import {
  formatMinorCurrency,
  OneLineBookingPublicClient,
  type AvailabilitySlotDto,
  type BookingSummaryDto,
} from "@onelinebooking/sdk/browser";

export interface BookingWidgetProps {
  proxyBaseUrl: string; // e.g. "/api/booking" — never send olb_test_/olb_live_ secrets from browser!
  facilityId: string;
  dateIso: string;
  customerId: string;
}

export function BookingWidget({ proxyBaseUrl, facilityId, dateIso, customerId }: BookingWidgetProps) {
  const client = useMemo(() => new OneLineBookingPublicClient({ proxyBaseUrl }), [proxyBaseUrl]);
  const [slots, setSlots] = useState<AvailabilitySlotDto[]>([]);
  const [confirmed, setConfirmed] = useState<BookingSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.availability
      .get({ facilityId, fromDate: dateIso, toDate: dateIso })
      .then((res) => setSlots(res.slots.filter((s) => s.available)))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load availability"));
  }, [client, facilityId, dateIso]);

  async function reserveSlot(slotRef: string) {
    setError(null);
    const hold = await client.holds.create({
      facilityId,
      slotRefs: [slotRef],
      externalCustomerId: customerId,
    });
    const booking = await client.holds.convert(hold.id);
    setConfirmed(booking);
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      {confirmed && <p>Booking confirmed: {confirmed.id}</p>}
      <ul>
        {slots.map((slot) => (
          <li key={slot.slotRef}>
            <button type="button" onClick={() => void reserveSlot(slot.slotRef)}>
              Book {slot.localStart.slice(11, 16)}–{slot.localEnd.slice(11, 16)} ({slot.amountMinor != null && slot.currency ? formatMinorCurrency(slot.amountMinor, slot.currency) : "Price unavailable"})
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

