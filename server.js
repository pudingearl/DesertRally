// server.js
import express from "express";
import { MongoClient } from "mongodb";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// === MongoDB Ayarları ===
const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI not set in environment variables");
  process.exit(1);
}

const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
const dbName = process.env.DB_NAME || "RaceGame";
const collectionName = process.env.COLLECTION_NAME || "Leaderboard";

// === Skor Gönderme ===
// Aynı playerID varsa güncelle, yoksa ekle (upsert)
app.post("/api/score", async (req, res) => {
  try {
    const { playerID, playerName, carID, distance } = req.body;

    if (!playerID || !playerName || carID === undefined || distance === undefined) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // Upsert işlemi: Aynı playerID varsa güncelle
    await collection.updateOne(
      { playerID: playerID },
      {
        $set: {
          playerID,
          playerName,
          carID,
          distance,
          lastUpdate: new Date(),
        },
      },
      { upsert: true }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("POST /api/score error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// === Leaderboard Getirme ===
app.get("/api/leaderboard", async (_req, res) => {
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    const docs = await collection
      .find({})
      .sort({ distance: -1 })
      .limit(1000)
      .project({
        _id: 0,
        playerID: 1,
        playerName: 1,
        carID: 1,
        distance: 1,
      })
      .toArray();

    return res.json(docs);
  } catch (err) {
    console.error("GET /api/leaderboard error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// === Test Route ===
app.get("/", (_req, res) => res.send("Race API is up"));

// === Server Başlat ===
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
