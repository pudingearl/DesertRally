// server.js
import express from "express";
import { MongoClient } from "mongodb";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI not set in environment variables");
  process.exit(1);
}

const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
const dbName = process.env.DB_NAME || "RaceGame";
const collectionName = process.env.COLLECTION_NAME || "Leaderboard";

async function initIndexes() {
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // Benzersiz index (her oyuncu ve araba kombinasyonu için)
    await collection.createIndex({ playerID: 1, carID: 1 }, { unique: true });
    console.log("✅ Unique index created on (playerID, carID)");
  } catch (err) {
    console.error("Index creation failed:", err);
  }
}
initIndexes();

// ✅ POST /api/score — insert or update
app.post("/api/score", async (req, res) => {
  try {
    const { playerID, playerName, carID, distance } = req.body;
    if (!playerID || !playerName || carID === undefined || distance === undefined) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // Eğer bu (playerID, carID) varsa distance güncelle, yoksa yeni ekle
    const result = await collection.updateOne(
      { playerID, carID },
      {
        $set: {
          playerName,
          distance,
          lastUpdate: new Date()
        }
      },
      { upsert: true }
    );

    return res.status(200).json({ ok: true, upserted: result.upsertedId });
  } catch (err) {
    console.error("Error in /api/score:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ GET /api/leaderboard — tüm kayıtlar (distance'a göre sıralı)
app.get("/api/leaderboard", async (_req, res) => {
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    const docs = await collection.find({})
      .sort({ distance: -1 })
      .limit(1000)
      .toArray();

    return res.json(docs);
  } catch (err) {
    console.error("Error in /api/leaderboard:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ Root kontrol
app.get("/", (_req, res) => res.send("Race API is running ✅"));

// ✅ Port dinleme
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
