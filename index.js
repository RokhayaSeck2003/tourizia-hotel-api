import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import helmet from "helmet";

import hotelRoutes from "./routes/hotel.routes.js";

dotenv.config();

const app = express();

app.use(cors());

app.use(express.json());

app.use(helmet());

// MongoDB
mongoose.connect(process.env.MONGO_URI);

mongoose.connection.once("open", () => {

    console.log("✅ MongoDB connected");

});

// Routes
app.use("/api", hotelRoutes);

// Route test
app.get("/", (req, res) => {

    res.json({

        api: "Tourizia Hotel API",

        status: "online"

    });

});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {

    console.log("");
    console.log("🏨 TOURIZIA HOTEL API");
    console.log("Server running on port", PORT);
    console.log("");

});