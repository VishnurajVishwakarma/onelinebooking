import React from "react";
import { createRoot } from "react-dom/client";
import { BookingWidget } from "./BookingWidget";

const rootEl = document.getElementById("root")!;
const { proxyBaseUrl, facilityId, dateIso, customerId } = (
  window as unknown as {
    __OLB_WIDGET_CFG__: { proxyBaseUrl: string; facilityId: string; dateIso: string; customerId: string };
  }
).__OLB_WIDGET_CFG__;

createRoot(rootEl).render(
  <BookingWidget
    proxyBaseUrl={proxyBaseUrl}
    facilityId={facilityId}
    dateIso={dateIso}
    customerId={customerId}
  />,
);
