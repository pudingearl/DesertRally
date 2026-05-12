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

// =====================================================
// DATABASE INIT
// =====================================================

async function initDatabase() {
  try {
    await client.connect();

    console.log("✅ Mongo connected");

    const db = client.db(dbName);

    collection = db.collection(collectionName);

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

    const {
      playerID,
      playerName,
      carID,
      distance,
      topSpeed,
      avgSpeed
    } = req.body;

    // ---------------- VALIDATION ----------------

    if (
      !playerID ||
      !playerName ||
      carID === undefined ||
      distance === undefined
    ) {
      return res.status(400).json({
        error: "Missing fields"
      });
    }

    // Basit anti-cheat
    if (
      distance < 0 ||
      distance > 100000 ||
      topSpeed < 0 ||
      topSpeed > 700 ||
      avgSpeed < 0 ||
      avgSpeed > 700
    ) {
      return res.status(400).json({
        error: "Invalid score values"
      });
    }

    // ---------------- EXISTING SCORE ----------------

    const existing = await collection.findOne({
      playerID,
      carID
    });

    // Yeni kayıt
    if (!existing) {

      await collection.insertOne({
        playerID,
        playerName,
        carID,
        distance,
        topSpeed,
        avgSpeed,
        createdAt: new Date(),
        lastUpdate: new Date()
      });

      return res.json({
        ok: true,
        message: "New score inserted"
      });
    }

    // Daha iyi skor geldiyse update
    if (distance > existing.distance) {

      await collection.updateOne(
        { playerID, carID },
        {
          $set: {
            playerName,
            distance,
            topSpeed,
            avgSpeed,
            lastUpdate: new Date()
          }
        }
      );

      return res.json({
        ok: true,
        message: "Score updated"
      });
    }

    // Daha kötü skor
    return res.json({
      ok: true,
      message: "Score not improved"
    });

  } catch (err) {

    console.error("❌ /api/score error:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
});

// =====================================================
// PLAYER STATS
// =====================================================

app.get("/api/stats/:playerID/:carID", async (req, res) => {

  try {

    const playerID = req.params.playerID;
    const carID = Number(req.params.carID);

    // ---------------- GLOBAL BEST (THIS CAR) ----------------

    const globalBest = await collection.find({
      carID
    })
    .sort({ distance: -1 })
    .limit(1)
    .toArray();

    // ---------------- PLAYER BEST (THIS CAR) ----------------

    const personalBest = await collection.findOne({
      playerID,
      carID
    });

    // ---------------- PLAYER OVERALL BEST ----------------

    const overallBest = await collection.find({
      playerID
    })
    .sort({ distance: -1 })
    .limit(1)
    .toArray();

    // Eğer oyuncunun kaydı yoksa
    if (!personalBest) {

      return res.json({
        globalBest: globalBest[0] || null,
        carPersonalBest: null,
        overallPersonalBest: overallBest[0] || null,
        ranks: null
      });
    }

    // ---------------- RANKS ----------------

    const betterCarScores = await collection.countDocuments({
      carID,
      distance: {
        $gt: personalBest.distance
      }
    });

    const betterGlobalScores = await collection.countDocuments({
      distance: {
        $gt: personalBest.distance
      }
    });

    return res.json({

      globalBest: globalBest[0] || null,

      carPersonalBest: personalBest || null,

      overallPersonalBest: overallBest[0] || null,

      ranks: {

        distanceCarRank:
          betterCarScores + 1,

        distanceGlobalRank:
          betterGlobalScores + 1
      }
    });

  } catch (err) {

    console.error("❌ /api/stats error:", err);

    return res.status(500).json({
      error: "Server error"
    });
  }
});

// =====================================================
// LEADERBOARD
// =====================================================

app.get("/api/leaderboard", async (_req, res) => {

  try {

    const docs = await collection.find({})
    .sort({ distance: -1 })
    .limit(100)
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
