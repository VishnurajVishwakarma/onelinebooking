"use client";

import React from "react";

export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
          <div>
            {title && <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>}
            {subtitle && <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted)" }}>{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "ok" | "warn" | "danger" | "neutral";
  children: React.ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Button({
  variant = "primary",
  type = "button",
  disabled,
  onClick,
  children,
}: {
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`btn btn-${variant}`} type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={htmlFor} style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function Alert({ tone = "warn", children }: { tone?: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const cls = tone === "ok" ? "badge-ok" : tone === "danger" ? "badge-danger" : "badge-warn";
  return (
    <div className={cls} role="status" style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 14, display: "block" }}>
      {children}
    </div>
  );
}

