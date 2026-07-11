import express from "express";

import {

    getToken,

    searchHotels,

    searchCities

} from "../controllers/hotel.controller.js";

const router = express.Router();

router.get("/token", getToken);

router.get("/hotel-cities", searchCities);

router.get("/search-hotels", searchHotels);

export default router;