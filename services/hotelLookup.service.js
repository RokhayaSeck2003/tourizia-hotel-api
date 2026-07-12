import fetch from "node-fetch";
import { getAmadeusToken } from "./amadeus.service.js";

// ======================================
// HOTELS BY CITY
// ======================================

export async function findHotelsByCity(cityCode) {

    const token = await getAmadeusToken();

    const response = await fetch(

`https://api.amadeus.com/v1/reference-data/locations/hotels/by-city?cityCode=${cityCode}`,

        {

            headers: {

                Authorization:
                    `Bearer ${token}`

            }

        }

    );

    const data = await response.json();

    console.log(
        "🏨 HOTELS BY CITY"
    );

    console.log(
        JSON.stringify(data, null, 2)
    );

    return data.data || [];

}
export async function findCities(keyword){

    const token =
        await getAmadeusToken();

    const response =
        await fetch(

`https://api.amadeus.com/v1/reference-data/locations/cities?keyword=${encodeURIComponent(keyword)}`,

        {

            headers:{

                Authorization:
                `Bearer ${token}`

            }

        }

    );

    const data =
        await response.json();

    return data.data || [];

}