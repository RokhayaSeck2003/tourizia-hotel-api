import fetch from "node-fetch";
import hotelNormalizer from "./hotelNormalizer.js";
let amadeusToken = null;
let amadeusExpire = 0;

// ======================================
// TOKEN
// ======================================

export async function getAmadeusToken() {

    if (
        amadeusToken &&
        Date.now() < amadeusExpire
    ) {
        return amadeusToken;
    }

    try {

        const response = await fetch(

            "https://api.amadeus.com/v1/security/oauth2/token",

            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },

                body: new URLSearchParams({

                    grant_type: "client_credentials",

                    client_id:
                        process.env.AMADEUS_API_KEY,

                    client_secret:
                        process.env.AMADEUS_API_SECRET

                })

            }

        );

        const data = await response.json();

        console.log("AMADEUS TOKEN RESPONSE:", data);

        if (!data.access_token) {

            throw new Error(
                JSON.stringify(data)
            );

        }

        amadeusToken = data.access_token;

        amadeusExpire =
            Date.now() +
            (data.expires_in * 1000);

        console.log("✅ AMADEUS TOKEN OK");

        return amadeusToken;

    } catch (err) {

        console.log("❌ AMADEUS AUTH ERROR");
        console.log(err);

        throw err;

    }

}
// ======================================
// SEARCH CITY
// ======================================

export async function findCities(keyword) {

    const token =
        await getAmadeusToken();
        console.log("API KEY :", process.env.AMADEUS_API_KEY);
console.log("API SECRET :", process.env.AMADEUS_API_SECRET);

    const response = await fetch(

`https://test.api.amadeus.com/v1/reference-data/locations/cities?keyword=${encodeURIComponent(keyword)}`,

        {

            headers: {
                Authorization:
                    `Bearer ${token}`
            }

        }

    );

    const data = await response.json();

console.log(
    "AMADEUS HOTELS:",
    data.data?.length || 0
);

return hotelNormalizer(
    data.data || []
);

}
// ======================================
// SEARCH HOTELS
// ======================================

export async function findHotels(params) {

    const token = await getAmadeusToken();

    const {

        city,

        checkIn,

        checkOut,

        adults = 1

    } = params;

    if (!city || !checkIn || !checkOut) {

        throw new Error("Missing required parameters");

    }

    const url =
`https://api.amadeus.com/v3/shopping/hotel-offers?cityCode=${city}&checkInDate=${checkIn}&checkOutDate=${checkOut}&adults=${adults}`;

    console.log("");
    console.log("🏨 HOTEL SEARCH");
    console.log(url);
    console.log("");

    const response = await fetch(url, {

        headers: {

            Authorization: `Bearer ${token}`

        }

    });

    const data = await response.json();

    if (data.errors) {

        console.log("AMADEUS ERROR");
        console.log(JSON.stringify(data, null, 2));

        return [];

    }

    console.log(
        "✅ HOTELS FOUND:",
        data.data?.length || 0
    );

    return hotelNormalizer(data.data || []);

}