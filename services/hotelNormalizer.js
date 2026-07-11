export default function hotelNormalizer(hotels = []) {

    return hotels.map(hotel => {

        const offer = hotel.offers?.[0] || {};

        const room = offer.room || {};

        const guests = room.typeEstimated || {};

        const hotelInfo = hotel.hotel || {};

        return {

            // ========================
            // Identité
            // ========================

            id:
                hotel.hotelId ||

                hotelInfo.hotelId ||

                "",

            offerId:
                offer.id || "",

            // ========================
            // Hôtel
            // ========================

            name:
                hotelInfo.name ||

                "Unknown Hotel",

            chainCode:
                hotelInfo.chainCode ||

                "",

            // ========================
            // Adresse
            // ========================

            city:
                hotelInfo.address?.cityName ||

                "",

            country:
                hotelInfo.address?.countryCode ||

                "",

            address:
                hotelInfo.address?.lines?.join(", ") ||

                "",

            latitude:
                hotelInfo.latitude ||

                "",

            longitude:
                hotelInfo.longitude ||

                "",

            // ========================
            // Chambre
            // ========================

            roomType:
                room.type ||

                "",

            roomDescription:
                room.description?.text ||

                "",

            beds:
                guests.beds ||

                "",

            bedType:
                guests.bedType ||

                "",

            // ========================
            // Prix
            // ========================

            price:
                offer.price?.total ||

                "",

            currency:
                offer.price?.currency ||

                "",

            // ========================
            // Pension
            // ========================

            board:
                offer.boardType ||

                "",

            // ========================
            // Services
            // ========================

            amenities:
                hotelInfo.amenities ||

                [],

            // ========================
            // Images
            // ========================

            photos:
                hotelInfo.media ||

                [],

            // ========================
            // Note
            // ========================

            rating:
                hotelInfo.rating ||

                "",

            // ========================
            // Contact
            // ========================

            phone:
                hotelInfo.contact?.phone ||

                "",

            email:
                hotelInfo.contact?.email ||

                "",

            // ========================
            // Brut
            // ========================

            raw: hotel

        };

    });

}