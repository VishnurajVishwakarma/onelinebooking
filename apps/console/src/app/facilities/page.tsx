"use client";

import React, { useEffect, useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Badge, Button, Card, Field } from "@/components/ui";

export default function FacilitiesPage() {
  const [facilities, setFacilities] = useState<Array<{ id: string; name: string; category: string; timeZone: string; configurationRevision: number; active: boolean }>>([]);
  const [locations, setLocations] = useState<Array<{ id: string; name: string; timeZone: string }>>([]);
  const [selectedFac, setSelectedFac] = useState("");
  const [facName, setFacName] = useState("");
  const [facCategory, setFacCategory] = useState("gaming_pc");
  const [facTz, setFacTz] = useState("UTC");
  const [locName, setLocName] = useState("");
  const [priceMinor, setPriceMinor] = useState("2000");
  const [currency, setCurrency] = useState("USD");
  const [calDate, setCalDate] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [slots, setSlots] = useState<Array<{ slotRef: string; localStart: string; localEnd: string; available: boolean; amountMinor: number | null; currency: string | null }>>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/console/facilities");
    if (res.ok) {
      const d = await res.json();
      setFacilities(d.facilities ?? []);
      setLocations(d.locations ?? []);
      if (!selectedFac && d.facilities?.[0]?.id) setSelectedFac(d.facilities[0].id);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (action: string, payload: Record<string, unknown>, facilityId?: string) => {
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/console/facilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, facilityId, payload }),
    });
    const d = await res.json();
    if (!res.ok) {
      setErr(d.error ?? "Operation failed");
      return;
    }
    setMsg(`Updated (${action})`);
    await load();
  };

  const loadCalendar = async () => {
    if (!selectedFac) return;
    const res = await fetch(`/api/console/facilities?facilityId=${encodeURIComponent(selectedFac)}&fromDate=${encodeURIComponent(calDate)}`);
    if (res.ok) {
      const d = await res.json();
      setSlots(d.availability?.slots ?? []);
    }
  };

  return (
    <ConsoleShell>
      {() => (
        <>
          <h1 style={{ marginTop: 0 }}>Facilities, Locations, Schedules &amp; Availability Calendar</h1>
          {err && <Alert tone="danger">{err}</Alert>}
          {msg && <Alert tone="ok">{msg}</Alert>}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
            <Card title="Create Business Location">
              <Field label="Location Name"><input className="input" value={locName} onChange={(e) => setLocName(e.target.value)} /></Field>
              <Button onClick={() => void act("create_location", { name: locName, timeZone: facTz })}>Add Location</Button>
              <div style={{ marginTop: 10, fontSize: 13, color: "var(--muted)" }}>Locations: {locations.map((l) => l.name).join(", ") || "None"}</div>
            </Card>

            <Card title="Create Resource / Facility">
              <Field label="Name"><input className="input" value={facName} onChange={(e) => setFacName(e.target.value)} /></Field>
              <Field label="Category"><input className="input" value={facCategory} onChange={(e) => setFacCategory(e.target.value)} /></Field>
              <Field label="Time Zone"><input className="input" value={facTz} onChange={(e) => setFacTz(e.target.value)} /></Field>
              <Button onClick={() => void act("create_facility", { name: facName, category: facCategory, timeZone: facTz })}>Create Facility</Button>
            </Card>

            <Card title="Configure Pricing & Cancellation Policy">
              <Field label="Target Facility">
                <select className="select" value={selectedFac} onChange={(e) => setSelectedFac(e.target.value)}>
                  {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </Field>
              <Field label="Amount (Minor Units)"><input className="input" value={priceMinor} onChange={(e) => setPriceMinor(e.target.value)} /></Field>
              <Field label="Currency"><input className="input" value={currency} onChange={(e) => setCurrency(e.target.value)} /></Field>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button onClick={() => void act("set_pricing", { amountMinor: Number(priceMinor), currency }, selectedFac)}>Save Pricing</Button>
                <Button variant="secondary" onClick={() => void act("set_cancellation_policy", { customerCancellationAllowed: true, minNoticeMinutes: 60, adminOverrideAllowed: true }, selectedFac)}>Allow 60m Cancel</Button>
              </div>
            </Card>
          </div>

          <Card title="Live Availability Calendar">
            <div style={{ display: "flex", gap: 10, alignItems: "end", marginBottom: 14, flexWrap: "wrap" }}>
              <Field label="Facility">
                <select className="select" value={selectedFac} onChange={(e) => setSelectedFac(e.target.value)}>
                  {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </Field>
              <Field label="Business Date">
                <input className="input" type="date" value={calDate} onChange={(e) => setCalDate(e.target.value)} />
              </Field>
              <div style={{ marginBottom: 12 }}>
                <Button onClick={() => void loadCalendar()}>Load Slots</Button>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {slots.map((s) => (
                <div key={s.slotRef} style={{ border: "1px solid var(--border)", padding: "8px 12px", borderRadius: 8 }}>
                  <div style={{ fontWeight: 600 }}>{s.localStart} - {s.localEnd}</div>
                  <Badge tone={s.available ? "ok" : "danger"}>{s.available ? `Open (${s.amountMinor ?? 0} ${s.currency ?? ""})` : "Booked/Blocked"}</Badge>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Registered Facilities">
            <table className="table">
              <thead><tr><th>Name</th><th>Category</th><th>TimeZone</th><th>Rev</th><th>Status</th></tr></thead>
              <tbody>
                {facilities.map((f) => (
                  <tr key={f.id}>
                    <td>{f.name}</td>
                    <td>{f.category}</td>
                    <td>{f.timeZone}</td>
                    <td>v{f.configurationRevision}</td>
                    <td><Badge tone={f.active ? "ok" : "danger"}>{f.active ? "Active" : "Inactive"}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </ConsoleShell>
  );
}

