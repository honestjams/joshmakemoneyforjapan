import { NextResponse, type NextRequest } from "next/server";

/**
 * Password-protects the dashboard (it shows balances and has a halt button).
 * Browser prompts for a username (anything) and DASHBOARD_PASSWORD.
 * /api/tick is excluded: it checks its own CRON_SECRET.
 */
export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return new NextResponse("Set DASHBOARD_PASSWORD to enable the dashboard.", { status: 503 });

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const given = decoded.slice(decoded.indexOf(":") + 1);
    if (constantTimeEqual(given, password)) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="trading-bot"' },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!api/tick|_next/static|_next/image|favicon.ico).*)"],
};
