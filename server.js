// server.js — Spotify MCP server (Node 18+)
// Modes:
//   node server.js --setup   # one-time OAuth to get refresh token (writes .env) then exits
//   node server.js           # normal MCP server (uses env vars, NO stdout logs)

import "dotenv/config"; //imports from our .env file
import 'dotenv/config';
//console.log('Client ID:', JSON.stringify(process.env.SPOTIFY_CLIENT_ID));
//console.log('Redirect URI:', JSON.stringify(process.env.SPOTIFY_REDIRECT_URI));
import http from "node:http";
import { exec } from "node:child_process";
import { writeFileSync, existsSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------- Config you can tweak ----------
const REDIRECT_URI = "http://127.0.0.1:8888/callback";  // use 127.0.0.1 (not localhost)
const SCOPES = [
  "user-top-read",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

// Minimal env helper
const env = (k, d = undefined) => process.env[k] ?? d;

// ---------- One-time OAuth setup mode ----------
if (process.argv.includes("--setup")) {
  const CLIENT_ID = env("SPOTIFY_CLIENT_ID", "");
  const CLIENT_SECRET = env("SPOTIFY_CLIENT_SECRET", "");
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET before running --setup.");
    process.exit(1);
  }

  console.log("Client ID:", JSON.stringify(CLIENT_ID));
  console.log("Redirect URI:", JSON.stringify(REDIRECT_URI));
  
  const STATE = randomBytes(8).toString("hex");
  const AUTH_URL =
    "https://accounts.spotify.com/authorize" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent(STATE)}`;

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/callback")) { res.writeHead(404); res.end("Not found"); return; }
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error) { console.log("Spotify error:", error); res.writeHead(400); res.end("Auth error"); return shutdown(1); }
      if (!code || state !== STATE) { console.log("Missing code or state mismatch"); res.writeHead(400); res.end("Bad request"); return shutdown(1); }

      // Exchange code -> tokens
      const body = new URLSearchParams();
      body.set("grant_type", "authorization_code");
      body.set("code", code);
      body.set("redirect_uri", REDIRECT_URI);
      body.set("client_id", CLIENT_ID);
      body.set("client_secret", CLIENT_SECRET);

      const r = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.log("Token exchange failed:", r.status, txt);
        res.writeHead(500); res.end("Token exchange failed"); return shutdown(1);
      }

      const json = await r.json();
      const access = json.access_token;
      const refresh = json.refresh_token;
      const expires = json.expires_in;

      console.log("\n✅ Success! Save these (also writing .env):");
      console.log("SPOTIFY_REFRESH_TOKEN=", refresh);
      console.log("SPOTIFY_ACCESS_TOKEN =", access, `(expires in ${expires}s)`);

      const lines = [
        `SPOTIFY_CLIENT_ID=${CLIENT_ID}`,
        `SPOTIFY_CLIENT_SECRET=${CLIENT_SECRET}`,
        `SPOTIFY_REFRESH_TOKEN=${refresh}`,
        `# Optional: SPOTIFY_ACCESS_TOKEN=${access}`,
        ""
      ].join("\n");

      try {
        if (!existsSync(".env")) { writeFileSync(".env", lines); console.log("📝 Wrote .env"); }
        else { appendFileSync(".env", "\n"+lines); console.log("📝 Appended to .env"); }
        if (!existsSync(".gitignore")) { writeFileSync(".gitignore", ".env\n"); console.log("🛡️  Created .gitignore"); }
      } catch (e) { console.log("Could not write .env/.gitignore:", e); }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>All set!</h1><p>You can close this window.</p>");
      return shutdown(0);

      function shutdown(code = 0) { server.close(() => process.exit(code)); }
    } catch (e) {
      console.log(e);
      try { res.writeHead(500); res.end("Internal error"); } catch {}
      process.exit(1);
    }
  });

  server.listen(8888, () => {
    // BEFORE: console.log("Listening on http://127.0.0.1:5173/callback");
    console.log("Listening on http://127.0.0.1:8888/callback");
    console.log("\nIf your browser doesn't open, open this URL:\n");
    console.log(AUTH_URL + "\n");
    try { exec(`open "${AUTH_URL}"`); } catch {}
  });

  // IMPORTANT: return here so the MCP server below doesn't start in --setup mode
  // (rest of file defines/starts the MCP server for normal runs)
} else {
  // ======= NORMAL MCP SERVER MODE (your existing code) =======

  // In-memory token cache
  let ACCESS_TOKEN = env("SPOTIFY_ACCESS_TOKEN") || null;
  let ACCESS_TOKEN_EXP = 0; // epoch ms

  async function refreshAccessTokenIfNeeded() {
    const now = Date.now();
    if (ACCESS_TOKEN && now < ACCESS_TOKEN_EXP - 30_000) return ACCESS_TOKEN;

    const clientId = env("SPOTIFY_CLIENT_ID");
    const clientSecret = env("SPOTIFY_CLIENT_SECRET");
    const refreshToken = env("SPOTIFY_REFRESH_TOKEN");
    if (!clientId || !clientSecret || !refreshToken) return ACCESS_TOKEN;

    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Spotify token refresh failed: ${res.status} ${txt}`);
    }
    const data = await res.json();
    ACCESS_TOKEN = data.access_token;
    const expiresInSec = Number(data.expires_in ?? 3600);
    ACCESS_TOKEN_EXP = Date.now() + expiresInSec * 1000;
    return ACCESS_TOKEN;
  }

  async function spotifyFetch(endpoint, method = "GET", jsonBody = undefined) {
    const token = await refreshAccessTokenIfNeeded();
    if (!token) throw new Error("No Spotify access token. Provide SPOTIFY_ACCESS_TOKEN or set refresh env vars.");
    const res = await fetch(`https://api.spotify.com/${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Spotify API error: ${res.status} ${txt}`);
    }
    return res.json();
  }

  async function getCurrentUserId() {
    const me = await spotifyFetch("v1/me");
    return me.id;
  }

  const server = new McpServer({ name: "spotify-mcp", version: "1.0.0" });

  // ----- your existing tools (unchanged) -----
  server.registerTool(
    "spotify_get_top_tracks",
    {
      title: "Get Top Tracks",
      description:
        "Fetch the user's top tracks from Spotify. time_range: short_term (~4 weeks), medium_term (~6 months), long_term (several years).",
      inputSchema: {
        time_range: z.enum(["short_term", "medium_term", "long_term"]).default("long_term"),
        limit: z.number().int().min(1).max(50).default(5),
      },
    },
    async ({ time_range, limit }) => {
      const data = await spotifyFetch(`v1/me/top/tracks?time_range=${time_range}&limit=${limit}`, "GET");
      const lines = (data.items ?? []).map(
        (t, i) => `${i + 1}. ${t.name} — ${t.artists.map((a) => a.name).join(", ")}`
      );
      return { content: [{ type: "text", text: lines.join("\n") || "No tracks found." }] };
    }
  );

  server.registerTool(
    "spotify_create_playlist",
    {
      title: "Create Playlist",
      description: "Create a new Spotify playlist in the current user's account. Returns a link.",
      inputSchema: { name: z.string(), description: z.string().default("Created via MCP"), public: z.boolean().default(false) },
    },
    async ({ name, description, public: isPublic }) => {
      const userId = await getCurrentUserId();
      const playlist = await spotifyFetch(`v1/users/${encodeURIComponent(userId)}/playlists`, "POST", {
        name, description, public: isPublic,
      });
      return {
        content: [
          { type: "text", text: `Created: ${playlist.name}` },
          { type: "resource_link", uri: playlist.external_urls?.spotify || playlist.href, name: playlist.name, description: "Open in Spotify" },
        ],
      };
    }
  );

  server.registerTool(
    "spotify_add_to_playlist",
    {
      title: "Add Tracks to Playlist",
      description: "Add one or more track URIs (spotify:track:...) to a given playlist ID.",
      inputSchema: { playlistId: z.string(), uris: z.array(z.string()).min(1), position: z.number().int().optional() },
    },
    async ({ playlistId, uris, position }) => {
      const body = { uris, ...(typeof position === "number" ? { position } : {}) };
      await spotifyFetch(`v1/playlists/${encodeURIComponent(playlistId)}/tracks`, "POST", body);
      return { content: [{ type: "text", text: `Added ${uris.length} track(s) to playlist ${playlistId}.` }] };
    }
  );

  server.registerTool(
    "spotify_search_tracks",
    {
      title: "Search Tracks",
      description: "Search Spotify tracks by a text query and return up to N URIs you can add to a playlist.",
      inputSchema: { q: z.string().describe("Query, e.g., 'lofi beats tempo:90'"), limit: z.number().int().min(1).max(50).default(10) },
    },
    async ({ q, limit }) => {
      const data = await spotifyFetch(`v1/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`);
      const items = data.tracks?.items ?? [];
      const lines = items.map((t, i) => `${i + 1}. ${t.name} — ${t.artists.map((a) => a.name).join(", ")}  [${t.uri}]`);
      return { content: [{ type: "text", text: lines.join("\n") || "No tracks found. Try a different query or filters." }] };
    }
  );

  // IMPORTANT: In MCP mode, don't log to stdout; use stderr if you need logs.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
