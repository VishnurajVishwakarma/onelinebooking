import { NextResponse } from "next/server";
import { CONSOLE_SESSION_COOKIE, getConsoleBackend, jsonErrorResponse, verifyConsoleCsrfOrigin } from "@/lib/engine";

export async function POST(req: Request) {
  try {
    verifyConsoleCsrfOrigin(req);
    const backend = await getConsoleBackend();
    const body = (await req.json()) as {
      action:
      | "register"
      | "login"
      | "logout"
      | "request_email_verification"
      | "verify_email"
      | "request_password_reset"
      | "reset_password";
      email?: string;
      name?: string;
      password?: string;
      token?: string;
      newPassword?: string;
    };

    if (body.action === "verify_email") {
      const verified = await backend.auth.verifyEmail(body.token ?? "");
      return NextResponse.json(verified);
    }

    if (body.action === "request_password_reset") {
      await backend.auth.requestPasswordReset(body.email ?? "");
      return NextResponse.json({ sent: true });
    }

    if (body.action === "reset_password") {
      await backend.auth.resetPassword({
        resetToken: body.token ?? "",
        newPassword: body.newPassword ?? "",
      });
      return NextResponse.json({ reset: true });
    }

    if (body.action === "logout") {
      const cookieHeader = req.headers.get("cookie") ?? "";
      const match = /olb_console_session=([^;]+)/.exec(cookieHeader);
      if (match) {
        await backend.auth.revokeSession(decodeURIComponent(match[1]!));
      }
      const res = NextResponse.json({ ok: true });
      res.cookies.delete(CONSOLE_SESSION_COOKIE);
      return res;
    }

    if (body.action === "register") {
      await backend.auth.registerUser({
        email: body.email ?? "",
        name: body.name ?? "",
        password: body.password ?? "",
      });
    }

    const login = await backend.auth.loginUser({
      email: body.email ?? "",
      password: body.password ?? "",
    });
    const res = NextResponse.json({ user: login.user, expiresAt: login.expiresAt }, { status: 200 });
    res.cookies.set(CONSOLE_SESSION_COOKIE, login.sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

