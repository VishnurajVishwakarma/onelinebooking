import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OneLineBooking Developer Console",
  description: "Multi-tenant Booking Infrastructure Platform Control Plane",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

