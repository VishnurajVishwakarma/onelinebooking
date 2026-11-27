"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Card, Field } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/console/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, email, name, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Authentication failed");
        return;
      }
      router.push("/");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main style={{ maxWidth: 460, margin: "64px auto", padding: 16 }}>
      <Card
        title="OneLineBooking Developer Console"
        subtitle={mode === "login" ? "Sign in to manage projects, credentials, and booking facilities" : "Create a developer account (password min 10 chars)"}
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <Button variant={mode === "login" ? "primary" : "secondary"} onClick={() => setMode("login")}>
            Sign In
          </Button>
          <Button variant={mode === "register" ? "primary" : "secondary"} onClick={() => setMode("register")}>
            Register
          </Button>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <form onSubmit={(e) => void submit(e)}>
          {mode === "register" && (
            <Field label="Full Name" htmlFor="name-input">
              <input id="name-input" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
          )}
          <Field label="Email Address" htmlFor="email-input">
            <input id="email-input" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password" htmlFor="password-input">
            <input id="password-input" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
          </Field>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
          </Button>
        </form>
      </Card>
    </main>
  );
}

