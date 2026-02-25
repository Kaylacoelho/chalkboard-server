// ─── ChalkBoard — server.js ───────────────────────────────────────────────────
//
// This is a tiny Express server that sits between your React app and ESPN.
// Your React app calls THIS server (e.g. /api/scores/nba),
// and THIS server calls ESPN, then sends the data back.
//
// WHY do we need a server at all?
// ESPN's API blocks requests that come from a browser directly (CORS policy).
// But it's happy to respond to server-to-server requests. So we proxy through here.
//
// HOW TO RUN:
//   1. Make sure you have Node installed: node --version
//   2. In this folder, run:  npm init -y && npm install express node-fetch cors
//   3. Then run:             node server.js
//   4. Server starts at:    http://localhost:3001

import express from "express";
import fetch from "node-fetch";
import cors from "cors";

// Returns a date string in ESPN's required format: YYYYMMDD
// offset = 0 means today, offset = -1 means yesterday
function espnDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
  // .slice(0,10) grabs "2026-02-25", .replace removes dashes → "20260225"
}

const app = express();
const PORT = process.env.PORT || 3001;

// cors() tells the server to allow requests from your React app (localhost:5173 or :3000)
// Without this, the browser would block responses coming back from a different port.
app.use(cors());

// ─── ESPN endpoint map ────────────────────────────────────────────────────────
// Each key is the league name your React app will send in the URL.
// Each value is the ESPN scoreboard URL for that league.
const ESPN_URLS = {
  nba: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  nfl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  nhl: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard",
  mls: "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard",
  ucl: "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard",
};

// ─── Data transformer ─────────────────────────────────────────────────────────
// ESPN returns a lot of nested data we don't need.
// This function pulls out only what ChalkBoard cares about.
function transformGames(espnData) {
  const events = espnData.events ?? [];

  return events.map((event) => {
    const competition = event.competitions[0];
    const competitors = competition.competitors;

    // ESPN always has two competitors. Find home and away.
    const homeComp = competitors.find((c) => c.homeAway === "home");
    const awayComp = competitors.find((c) => c.homeAway === "away");

    const homeAbbr = homeComp.team.abbreviation;
    const awayAbbr = awayComp.team.abbreviation;

    // Map ESPN status types to our simpler status strings
    const statusType = competition.status.type.name;
    let status = "scheduled";
    if (statusType === "STATUS_IN_PROGRESS") status = "in_progress";
    if (statusType === "STATUS_FINAL") status = "final";
    if (statusType === "STATUS_HALFTIME") status = "in_progress";
    
    // Safety net: if the game's start time is in the past but ESPN still
    // says "scheduled", override it to "final". This catches stale data.
    // Date.now() is the current time in milliseconds.
    // new Date(event.date).getTime() converts the game's start time to milliseconds too,
    // so we can compare them with a simple greater-than check.
    if (status === "scheduled" && new Date(event.date).getTime() < Date.now()) {
      status = "final";
    }

    // Win probability — ESPN provides this in competition.situation or odds
    // It's not always present, so we fall back to undefined safely
    const probData = competition.situation?.lastPlay?.probability;
    let win_probability;
    if (probData) {
      win_probability = {
        [homeAbbr]: +(probData.homeWinPercentage * 100).toFixed(1),
        [awayAbbr]: +(probData.awayWinPercentage * 100).toFixed(1),
      };
    }

    // Odds (spread/moneyline) — useful extra info for bettors
    const odds = competition.odds?.[0];
    const spread = odds
      ? {
          favorite: odds.details, // e.g. "LAL -5.5"
          overUnder: odds.overUnder, // e.g. 224.5
        }
      : null;

    return {
      id: event.id,
      name: event.name,
      status,
      start_time: event.date,
      home: homeAbbr,
      away: awayAbbr,
      teams: {
        [homeAbbr]: {
          name: homeComp.team.displayName,
          logo: homeComp.team.logo,
        },
        [awayAbbr]: {
          name: awayComp.team.displayName,
          logo: awayComp.team.logo,
        },
      },
      score: {
        [homeAbbr]: parseInt(homeComp.score ?? 0),
        [awayAbbr]: parseInt(awayComp.score ?? 0),
      },
      // Only include win_probability if we have data
      ...(win_probability && { win_probability }),
      // Only include spread if we have data
      ...(spread && { spread }),
    };
  });
}

// ─── Route: GET /api/scores/:league ───────────────────────────────────────────
// :league is a URL parameter — it becomes req.params.league
// Example: GET /api/scores/nba  →  fetches NBA scores from ESPN
app.get("/api/scores/:league", async (req, res) => {
  const league = req.params.league.toLowerCase();
  const espnUrl = ESPN_URLS[league];

  if (!espnUrl) {
    // 400 = Bad Request — the client sent a league we don't recognize
    return res.status(400).json({ error: `Unknown league: ${league}` });
  }

  try {
    // fetch() makes an HTTP request — just like in the browser, but on the server
// Fetch yesterday through today in one request using ESPN's date range format
    const yesterday = espnDate(-1);
    const tomorrow = espnDate(1);
    const response = await fetch(`${espnUrl}?dates=${yesterday}-${tomorrow}&limit=100`);

    const data = await response.json();
    const games = transformGames(data);

    // 200 = OK — send the transformed games back to the React app
    res.status(200).json({ league, games });
  } catch (err) {
    console.error(`[${league.toUpperCase()}] fetch error:`, err.message);
    // 500 = Internal Server Error — something went wrong on our end
    res
      .status(500)
      .json({ error: "Failed to fetch scores", detail: err.message });
  }
});

// ─── Health check route ───────────────────────────────────────────────────────
// Useful to quickly confirm the server is running: curl http://localhost:3001/health
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ─── Start the server ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ ChalkBoard server running at http://localhost:${PORT}`);
  console.log(`   Try: http://localhost:${PORT}/api/scores/nba\n`);
});
