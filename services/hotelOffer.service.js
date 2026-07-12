import fetch from "node-fetch";

import { getAmadeusToken }

from "./amadeus.service.js";

import { findHotelsByCity }

from "./hotelLookup.service.js";

import hotelNormalizer

from "./hotelNormalizer.js";

// ======================================
// HOTEL OFFERS
// ======================================

export async function searchHotelOffers(params) {

    const {

        city,

        checkIn,

        checkOut,

        adults = 1

    } = params;

    if (!city)
        throw new Error("City missing");

    const hotels =

        await findHotelsByCity(city);

    console.log(
        "HOTELS FOUND:",
        hotels.length
    );

    if (!hotels.length)
        return [];

    const hotelIds =

        hotels

        .slice(0,20)

        .map(h => h.hotelId)

        .join(",");

    console.log(
        "HOTEL IDS:",
        hotelIds
    );

    const token =

        await getAmadeusToken();

    const url =

`https://api.amadeus.com/v3/shopping/hotel-offers?hotelIds=${hotelIds}&checkInDate=${checkIn}&checkOutDate=${checkOut}&adults=${adults}`;

    console.log(url);

    const response =

        await fetch(url,{

            headers:{

                Authorization:
                `Bearer ${token}`

            }

        });

    const data =
        await response.json();

    console.log(
        JSON.stringify(data,null,2)
    );

    if(data.errors){

        console.log(
            "AMADEUS HOTEL OFFER ERROR"
        );

        return [];

    }

    return hotelNormalizer(
        data.data || []
    );

}