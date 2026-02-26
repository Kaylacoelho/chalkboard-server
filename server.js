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

// Maps our short league codes to ESPN's sport/league URL path segment
const ESPN_SPORT_PATH = {
  nba: "basketball/nba",
  nfl: "football/nfl",
  nhl: "hockey/nhl",
  mls: "soccer/usa.1",
  ucl: "soccer/uefa.champions",
};

// ─── Data transformer ─────────────────────────────────────────────────────────
// ESPN returns a lot of nested data we don't need.
// This function pulls out only what ChalkBoard cares about.
function transformGames(espnData, sport) {
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
    if (statusType === "STATUS_HALFTIME") status = "in_progress";
    if (statusType === "STATUS_FINAL") status = "final";
    if (statusType === "STATUS_FULL_TIME") status = "final";
    if (statusType === "STATUS_FINAL_OVERTIME") status = "final";
    if (statusType === "STATUS_FINAL_PENALTY") status = "final";
    // Trust ESPN's completed flag as the authoritative source
    if (competition.status.type.completed) status = "final";

    const GAME_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours
    const startTime = new Date(event.date).getTime();
    if (status === "scheduled") {
      if (Date.now() >= startTime + GAME_DURATION_MS) status = "final";
      else if (Date.now() >= startTime) status = "in_progress";
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

    // Broadcasts (TV/streaming channels)
    const broadcasts = (competition.broadcasts ?? [])
      .flatMap(b => b.names ?? [])
      .filter(Boolean);

    // Play events: goals, cards, substitutions, etc.
    const gameEvents = (competition.details ?? [])
      .filter(d => d.type?.text)
      .map(d => ({
        type: d.type.text,
        isHome: d.team?.id === homeComp.team.id,
        player: d.athletesInvolved?.[0]?.displayName ?? null,
        clock: d.clock?.displayValue ?? null,
      }));

    // Team-level statistics (populated for live/completed games)
    const extractStats = (comp) => {
      const raw = comp.statistics ?? [];
      if (!raw.length) return null;
      return raw.reduce((acc, s) => {
        acc[s.name] = { label: s.abbreviation ?? s.name, value: s.displayValue };
        return acc;
      }, {});
    };
    const homeStats = extractStats(homeComp);
    const awayStats = extractStats(awayComp);

    return {
      id: event.id,
      name: event.name,
      sport,
      status,
      clock: competition.status.type.shortDetail ?? null,
      start_time: event.date,
      home: homeAbbr,
      away: awayAbbr,
      teams: {
        [homeAbbr]: {
          id: homeComp.team.id,
          name: homeComp.team.displayName,
          logo: homeComp.team.logo,
        },
        [awayAbbr]: {
          id: awayComp.team.id,
          name: awayComp.team.displayName,
          logo: awayComp.team.logo,
        },
      },
      score: {
        [homeAbbr]: parseInt(homeComp.score ?? 0),
        [awayAbbr]: parseInt(awayComp.score ?? 0),
      },
      ...(win_probability && { win_probability }),
      ...(spread && { spread }),
      ...(broadcasts.length > 0 && { broadcasts }),
      ...(gameEvents.length > 0 && { events: gameEvents }),
      ...(homeStats && { homeStats }),
      ...(awayStats && { awayStats }),
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
    const games = transformGames(data, league);

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

// ─── Route: GET /api/team/:sport/:teamId ──────────────────────────────────────
// Returns team record, recent form, season stats, and roster for the side panel.
// :sport = nba/nfl/nhl/mls/ucl   :teamId = ESPN team ID (from game data)
app.get("/api/team/:sport/:teamId", async (req, res) => {
  const { sport, teamId } = req.params;
  const sportPath = ESPN_SPORT_PATH[sport];
  if (!sportPath) return res.status(400).json({ error: `Unknown sport: ${sport}` });

  const base = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${teamId}`;

  try {
    // Fetch all four endpoints in parallel; statistics/roster are best-effort
    const [teamRes, schedRes, statsRes, rosterRes] = await Promise.all([
      fetch(base),
      fetch(`${base}/schedule`),
      fetch(`${base}/statistics`).catch(() => null),
      fetch(`${base}/roster`).catch(() => null),
    ]);
    const teamData   = await teamRes.json();
    const schedData  = await schedRes.json();
    const statsData  = statsRes  ? await statsRes.json().catch(() => ({}))  : {};
    const rosterData = rosterRes ? await rosterRes.json().catch(() => ({})) : {};

    const team = teamData.team ?? {};

    // Season record — ESPN nests it under record.items; "total" is the overall row
    const recordItems = team.record?.items ?? [];
    const mainRecord = recordItems.find(r => r.type === "total") ?? recordItems[0];
    const wins   = mainRecord?.stats?.find(s => s.name === "wins")?.value   ?? 0;
    const losses = mainRecord?.stats?.find(s => s.name === "losses")?.value ?? 0;
    const ties   = mainRecord?.stats?.find(s => s.name === "ties")?.value;
    const summary = mainRecord?.summary ?? `${wins}-${losses}`;

    // Recent games — take last 8 completed from schedule, newest first
    const events = schedData.events ?? [];
    const completedGames = events
      .filter(e => e.competitions?.[0]?.status?.type?.completed)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 8);

    const recentGames = completedGames.map(e => {
      const comp  = e.competitions[0];
      const comps = comp.competitors;
      // Match this team by ESPN id (use String() so "13" === "13" regardless of source type)
      const mine   = comps.find(c => String(c.team?.id) === String(teamId)) ?? comps[0];
      const theirs = comps.find(c => c !== mine) ?? comps[1];
      if (!mine || !theirs) return null;
      // Use null when score is missing/empty so the UI can distinguish 0 from "no data"
      const parseScore = (s) => (s != null && s !== "") ? Number.parseInt(s) : null;
      const myScore    = parseScore(mine.score);
      const theirScore = parseScore(theirs.score);
      const result = mine.winner ? "W" : theirs.winner ? "L" : "D";
      return {
        date:      e.date,
        opponent:  theirs.team?.abbreviation ?? theirs.team?.displayName ?? "?",
        result,
        teamScore: myScore,
        oppScore:  theirScore,
        isHome:    mine.homeAway === "home",
      };
    }).filter(Boolean);

    // Current streak (consecutive W/L/D from the most recent game)
    let streakType = null, streakCount = 0;
    for (const g of recentGames) {
      if (!streakType) { streakType = g.result; streakCount = 1; }
      else if (g.result === streakType) streakCount++;
      else break;
    }

    // Best win / worst loss among recent games (by margin)
    const withMargin = recentGames.map(g => ({ ...g, margin: g.teamScore - g.oppScore }));
    const bestGame  = withMargin.length ? withMargin.reduce((a, b) => b.margin > a.margin ? b : a) : null;
    const worstGame = withMargin.length ? withMargin.reduce((a, b) => b.margin < a.margin ? b : a) : null;

    // Season statistics — ESPN nests stats in results.stats.categories (varies by sport)
    let seasonStats = null;
    const statsCategories =
      statsData.results?.stats?.categories ??
      statsData.stats?.categories ??
      statsData.statistics?.splits?.categories ??
      [];
    if (statsCategories.length > 0) {
      seasonStats = {};
      for (const cat of statsCategories) {
        for (const stat of (cat.stats ?? [])) {
          if (stat.name && stat.displayValue) {
            seasonStats[stat.name] = {
              label:    stat.abbreviation ?? stat.name,
              value:    stat.displayValue,
              category: cat.name ?? null,
            };
          }
        }
      }
      if (Object.keys(seasonStats).length === 0) seasonStats = null;
    }

    // Roster — ESPN's shape varies: flat athletes[], roster.entries[], or grouped
    let allAthletes = [];
    if (Array.isArray(rosterData.athletes) && rosterData.athletes.length > 0) {
      // Could be flat or grouped by position
      const first = rosterData.athletes[0];
      if (first?.items) {
        allAthletes = rosterData.athletes.flatMap(g => g.items ?? []);
      } else {
        allAthletes = rosterData.athletes;
      }
    } else if (Array.isArray(rosterData.roster?.entries)) {
      allAthletes = rosterData.roster.entries;
    } else if (Array.isArray(rosterData.roster?.athletes)) {
      allAthletes = rosterData.roster.athletes;
    }

    const topPlayers = allAthletes.slice(0, 20).map(entry => {
      const a = entry.athlete ?? entry; // handle both {athlete:{...}} and flat shapes
      return {
        name:     a.displayName ?? a.fullName ?? null,
        jersey:   a.jersey ?? entry.jerseyNumber ?? null,
        position: a.position?.abbreviation ?? a.position?.name ?? null,
        headshot: a.headshot?.href ?? null,
      };
    }).filter(p => p.name);

    res.json({
      id:           team.id,
      name:         team.displayName,
      nickname:     team.nickname,
      abbreviation: team.abbreviation,
      logo:         team.logos?.[0]?.href,
      color:        team.color,
      record:       { wins, losses, ...(ties != null && { ties }), summary },
      recentGames,
      streak:       streakCount >= 2 ? { type: streakType, count: streakCount } : null,
      bestGame,
      worstGame,
      seasonStats,
      topPlayers:   topPlayers.length > 0 ? topPlayers : null,
    });
  } catch (err) {
    console.error(`[team/${sport}/${teamId}] error:`, err.message);
    res.status(500).json({ error: "Failed to fetch team data" });
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
