// ============================================================
// Race Game Leaderboard API v4.0
// Node.js + Express + MongoDB
// ============================================================

import express from "express";
import { MongoClient } from "mongodb";
import cors from "cors";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

// ---- ENV VALIDATION ----

const REQUIRED_ENV = ["MONGO_URI", "API_SECRET", "ADMIN_KEY", "REWARDED_AD_UNIT"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
}

const MONGO_URI        = process.env.MONGO_URI;
const API_SECRET       = process.env.API_SECRET;
const ADMIN_KEY        = process.env.ADMIN_KEY;
const REWARDED_AD_UNIT = process.env.REWARDED_AD_UNIT;
const DB_NAME          = process.env.DB_NAME || "RaceGame";
const PORT             = parseInt(process.env.PORT || "3000", 10);

// ---- CONSTANTS ----

const CAR_PHYSICS = {
  0: { distanceCap: 100000, speedCap: 300, minRunSecs: 3 },
  1: { distanceCap: 100000, speedCap: 300, minRunSecs: 3 },
  2: { distanceCap: 100000, speedCap: 300, minRunSecs: 3 },
  3: { distanceCap: 100000, speedCap: 350, minRunSecs: 3 },
  4: { distanceCap: 100000, speedCap: 400, minRunSecs: 3 },
};
const VALID_CAR_IDS = new Set(Object.keys(CAR_PHYSICS).map(Number));

// ---- IN-MEMORY STATE ----

const activeAdTokens = new Map();
const seenSignatures = new Set();

// Süresi dolmuş ad tokenlarını 10 dakikada bir temizle
setInterval(() => {
  const now = Date.now();
  for (const [playerID, data] of activeAdTokens) {
    if (now > data.expiresAt) activeAdTokens.delete(playerID);
  }
}, 10 * 60_000);

// Replay saldırılarına karşı imza setini dakikada bir sıfırla
setInterval(() => seenSignatures.clear(), 60_000);

// ---- LEADERBOARD CACHE ----

// Level bazlı önbellek: levelID -> { data: [], timestamp: 0 }
const cachedLeaderboards = new Map(); 
const CACHE_TTL_MS    = 30_000;

// ---- DATABASE ----

const client = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
});

let collection;
let logsCollection;
let countsCollection;

async function initDatabase() {
  await client.connect();
  const db = client.db(DB_NAME);

  collection      = db.collection("Leaderboard");
  logsCollection  = db.collection("RequestLogs");
  countsCollection = db.collection("RequestCounts");

  // Yeni level mimarisine uygun indexleme
  await collection.createIndex({ playerID: 1, carID: 1, levelID: 1 }, { unique: true });
  await collection.createIndex({ flagged: 1, distance: -1 });
  await collection.createIndex({ carID: 1, flagged: 1, distance: -1 });

  // RequestLogs: 3 günlük TTL, detaylı istek geçmişi
  await logsCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });
  await logsCollection.createIndex({ type: 1, playerID: 1, createdAt: -1 });

  // RequestCounts: kalıcı, endpoint başına toplam sayaç
  await countsCollection.createIndex({ endpoint: 1 }, { unique: true });

  console.log("Database ready.");
}

// ---- HELPERS ----

async function calcGlobalRank(distance, levelID) {
  const above = await collection.countDocuments({
    levelID: levelID,
    flagged: false,
    distance: { $gt: distance },
  });
  return above + 1;
}

async function isPlayerRateLimited(playerID) {
  const oneMinuteAgo = new Date(Date.now() - 60_000);
  const count = await logsCollection.countDocuments({
    type: "score_submit",
    playerID,
    createdAt: { $gt: oneMinuteAgo },
  });
  return count >= 5;
}

function checkPhysicsViolations(distance, topSpeed, avgSpeed, carID) {
  const violations = [];
  const limits = CAR_PHYSICS[carID];

  if (!limits) return [`Unknown carID: ${carID}`];
  if (distance > limits.distanceCap) violations.push("Distance threshold exceeded");
  if (topSpeed > limits.speedCap)    violations.push("Velocity threshold exceeded");
  if (avgSpeed > topSpeed)           violations.push("Average velocity anomaly detected");

  if (avgSpeed > 0) {
    const impliedTimeSecs = (distance / avgSpeed) * 3600;
    if (impliedTimeSecs < limits.minRunSecs) {
      violations.push("Temporal performance anomaly detected");
    }
  }

  return violations;
}

async function handleCheaterTelemetry(playerID, violations) {
  await logsCollection.insertOne({
    type: "suspicious_score",
    playerID,
    violations,
    createdAt: new Date(),
  });

  const recentInfractions = await logsCollection.countDocuments({
    type: "suspicious_score",
    playerID,
    createdAt: { $gt: new Date(Date.now() - 10 * 60_000) },
  });

  if (recentInfractions >= 3) {
    await collection.updateMany({ playerID }, { $set: { flagged: true } });
  }
}

// ---- APP ----

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "10kb" }));

// ---- RATE LIMITERS ----

const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
});

const scoreLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many requests" }),
});

app.use(globalLimiter);

// ---- REQUEST LOGGING MIDDLEWARE ----

function logRequest(req, res, next) {
  if (req.path === "/ping") return next();

  const startTime = Date.now();

  res.on("finish", () => {
    const endpoint    = `${req.method} ${req.route?.path || req.path}`;
    const durationMs  = Date.now() - startTime;
    const rawPlayerID = req.body?.playerID || req.params?.playerID || null;
    const playerID    = rawPlayerID
      ? String(rawPlayerID).slice(0, 64).replace(/[^\w\-]/g, "")
      : null;

    logsCollection
      .insertOne({
        type:       "request",
        method:     req.method,
        path:       req.path,
        endpoint,
        statusCode: res.statusCode,
        playerID,
        ip:         req.ip,
        durationMs,
        userAgent:  req.headers["user-agent"] || null,
        origin:     req.headers["origin"]     || null,
        referer:    req.headers["referer"]    || null,
        createdAt:  new Date(),
      })
      .catch(() => {});

    countsCollection
      .updateOne(
        { endpoint },
        {
          $inc: { total: 1, [`byStatus.s${res.statusCode}`]: 1 },
          $set: { lastSeenAt: new Date() },
          $setOnInsert: { firstSeenAt: new Date() },
        },
        { upsert: true }
      )
      .catch(() => {});
  });

  next();
}

app.use(logRequest);

// ---- SIGNATURE MIDDLEWARE ----

function verifySignature(req, res, next) {
  const ts  = parseInt(req.headers["x-timestamp"] || "0", 10);
  const sig = (req.headers["x-signature"] || "").toLowerCase().trim();

  if (!ts || !sig) return res.status(401).json({ error: "Unauthorized" });

  const nowSeconds = Date.now() / 1000;
  if (nowSeconds - ts > 60 || ts - nowSeconds > 5) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (seenSignatures.has(sig)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { playerID, carID, levelID, distance, topSpeed, avgSpeed } = req.body;
  if (!playerID || carID === undefined || distance === undefined || levelID === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const numLevelID = Number(levelID);
  const numDistance = Number(distance);
  const numTopSpeed = Number(topSpeed || 0);
  const numAvgSpeed = Number(avgSpeed || 0);

  const messageToSign = `${playerID}-${carID}-${numLevelID}-${numDistance.toFixed(4)}-${numTopSpeed.toFixed(4)}-${numAvgSpeed.toFixed(4)}-${ts}`;
  const cleanSecret   = String(API_SECRET).trim();

  const expected = crypto
    .createHmac("sha256", cleanSecret)
    .update(messageToSign)
    .digest("hex");

  if (sig !== expected) {
    console.log("[signature] mismatch:", { messageToSign, received: sig, expected });
  }

  let valid = false;
  try {
    valid =
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch (err) {
    console.log("[signature] buffer error:", err.message);
  }

  if (!valid) return res.status(401).json({ error: "Unauthorized" });

  seenSignatures.add(sig);
  next();
}

// ---- ENDPOINTS ----

// GET /api/new-player
app.get("/api/new-player", (req, res) => {
  const tag = Math.floor(100000 + Math.random() * 900000).toString();
  return res.json({ tag });
});

// POST /api/score
app.post("/api/score", scoreLimiter, verifySignature, async (req, res) => {
  try {
    const { playerID, playerName, carID, levelID, distance, topSpeed, avgSpeed } = req.body;

    if (typeof playerID !== "string" || typeof playerName !== "string") {
      return res.status(400).json({ error: "Invalid data typing parameters" });
    }

    const cleanPlayerID   = playerID.slice(0, 64).replace(/[^\w\-]/g, "");
    const cleanPlayerName = playerName.slice(0, 32).replace(/[<>"']/g, "");
    const numCarID        = Number(carID);
    const numLevelID      = Number(levelID);
    const numDistance     = Number(distance);
    const numTopSpeed     = Number(topSpeed || 0);
    const numAvgSpeed     = Number(avgSpeed || 0);

    if (!cleanPlayerID || !VALID_CAR_IDS.has(numCarID) || isNaN(numLevelID) || !Number.isFinite(numDistance) || numDistance < 0) {
      return res.status(400).json({ error: "Malformed payload parameter data structure" });
    }

    logsCollection
      .insertOne({ type: "score_submit", playerID: cleanPlayerID, createdAt: new Date() })
      .catch(() => {});

    if (await isPlayerRateLimited(cleanPlayerID)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    const violations = checkPhysicsViolations(numDistance, numTopSpeed, numAvgSpeed, numCarID);
    if (violations.length > 0) {
      await handleCheaterTelemetry(cleanPlayerID, violations);
      return res.json({ ok: true, message: "Score processed", ranks: { distanceGlobalRank: 9999 } });
    }

    const existingScore = await collection.findOne({ playerID: cleanPlayerID, carID: numCarID, levelID: numLevelID });

    if (!existingScore) {
      await collection.insertOne({
        playerID: cleanPlayerID,
        playerName: cleanPlayerName,
        carID: numCarID,
        levelID: numLevelID,
        distance: numDistance,
        topSpeed: numTopSpeed,
        avgSpeed: numAvgSpeed,
        flagged: false,
        createdAt: new Date(),
        lastUpdate: new Date(),
      });
    } else if (numDistance > existingScore.distance) {
      await collection.updateOne(
        { playerID: cleanPlayerID, carID: numCarID, levelID: numLevelID },
        {
          $set: {
            playerName: cleanPlayerName,
            distance: numDistance,
            topSpeed: numTopSpeed,
            avgSpeed: numAvgSpeed,
            lastUpdate: new Date(),
          },
        }
      );
    }

    const activeRank = await calcGlobalRank(numDistance, numLevelID);
    return res.json({ ok: true, message: "Score processed", ranks: { distanceGlobalRank: activeRank } });

  } catch (err) {
    console.error("[score] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/ad-token/:playerID
app.get("/api/ad-token/:playerID", (req, res) => {
  const cleanPlayerID = (req.params.playerID || "").slice(0, 64).replace(/[^\w\-]/g, "");
  if (!cleanPlayerID) return res.status(400).json({ error: "Invalid playerID" });

  const token     = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 3 * 60_000;

  activeAdTokens.set(cleanPlayerID, { token, expiresAt });
  return res.json({ adToken: token });
});

// POST /api/ad-verify
app.post("/api/ad-verify", (req, res) => {
  const { playerID, adToken } = req.body;

  if (!playerID || !adToken) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  const cleanPlayerID = String(playerID).slice(0, 64).replace(/[^\w\-]/g, "");
  const savedData     = activeAdTokens.get(cleanPlayerID);

  if (!savedData || savedData.token !== adToken || Date.now() > savedData.expiresAt) {
    console.warn("[ad-verify] invalid token:", cleanPlayerID);
    return res.status(403).json({ ok: false, error: "Invalid or expired ad token", action: "BOZ" });
  }

  activeAdTokens.delete(cleanPlayerID);
  console.log("[ad-verify] token verified:", cleanPlayerID);
  return res.json({ ok: true });
});

// GET /api/ad-config
app.get("/api/ad-config", (_req, res) => {
  return res.json({ rewardedAdUnit: REWARDED_AD_UNIT });
});

// GET /api/leaderboard/:levelID
app.get("/api/leaderboard/:levelID", async (req, res) => {
  try {
    const numLevelID = Number(req.params.levelID);
    if (isNaN(numLevelID)) return res.status(400).json({ error: "Invalid level ID" });

    const now = Date.now();
    const cache = cachedLeaderboards.get(numLevelID);

    if (cache && now - cache.timestamp < CACHE_TTL_MS) {
      return res.json(cache.data);
    }

    const snapshot = await collection
      .find({ levelID: numLevelID, flagged: false })
      .sort({ distance: -1 })
      .limit(100)
      .project({ _id: 0, playerID: 1, playerName: 1, carID: 1, distance: 1 })
      .toArray();

    cachedLeaderboards.set(numLevelID, { data: snapshot, timestamp: now });

    return res.json(snapshot);
  } catch (err) {
    console.error("[leaderboard] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


// GET /api/stats/:playerID/:carID/:levelID
app.get("/api/stats/:playerID/:carID/:levelID", async (req, res) => {
  try {
    const cleanPlayerID = (req.params.playerID || "").slice(0, 64).replace(/[^\w\-]/g, "");
    const targetCarID   = Number(req.params.carID);
    const targetLevelID = Number(req.params.levelID);

    if (!cleanPlayerID || !VALID_CAR_IDS.has(targetCarID) || isNaN(targetLevelID)) {
      return res.status(400).json({ error: "Invalid target lookup attributes" });
    }

    const [
      globalBestThisCarArray,
      globalBestOverallArray,
      carPersonalBest,
      overallPersonalBestArray,
    ] = await Promise.all([
      collection.find({ carID: targetCarID, levelID: targetLevelID, flagged: false }).sort({ distance: -1 }).limit(1).toArray(),
      collection.find({ levelID: targetLevelID, flagged: false }).sort({ distance: -1 }).limit(1).toArray(),
      collection.findOne({ playerID: cleanPlayerID, carID: targetCarID, levelID: targetLevelID }),
      collection.find({ playerID: cleanPlayerID, levelID: targetLevelID }).sort({ distance: -1 }).limit(1).toArray(),
    ]);

    const globalBestThisCar  = globalBestThisCarArray[0]  || null;
    const globalBestOverall  = globalBestOverallArray[0]  || null;
    const overallPersonalBest = overallPersonalBestArray[0] || null;

    if (carPersonalBest)    delete carPersonalBest._id;
    if (globalBestThisCar)  delete globalBestThisCar._id;
    if (globalBestOverall)  delete globalBestOverall._id;
    if (overallPersonalBest) delete overallPersonalBest._id;

    const carPersonalBestRank     = carPersonalBest && !carPersonalBest.flagged
      ? await calcGlobalRank(carPersonalBest.distance, targetLevelID) : -1;
    const overallPersonalBestRank = overallPersonalBest
      ? await calcGlobalRank(overallPersonalBest.distance, targetLevelID) : -1;
    const globalBestThisCarRank = globalBestThisCar
      ? await calcGlobalRank(globalBestThisCar.distance, targetLevelID) : -1;

    return res.json({
      globalBestThisCar,
      globalBestOverall,
      carPersonalBest,
      overallPersonalBest,
      ranks: {
        carPersonalBestRank,
        overallPersonalBestRank,
        globalBestThisCarRank,
        globalBestOverallRank: 1,
      },
    });
  } catch (err) {
    console.error("[stats] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/stats
app.get("/admin/stats", async (req, res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const rows = await countsCollection.find({}).sort({ total: -1 }).toArray();
    return res.json(rows);
  } catch (err) {
    console.error("[admin/stats] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /ping
app.get("/ping", (_req, res) => res.status(200).send("OK"));

// ---- SHUTDOWN ----

async function gracefulExit() {
  try {
    await client.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);

// ---- BOOT ----

initDatabase()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch((err) => {
    console.error("Fatal boot error:", err);
    process.exit(1);
  });
