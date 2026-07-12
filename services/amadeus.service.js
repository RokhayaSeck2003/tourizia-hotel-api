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

