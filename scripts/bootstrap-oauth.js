#!/usr/bin/env node
// scripts/bootstrap-oauth.js
//
// One-time local utility — generates the GOOGLE_REFRESH_TOKEN for the
// calendar sync feature. Run ONCE from your laptop, sign in as
// hello@viewix.com.au, paste the token into Vercel.
//
// Usage:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/bootstrap-oauth.js
//
// (Get the client id/secret from the Google Cloud OAuth client JSON
// you downloaded in step 3 of the manual setup. Use the "Desktop
// application" client type — Web application's redirect URI rules
// require a public domain.)
//
// What it does:
// 1. Spins up a tiny localhost server on a random port
// 2. Opens your browser to Google's consent screen with:
//      scope: https://www.googleapis.com/auth/calendar.events
//      access_type: offline    (required for a refresh token)
//      prompt: consent         (force refresh-token issuance even if
//                               you've consented before)
// 3. You sign in as hello@viewix.com.au and approve
// 4. Callback hits localhost, captures the refresh token
// 5. Prints the refresh token to stdout, shuts down
//
// Never deployed to Vercel. Pure local utility.

import http from "http";
import { exec } from "child_process";
import crypto from "crypto";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET env vars.");
  console.error("Get them from the OAuth client JSON in Google Cloud → APIs & Services → Credentials.");
  console.error("");
  console.error("Usage:");
  console.error("  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/bootstrap-oauth.js");
  process.exit(1);
}

// CSRF / replay protection — random state string sent in the auth
// URL, verified on the callback.
const state = crypto.randomBytes(16).toString("hex");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  if (url.pathname !== "/oauth/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`OAuth error: ${err}`);
    console.error(`\nGoogle returned error: ${err}`);
    server.close();
    process.exit(1);
  }

  if (returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("State mismatch — possible CSRF.");
    console.error("\nState parameter mismatch. Aborting.");
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing code parameter.");
    server.close();
    process.exit(1);
  }

  try {
    const port = server.address().port;
    const redirectUri = `http://localhost:${port}/oauth/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("\nToken exchange failed:", tokenData);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Token exchange failed. Check console.");
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <html>
        <body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: auto;">
          <h2>Refresh token captured.</h2>
          <p>You can close this tab and return to the terminal.</p>
        </body>
      </html>
    `);

    console.log("\n────────────────────────────────────────────────────────────");
    console.log("SUCCESS — Google OAuth refresh token captured.");
    console.log("────────────────────────────────────────────────────────────\n");
    console.log("Add this to Vercel as GOOGLE_REFRESH_TOKEN:\n");
    console.log(tokenData.refresh_token);
    console.log("\n────────────────────────────────────────────────────────────");
    console.log("Next steps:");
    console.log("  1. Vercel → Settings → Environment Variables");
    console.log("  2. Add GOOGLE_REFRESH_TOKEN (Production)");
    console.log("  3. Also add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, VIEWIX_CALENDAR_ID, CRON_SECRET");
    console.log("  4. Redeploy production for the env vars to take effect");
    console.log("────────────────────────────────────────────────────────────\n");

    server.close();
    process.exit(0);
  } catch (e) {
    console.error("\nUnexpected error:", e);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Unexpected error. Check console.");
    server.close();
    process.exit(1);
  }
});

// Listen on a random free port — Desktop OAuth client accepts any
// localhost callback.
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();

  console.log("\nOpening Google's consent screen in your browser...\n");
  console.log("Sign in as hello@viewix.com.au and approve the Calendar scope.\n");
  console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);

  // Best-effort browser open. macOS / Linux / Windows.
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${authUrl}"`, (err) => {
    if (err) {
      // Fine — user can paste the URL manually.
    }
  });
});
