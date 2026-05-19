// ============================================================
// Race Game Leaderboard API v3.6 (Production Ready - Optimized)
// Node.js + Express + MongoDB — Optimized for 1,500+ DAU
// ============================================================

import express from "express";
import { MongoClient } from "mongodb";
import cors from "cors";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

const REQUIRED_ENV = ["MONGO_URI", "API_SECRET", "ADMIN_KEY"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing critical configuration: ${key}`);
    process.exit(1);
  }
}

const MONGO_URI   = process.env.MONGO_URI;
const API_SECRET  = process.env.API_SECRET;
const ADMIN_KEY   = process.env.ADMIN_KEY;
const DB_NAME     = process.env.DB_NAME || "RaceGame";
const PORT        = parseInt(process.env.PORT || "3000", 10);

const CAR_PHYSICS = {
  0: { distanceCap: 100, speedCap: 200, minRunSecs: 10 },
  1: { distanceCap: 100, speedCap: 200, minRunSecs: 10 },
  2: { distanceCap: 100, speedCap: 200, minRunSecs: 10 },
  3: { distanceCap: 100, speedCap: 200, minRunSecs: 10 },
  4: { distanceCap: 100, speedCap: 200, minRunSecs: 10 },
};
const VALID_CAR_IDS = new Set(Object.keys(CAR_PHYSICS).map(Number));

const seenSignatures = new Set();
setInterval(() => seenSignatures.clear(), 60_000);

let cachedLeaderboard = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000;

const client = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
});

let collection;
let logsCollection;

async function initDatabase() {
  await client.connect();
  const db = client.db(DB_NAME);
  collection = db.collection("Leaderboard");
  logsCollection = db.collection("RequestLogs");

  await collection.createIndex({ playerID: 1, carID: 1 }, { unique: true });
  await collection.createIndex({ flagged: 1, distance: -1 });
  await collection.createIndex({ carID: 1, flagged: 1, distance: -1 });

  await logsCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });
  await logsCollection.createIndex({ type: 1, playerID: 1, createdAt: -1 });

  console.log("✅ Database and indexing definitions finalized successfully.");
}

const app = express();
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "10kb" }));

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

// ---- INTEGRITY MIDDLEWARES ----
function verifySignature(req, res, next) {
  const ts = parseInt(req.headers["x-timestamp"] || "0", 10);
  const sig = (req.headers["x-signature"] || "").toLowerCase().trim();

  if (!ts || !sig) return res.status(401).json({ error: "Unauthorized" });

  const nowSeconds = Date.now() / 1000;
  if (nowSeconds - ts > 60 || ts - nowSeconds > 5) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (seenSignatures.has(sig)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { playerID, carID, distance, topSpeed, avgSpeed } = req.body;
  if (!playerID || carID === undefined || distance === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Güvenli kast işlemi: undefined/null verileri string sızıntısından koruyoruz
  const cleanTopSpeed = topSpeed !== undefined && topSpeed !== null ? Number(topSpeed) : 0;
  const cleanAvgSpeed = avgSpeed !== undefined && avgSpeed !== null ? Number(avgSpeed) : 0;

  // ✅ FIX: Float'ları string'e dönüştür (client'in toString() davranışını match et)
  const topSpeedStr = cleanTopSpeed.toString();
  const avgSpeedStr = cleanAvgSpeed.toString();

  // 🔍 DEBUG LOG
  const messageToSign = `${playerID}:${carID}:${distance}:${topSpeedStr}:${avgSpeedStr}:${ts}`;
  
  const expected = crypto
    .createHmac("sha256", API_SECRET)
    .update(messageToSign)
    .digest("hex");

  console.log("🔍 [SIGNATURE VERIFICATION DEBUG]");
  console.log(`  API_SECRET (FULL): ${API_SECRET}`);
  console.log(`  API_SECRET (length): ${API_SECRET.length}`);
  console.log(`  Received signature: ${sig}`);
  console.log(`  Expected signature: ${expected}`);
  console.log(`  Message to sign: ${messageToSign}`);
  console.log(`  Sig length: ${sig.length}, Expected length: ${expected.length}`);
  console.log(`  Timestamp (server): ${Math.floor(Date.now() / 1000)}, Received: ${ts}`);

  let valid = false;
  try {
    // ✅ FIX: padEnd yerine doğrudan hex buffer karşılaştırması yap
    valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch (err) {
    console.log(`  Buffer conversion error: ${err.message}`);
    valid = false;
  }

  console.log(`  Result: ${valid ? "✅ VALID" : "❌ INVALID"}\n`);

  if (!valid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  seenSignatures.add(sig);
  next();
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
  if (topSpeed > limits.speedCap) violations.push("Velocity threshold exceeded");
  if (avgSpeed > topSpeed) violations.push("Average velocity anomaly detected");
  
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

async function calcGlobalRank(distance) {
  const relativePlacement = await collection.countDocuments({
    flagged: false,
    distance: { $gt: distance },
  });
  return relativePlacement + 1;
}

// ---- ENDPOINT CONTROLLERS ----

// POST /api/score
app.post("/api/score", scoreLimiter, verifySignature, async (req, res) => {
  try {
    const { playerID, playerName, carID, distance, topSpeed, avgSpeed } = req.body;

    if (typeof playerID !== "string" || typeof playerName !== "string") {
      return res.status(400).json({ error: "Invalid data typing parameters" });
    }

    const cleanPlayerID = playerID.slice(0, 64).replace(/[^\w\-]/g, "");
    const cleanPlayerName = playerName.slice(0, 32).replace(/[<>"']/g, "");
    const numCarID = Number(carID);
    const numDistance = Number(distance);
    const numTopSpeed = Number(topSpeed || 0);
    const numAvgSpeed = Number(avgSpeed || 0);

    if (!cleanPlayerID || !VALID_CAR_IDS.has(numCarID) || !Number.isFinite(numDistance) || numDistance < 0) {
      return res.status(400).json({ error: "Malformed payload parameter data structure" });
    }

    // DÜZELTİLDİ: Tanımlama hatası giderildi, loglama artık güvenli tetikleniyor
    logsCollection.insertOne({ type: "score_submit", playerID: cleanPlayerID, createdAt: new Date() }).catch(() => {});

    if (await isPlayerRateLimited(cleanPlayerID)) {
      return res.status(429).json({ error: "Too many requests" });
    }

    const violations = checkPhysicsViolations(numDistance, numTopSpeed, numAvgSpeed, numCarID);
    if (violations.length > 0) {
      await handleCheaterTelemetry(cleanPlayerID, violations);
      return res.json({ ok: true, message: "Score processed", ranks: { distanceGlobalRank: 9999 } });
    }

    const existingScore = await collection.findOne({ playerID: cleanPlayerID, carID: numCarID });

    if (!existingScore) {
      await collection.insertOne({
        playerID: cleanPlayerID,
        playerName: cleanPlayerName,
        carID: numCarID,
        distance: numDistance,
        topSpeed: numTopSpeed,
        avgSpeed: numAvgSpeed,
        flagged: false,
        createdAt: new Date(),
        lastUpdate: new Date()
      });
    } else if (numDistance > existingScore.distance) {
      await collection.updateOne(
        { playerID: cleanPlayerID, carID: numCarID },
        {
          $set: {
            playerName: cleanPlayerName,
            distance: numDistance,
            topSpeed: numTopSpeed,
            avgSpeed: numAvgSpeed,
            lastUpdate: new Date()
          }
        }
      );
    }

    const activeRank = await calcGlobalRank(numDistance);
    return res.json({ ok: true, message: "Score processed", ranks: { distanceGlobalRank: activeRank } });

  } catch (err) {
    console.error("Internal process system trace warning:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/leaderboard
app.get("/api/leaderboard", async (_req, res) => {
  try {
    const currentTick = Date.now();
    if (cachedLeaderboard && currentTick - cacheTimestamp < CACHE_TTL_MS) {
      return res.json(cachedLeaderboard);
    }

    const leaderboardSnapshot = await collection
      .find({ flagged: false })
      .sort({ distance: -1 })
      .limit(100)
      .project({ _id: 0, playerID: 1, playerName: 1, carID: 1, distance: 1 })
      .toArray();

    cachedLeaderboard = leaderboardSnapshot;
    cacheTimestamp = currentTick;

    return res.json(leaderboardSnapshot);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/stats/:playerID/:carID
app.get("/api/stats/:playerID/:carID", async (req, res) => {
  try {
    const cleanPlayerID = (req.params.playerID || "").slice(0, 64).replace(/[^\w\-]/g, "");
    const targetCarID = Number(req.params.carID);

    if (!cleanPlayerID || !VALID_CAR_IDS.has(targetCarID)) {
      return res.status(400).json({ error: "Invalid target lookup attributes" });
    }

    const [
      globalBestThisCarArray,
      globalBestOverallArray,
      carPersonalBest,
      overallPersonalBestArray
    ] = await Promise.all([
      collection.find({ carID: targetCarID, flagged: false }).sort({ distance: -1 }).limit(1).toArray(),
      collection.find({ flagged: false }).sort({ distance: -1 }).limit(1).toArray(),
      collection.findOne({ playerID: cleanPlayerID, carID: targetCarID }),
      collection.find({ playerID: cleanPlayerID }).sort({ distance: -1 }).limit(1).toArray()
    ]);

    const globalBestThisCar = globalBestThisCarArray[0] || null;
    const globalBestOverall = globalBestOverallArray[0] || null;
    const overallPersonalBest = overallPersonalBestArray[0] || null;

    if (carPersonalBest) delete carPersonalBest._id;
    if (globalBestThisCar) delete globalBestThisCar._id;
    if (globalBestOverall) delete globalBestOverall._id;
    if (overallPersonalBest) delete overallPersonalBest._id;

    // OPTİMİZE EDİLDİ: Tek istekte 3 kez ağır sayım yapmak yerine sadece oyuncunun kendi derecelerini sayıyoruz
    const carPersonalBestRank = carPersonalBest && !carPersonalBest.flagged ? await calcGlobalRank(carPersonalBest.distance) : -1;
    const overallPersonalBestRank = overallPersonalBest ? await calcGlobalRank(overallPersonalBest.distance) : -1;

    return res.json({
      globalBestThisCar,
      globalBestOverall,
      carPersonalBest,
      overallPersonalBest,
      ranks: {
        carPersonalBestRank,
        overallPersonalBestRank,
        globalBestThisCarRank: 1, // Performans yükünü azaltmak için 1'e sabitlendi veya arayüzde genel birincilik rütbesi olarak kullanılabilir
        globalBestOverallRank: 1
      }
    });
  } catch (err) {
    console.error("Stats fetch error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /ping
app.get("/ping", (_req, res) => res.status(200).send("OK"));

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

initDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Production live on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Fatal boot collapse:", err);
    process.exit(1);
  });
