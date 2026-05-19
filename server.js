import express from "express";
import { MongoClient } from "mongodb";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;

if (!uri) {
  console.error("❌ MONGO_URI missing");
  process.exit(1);
}

const client = new MongoClient(uri);

const dbName = process.env.DB_NAME || "RaceGame";
const collectionName = process.env.COLLECTION_NAME || "Leaderboard";

let collection;
let logsCollection;

// =====================================================
// DATABASE INIT
// =====================================================

async function initDatabase() {
  try {
    await client.connect();

    console.log("✅ Mongo connected");

    const db = client.db(dbName);

    collection = db.collection(collectionName);
    logsCollection = db.collection("RequestLogs");
    // Her oyuncu + araba için tek kayıt
    await collection.createIndex(
      { playerID: 1, carID: 1 },
      { unique: true }
    );

    // Leaderboard hızlandırma
    await collection.createIndex({ distance: -1 });

    // Car specific leaderboard hızlandırma
    await collection.createIndex({
      carID: 1,
      distance: -1
    });

    console.log("✅ Indexes created");

  } catch (err) {
    console.error("❌ Database init failed:", err);
  }
}

initDatabase();

// =====================================================
// POST SCORE
// =====================================================

app.post("/api/score", async (req, res) => {
  try {
    const { playerID, playerName, carID, distance, topSpeed, avgSpeed } = req.body;

    if (!playerID || !playerName || carID === undefined || distance === undefined) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (
      distance < 0 || distance > 100000 ||
      topSpeed < 0 || topSpeed > 700 ||
      avgSpeed < 0 || avgSpeed > 700
    ) {
      return res.status(400).json({ error: "Invalid score values" });
    }

    // ---- Rank hesaplama helper ----
    async function calcRanks(dist) {
      const better = await collection.countDocuments({ distance: { $gt: dist } });
      return { distanceGlobalRank: better + 1 };
    }
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    req.ip;
  
  await logsCollection.insertOne({
  
    type: "score_submit",
  
    playerID,
    playerName,
    carID,
    distance,
  
    ip,
  
    referer: req.headers.referer || null,
    origin: req.headers.origin || null,
  
    userAgent: req.headers["user-agent"] || null,
  
    createdAt: new Date()
  
  });
    const existing = await collection.findOne({ playerID, carID });

    if (!existing) {
      await collection.insertOne({
        playerID, playerName, carID,
        distance, topSpeed, avgSpeed,
        createdAt: new Date(), lastUpdate: new Date()
      });

      const ranks = await calcRanks(distance, carID);
      return res.json({ ok: true, message: "New score inserted", ranks });
    }

    if (distance > existing.distance) {
      await collection.updateOne(
        { playerID, carID },
        { $set: { playerName, distance, topSpeed, avgSpeed, lastUpdate: new Date() } }
      );

      const ranks = await calcRanks(distance, carID);
      return res.json({ ok: true, message: "Score updated", ranks });
    }

    // Daha kötü skor — yine de bu run'ın rankını döndür
    const ranks = await calcRanks(distance, carID);
    return res.json({ ok: true, message: "Score not improved", ranks });

  } catch (err) {
    console.error("❌ /api/score error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// =====================================================
// PLAYER STATS
// =====================================================

app.get("/api/stats/:playerID/:carID", async (req, res) => {
  try {
    const playerID = req.params.playerID;
    const carID    = Number(req.params.carID);

    // Global rank helper — tüm arabalara karşı
    async function globalRank(dist) {
      const better = await collection.countDocuments({ distance: { $gt: dist } });
      return better + 1;
    }

    // Paralel sorgular
    const [
      globalBestThisCarArr,
      globalBestOverallArr,
      carPersonalBest,
      overallPersonalBestArr
    ] = await Promise.all([
      collection.find({ carID }).sort({ distance: -1 }).limit(1).toArray(),
      collection.find({}).sort({ distance: -1 }).limit(1).toArray(),
      collection.findOne({ playerID, carID }),
      collection.find({ playerID }).sort({ distance: -1 }).limit(1).toArray()
    ]);

    const globalBestThisCar  = globalBestThisCarArr[0]  || null;
    const globalBestOverall  = globalBestOverallArr[0]  || null;
    const overallPersonalBest = overallPersonalBestArr[0] || null;

    // =====================================================
    // RANKS — hepsi global
    // =====================================================

    const [
      carPersonalBestRank,
      overallPersonalBestRank,
      globalBestThisCarRank
    ] = await Promise.all([
      carPersonalBest   ? globalRank(carPersonalBest.distance)   : Promise.resolve(null),
      overallPersonalBest ? globalRank(overallPersonalBest.distance) : Promise.resolve(null),
      globalBestThisCar ? globalRank(globalBestThisCar.distance) : Promise.resolve(null)
    ]);

    return res.json({
      globalBestThisCar,
      globalBestOverall,
      carPersonalBest,
      overallPersonalBest,
      ranks: {
        carPersonalBestRank,       // carPersonalBest'in global rankı
        overallPersonalBestRank,   // overallPersonalBest'in global rankı
        globalBestThisCarRank,     // bu arabanın global #1'inin global rankı
        globalBestOverallRank: 1   // her zaman #1
      }
    });

  } catch (err) {
    console.error("❌ /api/stats error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// =====================================================
// LEADERBOARD
// =====================================================

app.get("/api/leaderboard", async (_req, res) => {

  try {

    const docs = await collection.find({})
    .sort({ distance: -1 })
    .limit(999)
    .project({
      _id: 0,
      playerName: 1,
      carID: 1,
      distance: 1,
      topSpeed: 1,
      avgSpeed: 1
    })
    .toArray();

    return res.json(docs);

  } catch (err) {

    console.error("❌ /api/leaderboard error:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
});

// =====================================================
// ROOT
// =====================================================

app.get("/", (_req, res) => {
  res.send("Race API running ✅");
});

// =====================================================
// PING
// =====================================================

app.get("/ping", (_req, res) => {
  res.status(200).send("OK");
});

// =====================================================
// START SERVER
// =====================================================

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`✅ Server listening on ${port}`);
});
