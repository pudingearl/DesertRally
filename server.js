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

app.post("/api/score", async (req, res) => {
  try {
    const { playerName, carID, distance } = req.body;
    if (!playerName || carID === undefined || distance === undefined) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    await collection.insertOne({
      playerName,
      carID,
      distance,
      date: new Date()
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    const docs = await collection
      .find({})
      .sort({ distance: -1 })
      .limit(1000)
      .toArray();

    return res.json(docs);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

const port = process.env.PORT;
if (!port) {
  console.error("PORT not set. Exiting.");
  process.exit(1);
}
app.get("/", (_req, res) => res.send("Race API is up"));
app.listen(port, () => console.log(`Server listening on port ${port}`));
