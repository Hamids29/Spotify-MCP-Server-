// server.js — Spotify MCP server (Node 18+)
// Requires: @modelcontextprotocol/sdk, zod
// Uses stdio transport (for Claude Desktop, etc.)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ----- Minimal env loader (optional). If you prefer dotenv, `npm i dotenv` and use it.
const env = (k, d = undefined) => process.env[k] ?? d;

// In-memory token cache
let ACCESS_TOKEN = env("SPOTIFY_ACCESS_TOKEN") || null;
let ACCESS_TOKEN_EXP = 0; // epoch ms

async function refreshAccessTokenIfNeeded() {
  const now = Date.now();
  if (ACCESS_TOKEN && now < ACCESS_TOKEN_EXP - 30_000) return ACCESS_TOKEN;

  const clientId = env("SPOTIFY_CLIENT_ID");
  const clientSecret = env("SPOTIFY_CLIENT_SECRET");
  const refreshToken = env("SPOTIFY_REFRESH_TOKEN");

  // If no refresh creds, just return whatever we have (or null). Useful for quick/manual testing.
  if (!clientId || !clientSecret || !refreshToken) return ACCESS_TOKEN;

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Spotify token refresh failed: ${res.status} ${txt}`);
  }
  const data = await res.json();
  ACCESS_TOKEN = data.access_token;
  // Usually 3600 sec
  const expiresInSec = Number(data.expires_in ?? 3600);
  ACCESS_TOKEN_EXP = Date.now() + expiresInSec * 1000;
  return ACCESS_TOKEN;
}

async function spotifyFetch(endpoint, method = "GET", jsonBody = undefined) {
  const token = await refreshAccessTokenIfNeeded();
  if (!token) {
    throw new Error(
      "No Spotify access token. Provide SPOTIFY_ACCESS_TOKEN or a refresh setup (SPOTIFY_CLIENT_ID/SECRET/REFRESH_TOKEN)."
    );
  }

  const res = await fetch(`https://api.spotify.com/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
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

// ---------------- MCP server ----------------

const server = new McpServer({
  name: "spotify-mcp",
  version: "1.0.0",
});

// Tool: Get top tracks
server.registerTool(
  "spotify_get_top_tracks",
  {
    title: "Get Top Tracks",
    description:
      "Fetch the user's top tracks from Spotify. time_range: short_term (~4 weeks), medium_term (~6 months), long_term (several years).",
    inputSchema: {
      time_range: z
        .enum(["short_term", "medium_term", "long_term"])
        .default("long_term"),
      limit: z.number().int().min(1).max(50).default(5),
    },
  },
  async ({ time_range, limit }) => {
    const data = await spotifyFetch(
      `v1/me/top/tracks?time_range=${time_range}&limit=${limit}`,
      "GET"
    );
    const lines = (data.items ?? []).map(
      (t, i) =>
        `${i + 1}. ${t.name} — ${t.artists.map((a) => a.name).join(", ")}`
    );

    return {
      content: [{ type: "text", text: lines.join("\n") || "No tracks found." }],
    };
  }
);

// Tool: Create playlist
server.registerTool(
  "spotify_create_playlist",
  {
    title: "Create Playlist",
    description:
      "Create a new Spotify playlist in the current user's account. Returns a link.",
    inputSchema: {
      name: z.string(),
      description: z.string().default("Created via MCP"),
      public: z.boolean().default(false),
    },
  },
  async ({ name, description, public: isPublic }) => {
    const userId = await getCurrentUserId();
    const playlist = await spotifyFetch(
      `v1/users/${encodeURIComponent(userId)}/playlists`,
      "POST",
      {
        name,
        description,
        public: isPublic,
      }
    );

    return {
      content: [
        { type: "text", text: `Created: ${playlist.name}` },
        {
          type: "resource_link",
          uri: playlist.external_urls?.spotify || playlist.href,
          name: playlist.name,
          description: "Open in Spotify",
        },
      ],
    };
  }
);

// Tool: Add tracks to playlist
server.registerTool(
  "spotify_add_to_playlist",
  {
    title: "Add Tracks to Playlist",
    description:
      "Add one or more track URIs (spotify:track:...) to a given playlist ID.",
    inputSchema: {
      playlistId: z.string(),
      uris: z.array(z.string()).min(1),
      position: z.number().int().optional(),
    },
  },
  async ({ playlistId, uris, position }) => {
    const body = { uris };
    if (typeof position === "number") body.position = position;

    await spotifyFetch(
      `v1/playlists/${encodeURIComponent(playlistId)}/tracks`,
      "POST",
      body
    );

    return {
      content: [
        {
          type: "text",
          text: `Added ${uris.length} track(s) to playlist ${playlistId}.`,
        },
      ],
    };
  }
);

// (Optional) Tool: Search tracks by query – good for “make me a playlist from a prompt”
server.registerTool(
  "spotify_search_tracks",
  {
    title: "Search Tracks",
    description:
      "Search Spotify tracks by a text query and return up to N URIs you can add to a playlist.",
    inputSchema: {
      q: z.string().describe("Search query, e.g., 'lofi beats 2020 tempo:90'"),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ q, limit }) => {
    const data = await spotifyFetch(
      `v1/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`
    );
    const items = data.tracks?.items ?? [];
    const lines = items.map(
      (t, i) =>
        `${i + 1}. ${t.name} — ${t.artists
          .map((a) => a.name)
          .join(", ")}  [${t.uri}]`
    );

    return {
      content: [
        {
          type: "text",
          text:
            lines.join("\n") ||
            "No tracks found. Try a different query or filters.",
        },
      ],
    };
  }
);

// IMPORTANT: For stdio servers, don’t log to stdout (it corrupts JSON-RPC).
// If you need logs, use console.error or a proper logger to stderr. The docs call this out explicitly. :contentReference[oaicite:1]{index=1}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
