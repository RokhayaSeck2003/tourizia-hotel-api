import {

    getAmadeusToken,

    findHotels,

    findCities

} from "../services/amadeus.service.js";

export async function getToken(req, res) {

    try {

        const token = await getAmadeusToken();

        res.json({

            token

        });

    }

    catch (err) {

        console.log(err);

        res.status(500).json({

            error: err.message

        });

    }

}

export async function searchCities(req, res) {

    try {

        const data = await findCities(req.query.city);

        res.json(data);

    }

    catch (err) {

        console.log(err);

        res.status(500).json({

            error: err.message

        });

    }

}

export async function searchHotels(req, res) {

    try {

        const hotels = await findHotels(req.query);

        res.json(hotels);

    }

    catch (err) {

        console.log(err);

        res.status(500).json({

            error: err.message

        });

    }

}