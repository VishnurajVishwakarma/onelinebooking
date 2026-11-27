import { NextResponse } from "next/server";
import { CONSOLE_SESSION_COOKIE, getConsoleBackend, jsonErrorResponse } from "@/lib/engine";

export async function POST(req: Request) {
  try {
    const backend = await getConsoleBackend();
    const body = (await req.json()) as {
      action: "register" | "login" | "logout";
      email?: string;
      name?: string;
      password?: string;
    };

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

