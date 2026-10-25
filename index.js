// ============================================================
// TOURIZIA — HOTEL API
// Provider : LiteAPI
// Backend  : Node.js / Express
// ============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import { Resend } from "resend";
import { v2 as cloudinary } from "cloudinary";
import puppeteer from "puppeteer-core";
import { MongoClient } from "mongodb";
// ============================================================
// 💳 PAYTECH HOTEL IPN
// ============================================================

import crypto from "crypto";

dotenv.config();

// ============================================================
// 🗄️ TOURIZIA — MONGODB
// ============================================================

const MONGODB_URI =
    process.env.MONGODB_URI;

const MONGODB_DB =
    process.env.MONGODB_DB ||
    "tourizia";

let mongoClient = null;
let mongoDb = null;
let hotelTransactions = null;
let stripeWebhookEvents = null;

// ============================================================
// CONNEXION MONGODB
// ============================================================

async function connectMongoDB() {

    if (!MONGODB_URI) {

        console.error(
            "❌ MONGODB_URI manquant"
        );

        return;
    }

    try {

        mongoClient =
            new MongoClient(
                MONGODB_URI
            );

        await mongoClient.connect();

        mongoDb =
            mongoClient.db(
                MONGODB_DB
            );

        hotelTransactions =
            mongoDb.collection(
                "hotel_transactions"
            );

stripeWebhookEvents = mongoDb.collection(
  "stripeWebhookEvents"
);

await stripeWebhookEvents.createIndex(
  { eventId: 1 },
  { unique: true }
);

console.log("✅ Index anti-doublon Stripe hôtel prêt");


        await hotelTransactions.createIndex(
            {
                transactionId: 1
            },
            {
                unique: true
            }
        );

        await hotelTransactions.createIndex({
            paymentId: 1
        });

        await hotelTransactions.createIndex({
            status: 1
        });

        await hotelTransactions.createIndex({
            createdAt: -1
        });

        console.log(
            "✅ MongoDB connecté — Tourizia"
        );

    } catch (error) {

        console.error(
            "❌ MongoDB CONNECTION ERROR:",
            error
        );

    }

}
// ============================================================
// 🧾 TOURIZIA — STATUTS TRANSACTIONS
// ============================================================

const HOTEL_TRANSACTION_STATUS = {

    PAYMENT_PENDING:
        "PAYMENT_PENDING",

    PAID:
        "PAID",

    SEARCHING:
        "SEARCHING",

    OFFER_FOUND:
        "OFFER_FOUND",

    PREBOOKED:
        "PREBOOKED",

    BOOKED:
        "BOOKED",

    CONFIRMED:
        "CONFIRMED",

    MANUAL_SEARCH_REQUIRED:
        "MANUAL_SEARCH_REQUIRED",

    ERROR:
        "ERROR"

};


// ============================================================
// 🔑 GÉNÉRER ID TRANSACTION
// ============================================================

function generateHotelTransactionId() {

    return (
        "TZTX-" +
        Date.now().toString(36).toUpperCase() +
        "-" +
        Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase()
    );

}


// ============================================================
// 🧾 CRÉER TRANSACTION
// ============================================================

async function createHotelTransaction(
    data,
    transactionId = generateHotelTransactionId()
) {

    if (!hotelTransactions) {

        console.warn(
            "⚠️ MongoDB indisponible — transaction non enregistrée"
        );

        return null;
    }


    const now =
        new Date();

    const transaction = {

        transactionId,

        type:
            "hotel",

        status:
            HOTEL_TRANSACTION_STATUS.PAYMENT_PENDING,

        payment: {

            method:
                data.paymentMethod || null,

            paymentId:
                null,

            stripeSessionId:
                null,

            paytechReference:
                null,

            amount:
                null,

            currency:
                null

        },

        customer: {

            fullName:
                data.fullName || "",

            email:
                data.email || "",

            phone:
                data.phone || ""

        },

        request: {

            city:
                data.city || "",

            countryCode:
                data.countryCode || "",

            checkIn:
                data.checkIn || "",

            checkOut:
                data.checkOut || "",

            adults:
                Number(data.adults || 0),

            children:
                Number(data.children || 0),

            rooms:
                Number(data.rooms || 1),

            guestNationality:
                data.guestNationality || "SN",

            guests:
                Array.isArray(data.guests)
                    ? data.guests
                    : []

        },

       provider: {

    name: "LiteAPI",

    hotelId: null,
    hotelName: null,
    roomName: null,
    offerId: null,
    prebookId: null,
    bookingId: null,
    confirmationNumber: null,
    price: null,
    currency: null

},

cancellation: {

    allowed: true,
    deadline: null,
    policy: null,
    status: "ACTIVE",
    cancelledAt: null,
    providerCancellationId: null

},

error: null,

        history: [

            {

                status:
                    HOTEL_TRANSACTION_STATUS.PAYMENT_PENDING,

                at:
                    now

            }

        ],

        createdAt:
            now,

        updatedAt:
            now

    };

    await hotelTransactions.insertOne(
        transaction
    );

    console.log(
        "🧾 TRANSACTION CRÉÉE:",
        transactionId
    );

    return transactionId;

}
async function updateHotelTransactionStatus(
    transactionId,
    status,
    extra = {}
) {

    if (
        !hotelTransactions ||
        !transactionId
    ) {
        return;
    }

    const now =
        new Date();

    const update = {

        $set: {

            status,

            updatedAt:
                now,

            ...extra

        },

        $push: {

            history: {

                status,

                at:
                    now

            }

        }

    };

    await hotelTransactions.updateOne(
        {
            transactionId
        },
        update
    );

    console.log(
        `📊 TRANSACTION ${transactionId} → ${status}`
    );

}
// ============================================================
// 🔄 MISE À JOUR DES INFORMATIONS TRANSACTION
// ============================================================

async function updateHotelTransaction(
    transactionId,
    fields = {}
) {

    if (
        !hotelTransactions ||
        !transactionId
    ) {
        return;
    }

    await hotelTransactions.updateOne(
        {
            transactionId
        },
        {
            $set: {

                ...fields,

                updatedAt:
                    new Date()

            }
        }
    );

}

const app = express();

const PORT = process.env.PORT || 10000;

const LITEAPI_BASE_URL =
    process.env.LITEAPI_BASE_URL ||
    "https://api.liteapi.travel/v3.0";

const LITEAPI_BOOKING_URL =
    "https://book.liteapi.travel/v3.0";

const LITEAPI_API_KEY =
    process.env.LITEAPI_API_KEY;

const PAYTECH_API_KEY =
    process.env.PAYTECH_API_KEY;

const PAYTECH_API_SECRET =
    process.env.PAYTECH_API_SECRET;

const PAYTECH_ENV =
    process.env.PAYTECH_ENV || "prod";

const LITEAPI_PAYMENT_METHOD =
    process.env.LITEAPI_PAYMENT_METHOD ||
    "ACC_CREDIT_CARD";

// ============================================================
// STRIPE
// ============================================================

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

const HOTEL_STRIPE_PRICE = 1500; // USD 15

const HOTEL_PAYTECH_PRICE = 100; // XOF 8 500
// ============================================================
// OFFRES HÔTEL EN ATTENTE DE PAIEMENT STRIPE
// ============================================================

const pendingHotelPayments = new Map();
// ============================================================
// CORS
// ============================================================

app.use(
    cors({
        origin: [
            "https://tourizia.com",
            "https://www.tourizia.com"
        ],
        methods: [
            "GET",
            "POST",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
    })
);

app.post(
    "/stripe-hotel-webhook",
    express.raw({
        type: "application/json"
    }),
    async (req, res) => {

        console.log(
            "💳🔥 STRIPE HOTEL WEBHOOK"
        );

        if (!stripe) {

            console.error(
                "❌ Stripe non configuré"
            );

            return res.status(500).send(
                "Stripe not configured"
            );

        }

        const signature =
            req.headers[
                "stripe-signature"
            ];

        const webhookSecret =
            process.env
                .STRIPE_HOTEL_WEBHOOK_SECRET;

        if (!webhookSecret) {

            console.error(
                "❌ STRIPE_HOTEL_WEBHOOK_SECRET manquant"
            );

            return res.status(500).send(
                "Webhook secret not configured"
            );

        }

        let event;

        // ----------------------------------------------------
        // VÉRIFICATION SIGNATURE STRIPE
        // ----------------------------------------------------

        try {

            event =
                stripe.webhooks.constructEvent(
                    req.body,
                    signature,
                    webhookSecret
                );

        } catch (error) {

            console.error(
                "❌ STRIPE WEBHOOK SIGNATURE ERROR:",
                error.message
            );

            return res.status(400).send(
                `Webhook Error: ${error.message}`
            );

        }

        console.log(
            "💳 STRIPE EVENT:",
            event.type
        );

        // ----------------------------------------------------
        // CHECKOUT TERMINÉ
        // ----------------------------------------------------

        if (
            event.type !==
            "checkout.session.completed"
        ) {

            /*
             * Stripe peut envoyer plusieurs types
             * d'événements.
             *
             * Pour notre MVP hôtel,
             * seul checkout.session.completed
             * nous intéresse ici.
             */

            return res.json({
                received: true
            });

        }

        const session =
            event.data.object;
            const metadata =
    session.metadata || {};

const transactionId =
    metadata.transactionId || null;

    await updateHotelTransactionStatus(
    transactionId,
    HOTEL_TRANSACTION_STATUS.PAID,
    {
        "payment.paymentId":
            session.payment_intent ||
            session.id,

        "payment.stripeSessionId":
            session.id,

        "payment.amount":
            session.amount_total
                ? session.amount_total / 100
                : null,

        "payment.currency":
            session.currency || "usd"
    }
);

        // ----------------------------------------------------
        // VÉRIFICATION PAIEMENT
        // ----------------------------------------------------

        if (
            session.payment_status !==
            "paid"
        ) {

            console.log(
                "⏳ PAIEMENT STRIPE PAS ENCORE PAYÉ:",
                session.payment_status
            );

            return res.json({
                received: true
            });

        }

        


        // ----------------------------------------------------
        // VÉRIFICATION TYPE
        // ----------------------------------------------------

        if (
            metadata.type !==
            "hotel"
        ) {

            console.log(
                "⚠️ Stripe event non hôtel"
            );

            return res.json({
                received: true
            });

        }

        // ----------------------------------------------------
        // IDENTIFIANT PAIEMENT
        // ----------------------------------------------------

        const paymentId =
            metadata.paymentId ||
            session.id;

        // ----------------------------------------------------
        // ANTI-DOUBLE TRAITEMENT
        // ----------------------------------------------------


        // ----------------------------------------------------
        // DONNÉES RÉSERVATION
        // ----------------------------------------------------

        const offerToken =
    metadata.offerToken;

const pendingPayment =
    offerToken
        ? pendingHotelPayments.get(offerToken)
        : null;

        const hotelData = {

    paymentId,

    stripeSessionId:
        session.id,

    paymentMethod:
        "stripe",

        transactionId:
    transactionId,

    email:
        metadata.email ||
        session.customer_email,

    fullName:
        metadata.fullName ||
        "",

    city:
        metadata.city,

    countryCode:
        metadata.countryCode ||
        "FR",

    checkIn:
        metadata.checkIn,

    checkOut:
        metadata.checkOut,

    adults:
        Number(
            metadata.adults ||
            2
        ),

    children:
        Number(
            metadata.children ||
            0
        ),

    rooms:
        Number(
            metadata.rooms ||
            1
        ),

    guestNationality:
        metadata.guestNationality ||
        "SN",
        guests:
    Array.isArray(
        pendingPayment?.data?.guests
    )
        ? pendingPayment.data.guests
        : [],
        totalPersons:
    Number(metadata.adults || 0) +
    Number(metadata.children || 0),
    

    // -----------------------------------------------
// 🔐 AUCUNE OFFRE AVANT PAIEMENT
// -----------------------------------------------
// LiteAPI sera interrogé uniquement
// après confirmation du paiement.

hotelId: null,

hotelName: null,

roomName: null,

refundable: null,

offerId: null,

providerPrice: null,

providerCurrency: null

        };

        console.log(
            "======================================"
        );

        console.log(
            "✅ HOTEL PAYMENT CONFIRMÉ"
        );

        console.log(
            "PAYMENT:",
            paymentId
        );

        console.log(
            "CUSTOMER:",
            hotelData.email
        );

        console.log(
            "CITY:",
            hotelData.city
        );

        console.log(
            "OFFER:",
            hotelData.offerId
        );

        console.log(
            "======================================"
        );

        /*
         * On répond rapidement à Stripe.
         *
         * La réservation LiteAPI est ensuite
         * traitée côté serveur.
         */

        res.json({
            received: true
        });

        // ----------------------------------------------------
        // FINALISATION RÉSERVATION
        // ----------------------------------------------------

        processHotelAfterPayment(
            hotelData
        ).catch(error => {

            console.error(
                "❌ HOTEL POST-PAYMENT ERROR:",
                error
            );

        });

    }
);
// ============================================================
// EXPRESS JSON
// ============================================================
// Doit être après le webhook Stripe RAW
// pour que toutes les routes POST suivantes
// puissent lire req.body.
// ============================================================

app.use(express.json());
// ============================================================
// 🏨 STATUT TRANSACTION HÔTEL
// ============================================================

app.get("/api/hotel-transaction-status", async (req, res) => {

    try {

        const transactionId =
            req.query.transactionId;

        if (!transactionId) {
            return res.status(400).json({
                success: false,
                error: "transactionId manquant"
            });
        }

        if (!hotelTransactions) {
            return res.status(503).json({
                success: false,
                error: "MongoDB indisponible"
            });
        }

        const transaction =
            await hotelTransactions.findOne(
                { transactionId },
                {
                    projection: {
                        transactionId: 1,
                        status: 1,
                        provider: 1,
                        error: 1,
                        updatedAt: 1
                    }
                }
            );

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: "Transaction introuvable"
            });
        }

        return res.json({
            success: true,
            transactionId:
                transaction.transactionId,
            status:
                transaction.status,
            provider:
                transaction.provider,
            error:
                transaction.error || null
        });

    } catch (error) {

        console.error(
            "❌ HOTEL STATUS ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            error: "Erreur serveur"
        });
    }
});
// ============================================================
// LITEAPI HEADERS
// ============================================================

const liteApiHeaders = {
    "X-API-Key": LITEAPI_API_KEY,
    "Content-Type": "application/json"
};

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {

    res.json({
        api: "Tourizia Hotel API",
        provider: "LiteAPI",
        status: "online"
    });

});

// ============================================================
// TEST AUTHENTIFICATION LITEAPI
// ============================================================

app.get("/api/test-liteapi", async (req, res) => {

    try {

        const response = await fetch(
            `${LITEAPI_BASE_URL}/data/countries`,
            {
                method: "GET",
                headers: {
                    "X-API-Key": LITEAPI_API_KEY
                }
            }
        );

        const data = await response.json();

        console.log(
            "🌍 LITEAPI AUTH STATUS:",
            response.status
        );

        res.status(response.status).json({
            success: response.ok,
            status: response.status,
            data
        });

    } catch (error) {

        console.error(
            "❌ LITEAPI AUTH ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

// ============================================================
// VALIDATION HOTEL
// ============================================================

function validateHotelRequest(data) {

    const {
        city,
        countryCode,
        checkIn,
        checkOut,
        adults,
        children,
        rooms
    } = data;

    if (!city) {
        return "Ville hôtel manquante";
    }

    if (!countryCode) {
        return "Code pays manquant";
    }

    if (!checkIn) {
        return "Date check-in manquante";
    }

    if (!checkOut) {
        return "Date check-out manquante";
    }

    if (
        new Date(checkOut) <=
        new Date(checkIn)
    ) {
        return "La date de départ doit être après la date d'arrivée";
    }

    if (
        !Number.isInteger(
            Number(adults)
        ) ||
        Number(adults) < 1
    ) {
        return "Nombre d'adultes invalide";
    }

    if (
        !Number.isInteger(
            Number(rooms)
        ) ||
        Number(rooms) < 1
    ) {
        return "Nombre de chambres invalide";
    }

    if (
        children !== undefined &&
        Number(children) < 0
    ) {
        return "Nombre d'enfants invalide";
    }

    return null;
}

// ============================================================
// CONVERSION ENFANTS
// LiteAPI attend un tableau d'âges
// ============================================================

function buildChildrenAges(childrenCount) {

    const count =
        Math.max(
            0,
            Number(childrenCount || 0)
        );

    /*
     * Pour le MVP :
     * chaque enfant est envoyé avec l'âge 8.
     *
     * Plus tard :
     * le frontend pourra demander
     * l'âge exact de chaque enfant.
     */

    return Array.from(
        {
            length: count
        },
        () => 8
    );

}
// ============================================================
// 🏨 RÉCUPÉRER LES DÉTAILS OFFICIELS DE L'HÔTEL VIA LITEAPI
// ============================================================

async function getLiteApiHotelDetails(hotelId) {

    if (!hotelId) {
        throw new Error("hotelId LiteAPI manquant");
    }

    const url =
        `${LITEAPI_BASE_URL}/data/hotel` +
        `?hotelId=${encodeURIComponent(hotelId)}` +
        `&language=fr`;

    const response = await fetch(url, {
        method: "GET",
        headers: liteApiHeaders
    });

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            result.message ||
            result.error ||
            "Impossible de récupérer les détails de l'hôtel"
        );
    }

    return result.data || result;
}


// ============================================================
// 📍 CONSTRUIRE L'ADRESSE COMPLÈTE
// ============================================================

function formatLiteApiHotelAddress(hotel = {}) {

    const toText = value => {

        if (typeof value === "string") {
            return value.trim();
        }

        if (value && typeof value === "object") {
            return (
                value.formattedAddress ||
                value.fullAddress ||
                value.address ||
                value.label ||
                ""
            ).toString().trim();
        }

        return "";
    };

    const street =
        toText(hotel.address) ||
        toText(hotel.addressLine) ||
        toText(hotel.address1) ||
        toText(hotel.street) ||
        toText(hotel.location?.address);

    // Une ville seule n'est PAS une adresse précise.
    if (!street) {
        return "";
    }

    const parts = [
        street,
        toText(hotel.zip || hotel.postalCode),
        toText(hotel.city || hotel.city_name),
        toText(hotel.countryName || hotel.country || hotel.country_code)
    ].filter(Boolean);

    return [
        ...new Map(
            parts.map(part => [
                part.toLowerCase(),
                part
            ])
        ).values()
    ].join(", ");
}
// ============================================================
// RECHERCHE DES OFFRES LITEAPI
// ============================================================

async function searchHotelOffers(
    data,
    refundableOnly = true,
    allowFallback = true
) {

    const validation =
        validateHotelRequest(data);

    if (validation) {

        throw new Error(validation);

    }

    const adults =
        Number(data.adults || 2);

    const rooms =
        Number(data.rooms || 1);

    const children =
        Number(data.children || 0);
        // ----------------------------------------------------
// 🛡️ VALIDATION DES CHAMBRES
// ----------------------------------------------------

if (rooms > adults) {
    throw new Error(
        "Le nombre de chambres ne peut pas dépasser le nombre d'adultes."
    );
}

    const occupancies = [];

let remainingAdults = adults;
let remainingChildren = children;

for (let i = 0; i < rooms; i++) {

    const roomsLeft = rooms - i;

    // Répartition équilibrée des adultes
    const roomAdults = Math.ceil(
        remainingAdults / roomsLeft
    );

    // Répartition équilibrée des enfants
    const roomChildren = Math.ceil(
        remainingChildren / roomsLeft
    );

    occupancies.push({
        adults: roomAdults,
        children: buildChildrenAges(
            roomChildren
        )
    });

    remainingAdults -= roomAdults;
    remainingChildren -= roomChildren;
}

    const requestBody = {

    checkin:
        data.checkIn,

    checkout:
        data.checkOut,

    currency:
        "EUR",

    guestNationality:
        data.guestNationality || "SN",

    occupancies,

    // Demander à LiteAPI uniquement les tarifs remboursables.
   refundableRatesOnly: refundableOnly,


    roomMapping:
        true,

    maxRatesPerHotel: 5,

    includeHotelData:
        true

};


// ========================================================
// 🏨 RECHERCHE PAR HÔTEL OU PAR VILLE
// ========================================================

if (data.hotelId) {

    // Client a choisi un hôtel précis
    requestBody.hotelIds = [
        data.hotelId
    ];

    console.log(
        "🏨 RECHERCHE HÔTEL PAR ID:",
        data.hotelId
    );

} else {

    // Client a choisi une destination / ville
    requestBody.cityName =
        data.city;

    requestBody.countryCode =
        data.countryCode;

    console.log(
        "📍 RECHERCHE HÔTEL PAR VILLE:",
        data.city,
        data.countryCode
    );

}

    console.log(
        "🏨 LITEAPI RATES REQUEST:"
    );

    console.log(
        JSON.stringify(
            requestBody,
            null,
            2
        )
    );

    const response =
    await fetch(
        `${LITEAPI_BASE_URL}/hotels/rates`,
        {
            method: "POST",
            headers: liteApiHeaders,
            body: JSON.stringify(requestBody)
        }
    );

const result =
    await response.json();

console.log(
    "🔎 LITEAPI RAW RESPONSE:",
    JSON.stringify(result, null, 2)
);

console.log(
    "🏨 LITEAPI RATES STATUS:",
    response.status
);

    console.log(
        "🏨 LITEAPI RATES STATUS:",
        response.status
    );

    if (!response.ok) {

        console.error(
            "❌ LITEAPI RATES ERROR:",
            JSON.stringify(
                result,
                null,
                2
            )
        );

        throw new Error(
            result.message ||
            result.error ||
            "LiteAPI rates error"
        );

    }

   const offers = [];

const hotels =
    result.data || [];

const hotelMetadataById = new Map(
    (result.hotels || []).map(hotel => [
        String(hotel.id || hotel.hotelId),
        hotel
    ])
);

    /*
     * IMPORTANT :
     *
     * Le vrai offerId est situé dans :
     *
     * hotel
     *   → roomTypes
     *      → room
     *         → offerId
     *
     * Il ne faut JAMAIS inventer
     * ou demander cet ID au client.
     */

    for (
        const hotel of hotels
    ) {

        const roomTypes =
            hotel.roomTypes || [];

        for (
            const room of roomTypes
        ) {

            if (!room.offerId) {
                continue;
            }

           const hotelId =
    hotel.hotelId ||
    hotel.id;

const hotelMetadata =
    hotelMetadataById.get(String(hotelId)) || {};

const hotelData = {
    ...hotelMetadata,
    ...(hotel.hotelData || {})
};

            offers.push({

    hotelId:
    hotelId,

hotelName:
    hotelData.name ||
    hotel.name ||
    "",

hotelAddress:
    hotelData.address ||
    hotelData.addressLine ||
    hotelData.address1 ||
    hotelData.street ||
    hotelData.location?.address ||
    hotelData.hotelAddress ||
    "",

    // 👤 PROPRIÉTAIRE SI LITEAPI LE FOURNIT
    hotelOwner:
        typeof (
            hotelData.owner ||
            hotelData.propertyOwner ||
            hotelData.ownerName ||
            hotelData.proprietor ||
            ""
        ) === "object"
            ? (
                hotelData.owner?.name ||
                hotelData.owner?.fullName ||
                hotelData.owner?.companyName ||
                ""
            )
            : (
                hotelData.owner ||
                hotelData.propertyOwner ||
                hotelData.ownerName ||
                hotelData.proprietor ||
                ""
            ),

    offerId:
        room.offerId,

    roomName:
        room.name ||
        room.roomName ||
        "Chambre",

    price:
        room.retailRate?.total ||
        room.price ||
        room.rate?.total ||
        null,

    currency:
        room.retailRate?.currency ||
        "EUR",

    refundable:
    room.cancellationPolicies?.refundableTag ||
    room.refundableTag ||
    room.rateTags ||
    null,

cancellationPolicies:
    room.cancellationPolicies ||
    room.rates?.[0]?.cancellationPolicies ||
    null,

raw:
    room

});

        }

    }

    

    console.log(
        "🏨 OFFRES TROUVÉES:",
        offers.length
    );
    // Si aucune offre remboursable n'est trouvée,
// effectuer une seconde recherche plus large.
if (offers.length === 0 && refundableOnly && allowFallback) {
    console.log(
        "⚠️ Aucune offre remboursable. Recherche de tarifs alternatifs..."
    );

    return await searchHotelOffers(data, false, false);
}

    return {

        raw: result,

        offers

    };

}

// ============================================================
// SEARCH HOTELS
// ============================================================

app.get(
    "/api/search-hotels",
    async (req, res) => {

        try {

            const data = {

                city:
                    req.query.city,

                countryCode:
                    req.query.countryCode ||
                    "FR",

                checkIn:
                    req.query.checkIn,

                checkOut:
                    req.query.checkOut,

                adults:
                    Number(
                        req.query.adults ||
                        2
                    ),

                children:
                    Number(
                        req.query.children ||
                        0
                    ),

                rooms:
                    Number(
                        req.query.rooms ||
                        1
                    )

            };

            const result =
                await searchHotelOffers(
                    data
                );

            /*
             * IMPORTANT :
             *
             * Tourizia ne montre pas
             * une liste d'hôtels au client.
             *
             * Le backend utilise les offres
             * uniquement pour préparer
             * automatiquement la réservation.
             */

            res.json({

                success: true,

                available:
                    result.offers.length > 0,

                offers:
                    result.offers

            });

        } catch (error) {

            console.error(
                "❌ SEARCH HOTEL ERROR:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    error.message ||
                    "Erreur recherche hôtel"

            });

        }

    }
);
// ============================================================
// TOURIZIA — BLOC 2/5
// PREBOOK + SÉLECTION AUTOMATIQUE DE L'OFFRE
// ============================================================

// ============================================================
// PREBOOK D'UNE OFFRE LITEAPI
// ============================================================

async function prebookHotelOffer(offerId) {

    if (!offerId) {

        throw new Error(
            "offerId LiteAPI manquant"
        );

    }

    console.log(
        "🔐 LITEAPI PREBOOK:",
        offerId
    );

    const response =
        await fetch(
            `${LITEAPI_BOOKING_URL}/rates/prebook`,
            {
                method: "POST",

                headers: {
                    ...liteApiHeaders,
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({

                    offerId,

                    /*
                     * false = paiement géré
                     * directement côté backend.
                     *
                     * Le mode Payment SDK
                     * n'est pas utilisé ici.
                     */
                    usePaymentSdk: false

                })
            }
        );

    const result =
        await response.json();

    console.log(
        "🔐 PREBOOK STATUS:",
        response.status
    );

    if (!response.ok) {

        console.error(
            "❌ PREBOOK ERROR:",
            JSON.stringify(
                result,
                null,
                2
            )
        );

        throw new Error(
            result.message ||
            result.error ||
            "Impossible de pré-réserver cette offre"
        );

    }

    console.log(
        "✅ PREBOOK SUCCESS"
    );

    return result;

}
// ============================================================
// true  → offre acceptable pour Tourizia
// false → offre non acceptable pour Tourizia
// ============================================================

// ============================================================
// 🛡️ POLITIQUE D'ANNULATION TOURIZIA
// ============================================================
// true  → offre acceptable
// false → offre refusée
//
// Règles Tourizia :
// - NRFN = non remboursable → REFUS
// - NRF / NONREFUNDABLE → REFUS
// - absence de politique fiable → REFUS
// - RFN + politique d'annulation → ACCEPTÉ
// ============================================================


function isTouriziaCancellationCompatible(offer, checkIn) {
    if (!offer || !checkIn) {
        return false;
    }

    const policies = offer.cancellationPolicies;

    if (!policies) {
        console.log(
            "🚫 REFUS — politique d'annulation absente:",
            offer.offerId
        );
        return false;
    }

    const refundableTag = String(
        policies.refundableTag || offer.refundable || ""
    ).trim().toUpperCase();

    const forbiddenTags = [
        "NRFN",
        "NRF",
        "NONREFUNDABLE",
        "NON_REFUNDABLE"
    ];

    if (
        forbiddenTags.includes(refundableTag) ||
        offer.refundable === false
    ) {
        console.log(
            "🚫 REFUS — offre non remboursable:",
            offer.offerId,
            refundableTag
        );
        return false;
    }

    if (refundableTag !== "RFN") {
        console.log(
            "🚫 REFUS — statut de remboursement inconnu:",
            offer.offerId,
            refundableTag
        );
        return false;
    }

    const infos = policies.cancelPolicyInfos;

    if (!Array.isArray(infos) || infos.length === 0) {
        console.log(
            "🚫 REFUS — aucune règle d'annulation détaillée:",
            offer.offerId
        );
        return false;
    }

    // Date limite : arrivée moins 72 heures.
    const arrival = new Date(`${checkIn}T00:00:00Z`);

    if (Number.isNaN(arrival.getTime())) {
        console.log("🚫 REFUS — date d'arrivée invalide:", checkIn);
        return false;
    }

    const deadline = new Date(
        arrival.getTime() - 3 * 24 * 60 * 60 * 1000
    );

    for (const policy of infos) {
        if (!policy || !policy.cancelTime) {
            console.log(
                "🚫 REFUS — date limite absente:",
                offer.offerId
            );
            return false;
        }

        const timezone = String(policy.timezone || "")
            .trim()
            .toUpperCase();

        // Refuser les fuseaux impossibles à vérifier sûrement.
        if (
            timezone &&
            !["GMT", "UTC", "ETC/UTC", "Z"].includes(timezone)
        ) {
            console.log(
                "🚫 REFUS — fuseau horaire à vérifier:",
                timezone
            );
            return false;
        }

        const cancelTimeText = String(policy.cancelTime).trim();
        const normalizedTime = cancelTimeText.includes("T")
            ? cancelTimeText
            : cancelTimeText.replace(" ", "T");

        const cancelTime = new Date(
            /Z$|[+-]\d{2}:\d{2}$/.test(normalizedTime)
                ? normalizedTime
                : `${normalizedTime}Z`
        );

        const amount = Number(policy.amount);

        if (
            Number.isNaN(cancelTime.getTime()) ||
            policy.amount === null ||
            policy.amount === undefined ||
            !Number.isFinite(amount) ||
            amount < 0
        ) {
            console.log(
                "🚫 REFUS — règle de pénalité incomplète:",
                offer.offerId
            );
            return false;
        }

        // Une pénalité avant J-3 signifie que l'offre ne convient pas.
        if (amount > 0 && cancelTime < deadline) {
            console.log(
                "🚫 REFUS — pénalité avant J-3:",
                offer.offerId,
                "date limite:",
                policy.cancelTime,
                "montant:",
                amount,
                policy.currency || ""
            );
            return false;
        }
    }

    console.log(
        "✅ OFFRE COMPATIBLE — politique vérifiée jusqu'à J-3:",
        offer.offerId
    );

    return true;
}

function getPrebookCancellationPolicies(prebookResult) {
    const data = prebookResult?.data || prebookResult;

    // Forme principale documentée par LiteAPI.
    if (data?.cancellationPolicies) {
        return data.cancellationPolicies;
    }

    // Compatibilité avec les réponses imbriquées.
    const roomTypes = data?.roomTypes || [];

    for (const room of roomTypes) {
        for (const rate of room?.rates || []) {
            if (rate?.cancellationPolicies) {
                return rate.cancellationPolicies;
            }
        }
    }

    return null;
}


// ============================================================
// 🔎 SÉLECTION D'UNE OFFRE AVEC ADRESSE VÉRIFIÉE
// ============================================================

async function findPrebookableOffer(data) {

    const MAX_SEARCH_ATTEMPTS = 3;

    let lastError = null;

    for (
        let searchAttempt = 1;
        searchAttempt <= MAX_SEARCH_ATTEMPTS;
        searchAttempt++
    ) {

        console.log(
            "========================================"
        );

        console.log(
            `🔄 RECHERCHE LITEAPI ${searchAttempt}/${MAX_SEARCH_ATTEMPTS}`
        );

        console.log(
            "========================================"
        );

        try {

            // ====================================================
            // 1️⃣ NOUVELLE RECHERCHE LITEAPI
            // ====================================================

            const searchResult =
                await searchHotelOffers(data);

            const offers =
                searchResult.offers || [];

            console.log(
                `🏨 OFFRES REÇUES: ${offers.length}`
            );

            if (!offers.length) {

                lastError =
                    new Error(
                        "Aucune offre hôtel disponible pour ces dates"
                    );

                continue;
            }


            // ====================================================
            // 2️⃣ FILTRE ANNULATION
            // ====================================================

            const compatibleOffers =
                offers.filter((offer) => {

                    const compatible =
    isTouriziaCancellationCompatible(
        offer,
        data.checkIn
    );

                    if (!compatible) {

                        console.log(
                            "🚫 OFFRE REFUSÉE — ANNULATION:",
                            offer.offerId
                        );

                    }

                    return compatible;

                });


            console.log(
                `🟢 OFFRES COMPATIBLES: ${compatibleOffers.length}/${offers.length}`
            );


            if (!compatibleOffers.length) {

                lastError =
                    new Error(
                        "Aucune offre compatible avec la politique d'annulation Tourizia"
                    );

                continue;
            }


            // ====================================================
            // 3️⃣ MEILLEURE SÉLECTION
            // RFN d'abord
            // puis prix
            // ====================================================

            const rankedOffers =
                [...compatibleOffers].sort(
                    (a, b) => {

                        const aRefundable =
                            String(
                                a.refundableTag || ""
                            ).toUpperCase() === "RFN";

                        const bRefundable =
                            String(
                                b.refundableTag || ""
                            ).toUpperCase() === "RFN";


                        if (
                            aRefundable !==
                            bRefundable
                        ) {

                            return aRefundable
                                ? -1
                                : 1;
                        }


                        const aPrice =
                            Number(
                                a.retailRate?.total?.[0]?.amount ??
                                a.offerRetailRate?.amount ??
                                a.offerInitialPrice?.amount ??
                                Infinity
                            );

                        const bPrice =
                            Number(
                                b.retailRate?.total?.[0]?.amount ??
                                b.offerRetailRate?.amount ??
                                b.offerInitialPrice?.amount ??
                                Infinity
                            );


                        return aPrice - bPrice;

                    }
                );


            console.log(
                `🏆 OFFRES CLASSÉES: ${rankedOffers.length}`
            );


            // ====================================================
            // 4️⃣ TESTER CHAQUE OFFRE
            // ====================================================

            for (
                const offer of rankedOffers
            ) {

                try {

                    console.log(
                        "----------------------------------------"
                    );

                    console.log(
                        "🏨 TEST OFFRE:",
                        offer.offerId
                    );

                    console.log(
                        "🏨 HOTEL:",
                        offer.hotelName ||
                        offer.hotelId
                    );

                    console.log(
                        "🟢 REMBOURSABLE:",
                        offer.refundableTag
                    );


                    // =================================================
                    // 5️⃣ DÉTAILS HÔTEL
                    // =================================================

                    let hotelDetails = {};

                    try {

                        hotelDetails =
                            await getLiteApiHotelDetails(
                                offer.hotelId
                            );

                    } catch (error) {

                        console.warn(
                            "⚠️ Détails hôtel indisponibles:",
                            error.message
                        );

                    }


                    // =================================================
                    // 6️⃣ ADRESSE
                    // =================================================

                    const hotelAddress =
                        formatLiteApiHotelAddress({

                            ...hotelDetails,

                            address:
                                hotelDetails.address ||
                                offer.hotelAddress,

                            zip:
                                hotelDetails.zip ||
                                hotelDetails.postalCode,

                            city:
                                hotelDetails.city ||
                                hotelDetails.city_name ||
                                data.city,

                            country:
                                hotelDetails.country ||
                                hotelDetails.country_code ||
                                data.countryCode

                        });


                    if (!hotelAddress) {

                        console.warn(
                            "⚠️ OFFRE IGNORÉE — ADRESSE ABSENTE:",
                            offer.hotelId
                        );

                        continue;
                    }


                    console.log(
                        "📍 ADRESSE HÔTEL VALIDÉE:",
                        hotelAddress
                    );


                    // =================================================
                    // 7️⃣ OFFRE VÉRIFIÉE
                    // =================================================

                    const verifiedOffer = {

                        ...offer,

                        hotelName:
                            hotelDetails.name ||
                            offer.hotelName,

                        hotelAddress,

                        hotelPhone:
                            hotelDetails.phone ||
                            hotelDetails.phoneNumber ||
                            hotelDetails.telephone ||
                            "",

                        hotelEmail:
                            hotelDetails.email ||
                            hotelDetails.contactEmail ||
                            "",

                        hotelWebsite:
                            hotelDetails.website ||
                            hotelDetails.webSite ||
                            hotelDetails.url ||
                            "",

                        hotelOwner:
                            hotelDetails.owner ||
                            hotelDetails.ownerName ||
                            "",

                        hotelDetails

                    };


                    // =================================================
                    // 8️⃣ PREBOOK
                    // =================================================

                    console.log(
                        "🔐 TENTATIVE PREBOOK:",
                        verifiedOffer.offerId
                    );


                    const prebook =
                        await prebookHotelOffer(
                            verifiedOffer.offerId
                        );


const prebookData = prebook?.data || prebook;

const freshPolicies =
    getPrebookCancellationPolicies(prebook);

if (!freshPolicies) {
    throw new Error(
        "PREBOOK refusé : LiteAPI n'a pas fourni de politique d'annulation vérifiable."
    );
}

if (prebookData?.cancellationChanged === true) {
    console.warn(
        "⚠️ LITEAPI : politique d'annulation modifiée au PREBOOK. Nouvelle vérification."
    );
}

const prebookOffer = {
    ...verifiedOffer,
    cancellationPolicies: freshPolicies,
    refundable: freshPolicies.refundableTag || null
};

if (
    !isTouriziaCancellationCompatible(
        prebookOffer,
        data.checkIn
    )
) {
    throw new Error(
        "PREBOOK refusé : les conditions d'annulation actualisées ne respectent pas la politique Tourizia J-3."
    );
}

console.log(
    "🛡️ PREBOOK VALIDÉ — politique d'annulation vérifiée:",
    verifiedOffer.offerId
);


                    // =================================================
                    // 9️⃣ SUCCÈS
                    // =================================================

                    console.log(
                        "========================================"
                    );

                    console.log(
                        "✅ OFFRE RÉSERVABLE TROUVÉE"
                    );

                    console.log(
                        "🏨 HOTEL:",
                        verifiedOffer.hotelName
                    );

                    console.log(
                        "🔐 OFFER ID:",
                        verifiedOffer.offerId
                    );

                    console.log(
                        "========================================"
                    );


                    return {

                        offer:
                            verifiedOffer,

                        prebook

                    };


                } catch (error) {

                    lastError =
                        error;


                    console.warn(
                        "⚠️ OFFRE NON RÉSERVABLE — ON PASSE À LA SUIVANTE"
                    );

                    console.warn(
                        "⚠️ OFFER:",
                        offer.offerId
                    );

                    console.warn(
                        "⚠️ ERREUR:",
                        error?.message ||
                        JSON.stringify(error)
                    );

                }

            }


            // ====================================================
            // TOUTES LES OFFRES DE CETTE RECHERCHE ÉCHOUÉES
            // ====================================================

            console.warn(
                `⚠️ RECHERCHE ${searchAttempt}: toutes les offres compatibles ont échoué au PREBOOK`
            );


        } catch (error) {

            lastError =
                error;

            console.error(
                `❌ ERREUR RECHERCHE LITEAPI ${searchAttempt}:`,
                error
            );

        }


        // ========================================================
        // PETITE PAUSE AVANT UNE NOUVELLE RECHERCHE
        // ========================================================

        if (
            searchAttempt <
            MAX_SEARCH_ATTEMPTS
        ) {

            console.log(
                "⏳ Nouvelle recherche LiteAPI dans 1 seconde..."
            );

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        1000
                    )
            );

        }

    }


    // ============================================================
    // AUCUNE OFFRE APRÈS 3 RECHERCHES
    // ============================================================

    throw (
        lastError ||
        new Error(
            "Aucune offre réservable disponible après plusieurs recherches."
        )
    );

}


// ============================================================
// ENDPOINT PREBOOK
// ============================================================
//
// Cet endpoint est surtout utile pour les tests
// et pour vérifier que LiteAPI accepte bien
// une offre avant de passer au paiement.
//
// Le client peut envoyer les informations
// de recherche.
//
// Il NE doit PAS envoyer offerId.
//
// Le backend choisit lui-même l'offre.
// ============================================================

app.post(
    "/api/prebook-hotel",
    async (req, res) => {

        try {

            const data = {

                city:
                    req.body.city,

                countryCode:
                    req.body.countryCode ||
                    "FR",

                checkIn:
                    req.body.checkIn,

                checkOut:
                    req.body.checkOut,

                adults:
                    Number(
                        req.body.adults ||
                        2
                    ),

                children:
                    Number(
                        req.body.children ||
                        0
                    ),

                rooms:
                    Number(
                        req.body.rooms ||
                        1
                    ),

                guestNationality:
                    req.body.guestNationality ||
                    "SN"

            };

            const validation =
                validateHotelRequest(
                    data
                );

            if (validation) {

                return res.status(400).json({

                    success: false,

                    error:
                        validation

                });

            }

            console.log(
                "🏨 PREBOOK REQUEST:"
            );

            console.log(
                JSON.stringify(
                    data,
                    null,
                    2
                )
            );

            const result =
                await findPrebookableOffer(
                    data
                );

            res.json({

                success: true,

                hotel: {

                    hotelId:
                        result.offer.hotelId,

                    hotelName:
                        result.offer.hotelName

                },

                room: {

                    name:
                        result.offer.roomName

                },

                /*
                 * Le vrai offerId LiteAPI.
                 *
                 * Il peut être conservé
                 * côté serveur pour le paiement.
                 */
                offerId:
                    result.offer.offerId,

                price:
                    result.offer.price,

                currency:
                    result.offer.currency,

                prebook:
                    result.prebook

            });

        } catch (error) {

            console.error(
                "❌ PREBOOK HOTEL ERROR:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    error.message ||
                    "Erreur lors du prébook hôtel"

            });

        }

    }
);


// ============================================================
// ENDPOINT DE TEST SIMPLE
// ============================================================
//
// Permet de tester directement un offerId LiteAPI
// récupéré depuis /api/search-hotels.
//
// IMPORTANT :
// Cet endpoint est destiné aux tests.
// Le parcours client normal ne demande jamais
// au client de saisir un offerId.
// ============================================================

app.post(
    "/api/test-prebook",
    async (req, res) => {

        try {

            const {
                offerId
            } = req.body;

            if (!offerId) {

                return res.status(400).json({

                    success: false,

                    error:
                        "offerId manquant"

                });

            }

            console.log(
                "🧪 TEST PREBOOK OFFER:",
                offerId
            );

            const result =
                await prebookHotelOffer(
                    offerId
                );

            res.json({

                success: true,

                offerId,

                result

            });

        } catch (error) {

            console.error(
                "❌ TEST PREBOOK ERROR:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    error.message ||
                    "Erreur test prebook"

            });

        }

    }
);
app.post(
    "/api/test-book",
    express.json(),
    async (req, res) => {
        try {
            const {
                prebookId,
                fullName,
                email,
                phone,
                adults,
                children
            } = req.body;

            if (!prebookId) {
                return res.status(400).json({
                    success: false,
                    error: "prebookId manquant"
                });
            }

            if (!email) {
                return res.status(400).json({
                    success: false,
                    error: "email manquant"
                });
            }

            const data = {
                prebookId,
                fullName: fullName || "CLIENT TEST",
                email,
                phone: phone || "",
                adults: Number(adults || 2),
                children: Number(children || 0),
                paymentId: "TEST-" + Date.now()
            };

            console.log("🧪 TEST BOOK LITEAPI");
            console.log("PREBOOK ID:", prebookId);
            console.log("EMAIL:", email);

            const result = await bookHotel(
                data,
                prebookId
            );

            return res.json({
                success: true,
                result
            });

        } catch (error) {
            console.error(
                "❌ TEST BOOK ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    error.message ||
                    "Erreur test book"
            });
        }
    }
);

// ============================================================
// HELPER — NORMALISER LE NOM DE L'HÔTEL
// ============================================================

function hotelNameParts(
    hotelName
) {

    const name =
        String(
            hotelName ||
            "Hotel"
        ).trim();

    return {

        firstName:
            name.substring(
                0,
                40
            ),

        lastName:
            "Tourizia"

    };

}


// ============================================================
// HELPER — NUMÉRO DE RÉSERVATION TOURIZIA
// ============================================================

function hotelNumber() {

    return (
        "TZH-" +
        Date.now().toString(
            36
        ).toUpperCase()
    );

}


// ============================================================
// VÉRIFICATION DES VARIABLES IMPORTANTES
// ============================================================

console.log(
    "--------------------------------------"
);

console.log(
    "🏨 TOURIZIA HOTEL CONFIGURATION"
);

console.log(
    "LiteAPI:",
    LITEAPI_API_KEY
        ? "OK"
        : "❌ MANQUANTE"
);

console.log(
    "Stripe:",
    stripe
        ? "OK"
        : "⚠️ NON CONFIGURÉ"
);

console.log(
    "PayTech:",
    PAYTECH_API_KEY
        ? "OK"
        : "⚠️ NON CONFIGURÉ"
);

console.log(
    "--------------------------------------"
);
// ============================================================
// BLOC 3 — PAIEMENTS HÔTEL
// Stripe + Orange Money + Wave
// ============================================================

// ------------------------------------------------------------

// ============================================================
// STRIPE — CRÉATION DU CHECKOUT
// ============================================================

// ============================================================
// STRIPE — CRÉATION DU CHECKOUT HÔTEL
// ============================================================

app.post(
  "/create-hotel-payment",
  express.json(),
  async (req, res) => {

    let transactionPromise = null;

    try {

      // --------------------------------------------------------
      // STRIPE
      // --------------------------------------------------------

      if (!stripe) {
        return res.status(500).json({
          error: "Stripe n'est pas configuré."
        });
      }

      // --------------------------------------------------------
      // VALIDATION DE LA DEMANDE
      // --------------------------------------------------------

      const validation =
        validateHotelRequest(req.body);

      if (validation) {
        return res.status(400).json({
          success: false,
          error: validation
        });
      }

      const data = req.body;

      // --------------------------------------------------------
      // 👥 NOMBRE TOTAL DE VOYAGEURS
      // --------------------------------------------------------

      const adults =
        Number(data.adults || 0);

      const children =
        Number(data.children || 0);

      const totalPersons =
        adults + children;

      if (totalPersons < 1) {
        return res.status(400).json({
          success: false,
          error:
            "Nombre de voyageurs invalide."
        });
      }

      // --------------------------------------------------------
      // 🛡️ VÉRIFIER LES VOYAGEURS
      // --------------------------------------------------------

      if (
        !Array.isArray(data.guests) ||
        data.guests.length !== totalPersons
      ) {
        return res.status(400).json({
          success: false,
          error:
            `Les informations des ${totalPersons} voyageurs sont requises.`
        });
      }

      for (const guest of data.guests) {

        if (
          !guest.firstName ||
          !guest.lastName
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Le prénom et le nom de chaque voyageur sont obligatoires."
          });
        }

      }

      // --------------------------------------------------------
      // 🔑 ID TRANSACTION GÉNÉRÉ IMMÉDIATEMENT
      // --------------------------------------------------------

      const transactionId =
        generateHotelTransactionId();

      // --------------------------------------------------------
      // 🔐 PAIEMENT D'ABORD
      // --------------------------------------------------------
      // Aucune recherche LiteAPI ici.
      // LiteAPI sera appelée uniquement après paiement confirmé.
      // --------------------------------------------------------

      const offerToken =
        "HOTEL-" +
        Date.now() +
        "-" +
        Math.random()
          .toString(36)
          .slice(2, 10);

      pendingHotelPayments.set(
        offerToken,
        {
          data
        }
      );

      console.log(
        "🔐 DONNÉES HÔTEL STOCKÉES AVANT PAIEMENT:",
        offerToken
      );

      console.log(
        "🔐 OFFER TOKEN STRIPE:",
        offerToken
      );

      // --------------------------------------------------------
      // 🧾 MONGODB EN PARALLÈLE AVEC STRIPE
      // --------------------------------------------------------

      transactionPromise =
        createHotelTransaction(
          {
            ...data,
            paymentMethod: "stripe"
          },
          transactionId
        );

      // --------------------------------------------------------
      // 💳 CRÉATION CHECKOUT STRIPE
      // --------------------------------------------------------

      const session =
        await stripe.checkout.sessions.create({

          mode: "payment",

          line_items: [
            {
              price_data: {
                currency: "usd",

                product_data: {
                  name:
                    "Réservation hôtel — Tourizia",

                  description:
                    `${data.city} | ${data.checkIn} → ${data.checkOut}`
                },

                unit_amount:
                  HOTEL_STRIPE_PRICE
              },

              quantity:
                totalPersons
            }
          ],

          customer_email:
            data.email,

          success_url:
    `https://tourizia.com/?hotel_payment=success&transactionId=${encodeURIComponent(transactionId)}`,

cancel_url:
    `https://tourizia.com/?hotel_payment=cancel&transactionId=${encodeURIComponent(transactionId)}`,
          metadata: {

            type:
              "hotel",

            paymentMethod:
              "stripe",

            transactionId:
              transactionId || "",

            fullName:
              data.fullName || "",

            email:
              data.email || "",

            city:
              data.city,

            countryCode:
              data.countryCode,

            checkIn:
              data.checkIn,

            checkOut:
              data.checkOut,

            adults:
              String(data.adults),

            children:
              String(data.children),

            rooms:
              String(data.rooms),

            guestNationality:
              data.guestNationality || "SN",

            offerToken:
              offerToken
          }
        });

      console.log(
        "💳 Stripe Checkout créé :",
        session.id
      );

      // --------------------------------------------------------
      // 🧾 S'ASSURER QUE LA TRANSACTION EST BIEN ENREGISTRÉE
      // AVANT DE DONNER L'URL AU CLIENT
      // --------------------------------------------------------

      await transactionPromise;

      // --------------------------------------------------------
      // 🚀 RETOUR RAPIDE AU FRONTEND
      // --------------------------------------------------------

      return res.json({
        success: true,
        url: session.url
      });

    } catch (error) {

      // Évite une promesse MongoDB non gérée
      if (transactionPromise) {
        await transactionPromise.catch(() => {});
      }

      console.error(
        "❌ Erreur création Stripe hôtel :",
        error.response?.data ||
        error.message ||
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Impossible de créer le paiement hôtel."
      });

    }

  }
);



// ============================================================
// PAYTECH — FONCTION COMMUNE
// ============================================================

async function createHotelPaytechPayment(req, res, targetPayment) {

  try {

    if (!process.env.PAYTECH_API_KEY ||
        !process.env.PAYTECH_API_SECRET) {

      return res.status(500).json({
        error: "PayTech n'est pas configuré."
      });
    }

    const validation = validateHotelRequest(req.body);

if (validation) {
    return res.status(400).json({
        success: false,
        error: validation
    });
}

const data = req.body;

const transactionId =
    generateHotelTransactionId();

let transactionPromise = null;

// ========================================================
// 👥 TOTAL VOYAGEURS
// ========================================================

const adults =
    Number(data.adults || 0);

const children =
    Number(data.children || 0);

const totalPersons =
    adults + children;

if (totalPersons < 1) {

    return res.status(400).json({

        success: false,

        error:
            "Nombre de voyageurs invalide."

    });

}
const totalPaytechAmount =
    HOTEL_PAYTECH_PRICE * totalPersons;

    console.log(
      `🏨 Création paiement PayTech hôtel — ${targetPayment}`
    );

    // --------------------------------------------------------
    // Le backend sélectionne l'offre.
    // Le frontend n'envoie PAS offerId.
    // --------------------------------------------------------



    // --------------------------------------------------------
    // Référence unique
    // --------------------------------------------------------

    const refCommand =
      "TZ-HOTEL-" + Date.now();


    // --------------------------------------------------------
    // Informations conservées dans PayTech
    // pour pouvoir retrouver la réservation
    // lors de l'IPN après paiement.
    // --------------------------------------------------------

    const customField = {

      type: "hotel",

      paymentMethod: targetPayment,

      transactionId:
        transactionId || "",


      fullName: data.fullName || "",
      email: data.email || "",

      city: data.city,
      countryCode: data.countryCode,

      checkIn: data.checkIn,
      checkOut: data.checkOut,

      adults: data.adults,
      children: data.children,
      rooms: data.rooms,

     guests:
    Array.isArray(data.guests)
        ? data.guests
        : [],
        
totalPersons:
    totalPersons,
      guestNationality:
        data.guestNationality || "SN",

    };
    transactionPromise =
    createHotelTransaction(
        {
            ...data,
            paymentMethod: targetPayment
        },
        transactionId
    );


    // --------------------------------------------------------
    // Requête PayTech
    // --------------------------------------------------------

    const response = await fetch(
      "https://paytech.sn/api/payment/request-payment",
      {
        method: "POST",

        headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",

    "API_KEY":
        process.env.PAYTECH_API_KEY,

    "API_SECRET":
        process.env.PAYTECH_API_SECRET
},

        body: JSON.stringify({

          item_name:
            "Réservation hôtel — Tourizia",

         item_price:
    totalPaytechAmount,

          currency:
            "XOF",

          ref_command:
            refCommand,

          command_name:
            refCommand,

          target_payment:
            targetPayment,

          env:
            process.env.PAYTECH_ENV || "test",

          ipn_url:
    "https://tourizia-hotel-api.onrender.com/paytech-hotel-ipn",

          success_url:
            `https://tourizia.com/?hotel_payment=success&transactionId=${encodeURIComponent(transactionId)}`,

          cancel_url:
            `https://tourizia.com/?hotel_payment=cancel&transactionId=${encodeURIComponent(transactionId)}`,

          custom_field:
            JSON.stringify(customField)
        })
      }
    );


    const result = await response.json();

    console.log(
      "💳 Réponse PayTech :",
      result
    );


    // --------------------------------------------------------
    // Vérification réponse
    // --------------------------------------------------------

    if (!response.ok) {

      return res.status(502).json({
        error:
          result.message ||
          "PayTech a refusé la demande de paiement."
      });
    }


    if (!result.redirect_url) {

      console.error(
        "❌ PayTech n'a pas retourné redirect_url :",
        result
      );

      return res.status(502).json({
        error:
          "PayTech n'a pas fourni de lien de paiement."
      });
    }


    // --------------------------------------------------------
// 🧾 S'ASSURER QUE LA TRANSACTION EST ENREGISTRÉE
// AVANT DE DONNER L'URL AU CLIENT
// --------------------------------------------------------

await transactionPromise;

    // --------------------------------------------------------
    // Retour frontend
    // --------------------------------------------------------

    return res.json({

      success: true,

      paymentMethod:
        targetPayment,

      refCommand,

      url:
        result.redirect_url,

      redirect_url:
        result.redirect_url
    });


  } catch (error) {

    if (transactionPromise) {
        await transactionPromise.catch(() => {});
    }

    console.error(
      `❌ Erreur PayTech ${targetPayment} :`,
      error.response?.data ||
      error.message ||
      error
    );

    return res.status(500).json({
      error:
        `Impossible de créer le paiement ${targetPayment}.`
    });
  }
}
// ============================================================
// 💳 PAYTECH HOTEL IPN
// ============================================================

app.post(
    "/paytech-hotel-ipn",

    express.urlencoded({
        extended: true
    }),

    express.json(),

    async (req, res) => {

        try {

            console.log(
                "💳🔥 PAYTECH HOTEL IPN"
            );

            console.log(
                "PAYTECH DATA:",
                req.body
            );

            if (!req.body) {

    console.error(
        "❌ PAYTECH IPN: BODY VIDE"
    );

    return res
        .status(400)
        .send("Missing body");

}

            const {

                type_event,

                custom_field,

                ref_command,

                item_price,

                final_item_price,

                payment_method,

                hmac_compute,

                api_key_sha256,

                api_secret_sha256

            } = req.body;


            // ==================================================
            // 🔐 VÉRIFICATION PAYTECH
            // ==================================================

            const apiKey =
                process.env.PAYTECH_API_KEY;

            const apiSecret =
                process.env.PAYTECH_API_SECRET;


            let authenticated = false;


            // --------------------------------------------------
            // HMAC — méthode recommandée par PayTech
            // --------------------------------------------------

            if (hmac_compute) {

                const amount =
                    final_item_price ||
                    item_price;

                const message =
                    `${amount}|${ref_command}|${apiKey}`;

                const expectedHmac =
                    crypto
                        .createHmac(
                            "sha256",
                            apiSecret
                        )
                        .update(message)
                        .digest("hex");


                authenticated =
                    expectedHmac ===
                    hmac_compute;

            }


            // --------------------------------------------------
            // SHA256 — fallback
            // --------------------------------------------------

            else {

                const expectedApiKey =
                    crypto
                        .createHash("sha256")
                        .update(apiKey)
                        .digest("hex");

                const expectedApiSecret =
                    crypto
                        .createHash("sha256")
                        .update(apiSecret)
                        .digest("hex");


                authenticated =
                    expectedApiKey ===
                        api_key_sha256 &&

                    expectedApiSecret ===
                        api_secret_sha256;

            }


            if (!authenticated) {

                console.error(
                    "❌ PAYTECH IPN NON AUTHENTIFIÉ"
                );

                return res
                    .status(403)
                    .send("Forbidden");

            }


            console.log(
                "✅ PAYTECH IPN AUTHENTIFIÉ"
            );


            // ==================================================
            // ANNULATION
            // ==================================================

            if (
                type_event ===
                "sale_canceled"
            ) {

                console.log(
                    "❌ PAIEMENT HÔTEL ANNULÉ:",
                    ref_command
                );

                return res
                    .status(200)
                    .send("OK");

            }


            // ==================================================
            // SUCCÈS
            // ==================================================

            if (
                type_event !==
                "sale_complete"
            ) {

                return res
                    .status(200)
                    .send("OK");

            }


            // ==================================================
// DÉCODER CUSTOM FIELD PAYTECH
// ==================================================

let hotelData = {};

try {

    const rawCustomField =
        custom_field || "";

    // ------------------------------------------------
    // PayTech nous envoie actuellement le JSON
    // directement.
    // ------------------------------------------------

    try {

        hotelData =
            JSON.parse(rawCustomField);

        console.log(
            "✅ CUSTOM FIELD PAYTECH JSON DIRECT"
        );

    } catch (directError) {

        // ------------------------------------------------
        // Compatibilité avec un ancien format Base64
        // ------------------------------------------------

        const decoded =
            Buffer
                .from(
                    rawCustomField,
                    "base64"
                )
                .toString("utf8");

        hotelData =
            JSON.parse(decoded);

        console.log(
            "✅ CUSTOM FIELD PAYTECH BASE64 DÉCODÉ"
        );

    }

} catch (error) {

    console.error(
        "❌ CUSTOM FIELD PAYTECH INVALID:",
        error
    );

    console.error(
        "CUSTOM FIELD REÇU:",
        custom_field
    );

    return res
        .status(400)
        .send("Invalid custom_field");

}


            // ==================================================
// INFORMATIONS PAIEMENT
// ==================================================

hotelData.paymentMethod =
    payment_method ||
    hotelData.paymentMethod ||
    "PayTech";

hotelData.paymentId =
    ref_command;

hotelData.paytechReference =
    ref_command;

hotelData.paytechAmount =
    Number(
        final_item_price ||
        item_price ||
        0
    );

// ==================================================
// 🧾 TRANSACTION TOURIZIA
// ==================================================

const transactionId =
    hotelData.transactionId || null;

if (!transactionId) {

    console.error(
        "❌ TRANSACTION ID MANQUANT DANS PAYTECH CUSTOM_FIELD"
    );

    return res
        .status(400)
        .send("Transaction ID missing");

}

console.log(
    "🧾 TRANSACTION ID:",
    transactionId
);

// ==================================================
// 💰 TRANSACTION → PAID
// ==================================================

await updateHotelTransactionStatus(

    transactionId,

    HOTEL_TRANSACTION_STATUS.PAID,

    {

        "payment.paymentId":
            ref_command,

        "payment.paytechReference":
            ref_command,

        "payment.amount":
            Number(
                final_item_price ||
                item_price ||
                0
            ),

        "payment.currency":
            "XOF"

    }

);


            console.log(
                "======================================"
            );

            console.log(
                "✅ PAYTECH HOTEL PAYMENT CONFIRMÉ"
            );

            console.log(
                "REFERENCE:",
                ref_command
            );

            console.log(
                "METHOD:",
                hotelData.paymentMethod
            );

            console.log(
                "AMOUNT:",
                hotelData.paytechAmount
            );

            console.log(
                "CUSTOMER:",
                hotelData.email
            );

            console.log(
                "HOTEL:",
                hotelData.hotelName
            );

            console.log(
                "======================================"
            );


            // ==================================================
            // 🔥 RÉSERVATION LITEAPI
            // ==================================================

            await processHotelAfterPayment(
                hotelData
            );


            console.log(
                "🎉 PAYTECH HOTEL FINALISÉ"
            );


            return res
                .status(200)
                .send("OK");


        } catch (error) {

            console.error(
                "❌ PAYTECH HOTEL IPN ERROR:",
                error
            );

            return res
                .status(500)
                .send("ERROR");

        }

    }
);

// ============================================================
// ORANGE MONEY
// ============================================================

app.post(
  "/create-hotel-paytech-orange",
  async (req, res) => {

    return createHotelPaytechPayment(
      req,
      res,
      "Orange Money"
    );
  }
);


// ============================================================
// WAVE
// ============================================================

app.post(
  "/create-hotel-paytech-wave",
  async (req, res) => {

    return createHotelPaytechPayment(
      req,
      res,
      "Wave"
    );
  }
);


// ============================================================
// FIN BLOC 3
// ============================================================
// ============================================================
// TOURIZIA — BLOC 4/5
// STRIPE WEBHOOK + BOOK LITEAPI
// ============================================================


// ============================================================
// STRIPE WEBHOOK
// ============================================================
//
// IMPORTANT :
// Cette route doit être déclarée AVANT :
//
// app.use(express.json())
//
// afin que Stripe puisse vérifier la signature
// avec le corps RAW de la requête.
// ============================================================



// ============================================================
// EXPRESS JSON
// ============================================================
//
// À placer APRÈS le webhook Stripe.
// ============================================================

app.use(
    express.json()
);


// ============================================================
// CRÉATION DE LA RÉSERVATION LITEAPI
// ============================================================

async function bookHotel(
    data,
    prebookId
) {

    if (!prebookId) {

        throw new Error(
            "prebookId LiteAPI manquant"
        );

    }

    // --------------------------------------------------------
    // NOM DU TITULAIRE
    // --------------------------------------------------------

    const fullName =
        String(
            data.fullName ||
            "CLIENT TOURIZIA"
        ).trim();

    const nameParts =
        fullName.split(
            /\s+/
        );

    const firstName =
        nameParts.shift() ||
        "CLIENT";

    const lastName =
        nameParts.join(" ") ||
        "TOURIZIA";

    // --------------------------------------------------------
    // EMAIL
    // --------------------------------------------------------

    const email =
        data.email;

    if (!email) {

        throw new Error(
            "Email client manquant"
        );

    }

    // --------------------------------------------------------
    // TÉLÉPHONE
    // --------------------------------------------------------

    /*
     * LiteAPI peut demander un téléphone
     * selon le fournisseur.
     *
     * Pour le MVP :
     * utiliser celui transmis si disponible.
     */

    const phone =
        data.phone ||
        "";

    // --------------------------------------------------------
    // HOLDER
    // --------------------------------------------------------

    const holder = {

        firstName,

        lastName,

        email,

        phone

    };

    // --------------------------------------------------------
    // GUESTS
    // --------------------------------------------------------

    const adults =
        Number(
            data.adults || 2
        );

    const children =
        Number(
            data.children || 0
        );

   // --------------------------------------------------------
// GUESTS
// --------------------------------------------------------
// LiteAPI attend 1 guest principal par chambre.
// occupancyNumber = numéro de la chambre,
// PAS le nombre de personnes.
//
// Exemple :
// 1 chambre + 2 adultes = 1 guest avec occupancyNumber: 1
// 2 chambres = 2 guests avec occupancyNumber: 1 et 2
// --------------------------------------------------------

const rooms = Number(
    data.rooms || 1
);

const guests = [];

for (
    let i = 0;
    i < rooms;
    i++
) {
    guests.push({
        occupancyNumber: i + 1,
        firstName,
        lastName,
        email
    });
}

    // --------------------------------------------------------
    // PAIEMENT LITEAPI
    // --------------------------------------------------------

    /*
     * IMPORTANT :
     *
     * ACC_CREDIT_CARD est le mode confirmé
     * pour nos tests Sandbox LiteAPI.
     *
     * Pour la production, il faudra utiliser
     * le payment method approuvé/configuré
     * par LiteAPI pour Tourizia.
     */

    const payment = {

        method:
            LITEAPI_PAYMENT_METHOD

    };

    // --------------------------------------------------------
    // CLIENT REFERENCE
    // --------------------------------------------------------

    const clientReference =
        data.paymentId ||
        hotelNumber();

    // --------------------------------------------------------
    // BODY BOOK
    // --------------------------------------------------------

    const requestBody = {

        prebookId,

        holder,

        guests,

        payment,

        clientReference

    };

    console.log(
        "🏨 LITEAPI BOOK REQUEST:"
    );

    console.log(
        JSON.stringify(
            {
                ...requestBody,

                /*
                 * On évite d'afficher
                 * certaines données personnelles
                 * inutilement dans les logs.
                 */
                holder: {
                    firstName,
                    lastName,
                    email: "***"
                }

            },
            null,
            2
        )
    );

    // --------------------------------------------------------
    // APPEL BOOK
    // --------------------------------------------------------

    const response =
        await fetch(
            `${LITEAPI_BOOKING_URL}/rates/book`,
            {
                method: "POST",

                headers: {
                    ...liteApiHeaders,
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(
                        requestBody
                    )

            }
        );

    const result =
        await response.json();

    console.log(
        "🏨 LITEAPI BOOK STATUS:",
        response.status
    );

    if (!response.ok) {

        console.error(
            "❌ LITEAPI BOOK ERROR:"
        );

        console.error(
            JSON.stringify(
                result,
                null,
                2
            )
        );

        throw new Error(
            result.message ||
            result.error ||
            "LiteAPI booking error"
        );

    }

    console.log(
        "======================================"
    );

    console.log(
        "🎉 HOTEL BOOKING CONFIRMÉE"
    );

    console.log(
        "======================================"
    );

    return result;

}


// ============================================================
// TRAITEMENT APRÈS PAIEMENT
// ============================================================
//
// Étapes :
//
// 1. Utiliser l'offre pré-sélectionnée
// 2. PREBOOK
// 3. Si elle a expiré → nouvelle recherche
// 4. PREBOOK nouvelle offre
// 5. BOOK
// 6. Retourner confirmation
//
// ============================================================
// 📧 PAIEMENT REÇU — RECHERCHE MANUELLE ADMIN
// ============================================================

async function sendHotelManualSearchNotification(
    data,
    reason
) {

    const adminEmail =
        "contact@tourizia.com";

    const guestsText =
        Array.isArray(data.guests) &&
        data.guests.length
            ? data.guests
                .map(
                    (guest, index) =>
                        `${index + 1}. ${
                            guest.firstName || ""
                        } ${
                            guest.lastName || ""
                        } (${
                            guest.type || "adult"
                        })`
                )
                .join("<br>")
            : "Aucun voyageur renseigné";

    const emailPayload = {

        from:
            "Tourizia <tickets@tourizia.com>",

        to:
            adminEmail,

        subject:
            `⚠️ PAIEMENT HÔTEL REÇU — RECHERCHE MANUELLE — ${
                data.paymentId || "SANS RÉFÉRENCE"
            }`,

        html: `

            <div
                style="
                    font-family:Arial,Helvetica,sans-serif;
                    max-width:750px;
                    margin:auto;
                    padding:30px;
                    color:#17212b;
                "
            >

                <h2>
                    ⚠️ TOURIZIA — Recherche manuelle nécessaire
                </h2>

                <p
                    style="
                        background:#fff7ed;
                        color:#c2410c;
                        padding:15px;
                        border-radius:10px;
                        font-weight:bold;
                    "
                >
                    Paiement reçu, mais aucune offre
                    LiteAPI n'a pu être trouvée ou réservée.
                </p>

                <p>
                    Le client doit maintenant être traité
                    manuellement par l'administration Tourizia.
                </p>


                <div
                    style="
                        background:#f4f8f9;
                        padding:20px;
                        border-radius:12px;
                        margin:20px 0;
                    "
                >

                    <h3>
                        💳 Paiement
                    </h3>

                    <strong>ID paiement :</strong>
                    ${escapeHtml(
                        data.paymentId || ""
                    )}

                    <br>

                    <strong>Méthode :</strong>
                    ${escapeHtml(
                        data.paymentMethod || ""
                    )}

                    <br>

                    <strong>Référence PayTech :</strong>
                    ${escapeHtml(
                        data.paytechReference || ""
                    )}

                    <br>

                    <strong>Montant PayTech :</strong>
                    ${Number(
                        data.paytechAmount || 0
                    )}

                </div>


                <div
                    style="
                        background:#ffffff;
                        border:1px solid #e5e7eb;
                        padding:20px;
                        border-radius:12px;
                    "
                >

                    <h3>
                        👤 Client
                    </h3>

                    <strong>Nom :</strong>
                    ${escapeHtml(
                        data.fullName || ""
                    )}

                    <br>

                    <strong>Email :</strong>
                    ${escapeHtml(
                        data.email || ""
                    )}

                    <br>

                    <strong>Téléphone :</strong>
                    ${escapeHtml(
                        data.phone || ""
                    )}

                </div>


                <div
                    style="
                        margin-top:20px;
                        background:#ffffff;
                        border:1px solid #e5e7eb;
                        padding:20px;
                        border-radius:12px;
                    "
                >

                    <h3>
                        🏨 Demande hôtel
                    </h3>

                    <strong>Hôtel demandé :</strong>
                    ${escapeHtml(
                        data.hotelName || "Non renseigné"
                    )}

                    <br>

                    <strong>Chambre demandée :</strong>
                    ${escapeHtml(
                        data.roomName || "Non renseignée"
                    )}

                    <br>

                    <strong>Ville :</strong>
                    ${escapeHtml(
                        data.city || ""
                    )}

                    <br>

                    <strong>Pays :</strong>
                    ${escapeHtml(
                        data.countryCode || ""
                    )}

                    <br>

                    <strong>Arrivée :</strong>
                    ${escapeHtml(
                        formatHotelDate(
                            data.checkIn
                        )
                    )}

                    <br>

                    <strong>Départ :</strong>
                    ${escapeHtml(
                        formatHotelDate(
                            data.checkOut
                        )
                    )}

                    <br>

                    <strong>Adultes :</strong>
                    ${Number(
                        data.adults || 0
                    )}

                    <br>

                    <strong>Enfants :</strong>
                    ${Number(
                        data.children || 0
                    )}

                    <br>

                    <strong>Chambres :</strong>
                    ${Number(
                        data.rooms || 1
                    )}

                    <br>

                    <strong>Nationalité :</strong>
                    ${escapeHtml(
                        data.guestNationality || ""
                    )}

                </div>


                <div
                    style="
                        margin-top:20px;
                        padding:20px;
                        background:#f8fafc;
                        border-radius:12px;
                    "
                >

                    <h3>
                        👥 Voyageurs
                    </h3>

                    ${guestsText}

                </div>


                <div
                    style="
                        margin-top:20px;
                        padding:20px;
                        background:#fff7ed;
                        border-radius:12px;
                    "
                >

                    <h3>
                        🔎 Motif de l'intervention
                    </h3>

                    <p>
                        ${escapeHtml(
                            reason ||
                            "Aucune offre LiteAPI disponible."
                        )}
                    </p>

                </div>


                <p
                    style="
                        margin-top:25px;
                        color:#6c7882;
                    "
                >
                    Action requise :
                    effectuer une recherche manuelle
                    pour cette demande et contacter le client
                    si nécessaire.
                </p>

            </div>

        `
    };


    try {

        if (!resend) {

            console.error(
                "❌ RESEND NON CONFIGURÉ — NOTIFICATION ADMIN IMPOSSIBLE"
            );

            return null;

        }

        const result =
            await resend.emails.send(
                emailPayload
            );

        console.log(
            "📧 ADMIN — RECHERCHE MANUELLE:",
            JSON.stringify(
                result,
                null,
                2
            )
        );

        if (result.error) {

            throw new Error(
                `Resend admin error: ${
                    result.error.name
                } - ${
                    result.error.message
                }`
            );

        }

        return result;

    } catch (error) {

        console.error(
            "❌ ADMIN MANUAL SEARCH EMAIL ERROR:",
            error
        );

        return null;

    }

}
// ============================================================

async function processHotelAfterPayment(
    data
) {

    console.log(
        "======================================"
    );

    console.log(
        "🏨 PROCESS HOTEL AFTER PAYMENT"
    );

    console.log(
        "PAYMENT ID:",
        data.paymentId
    );

    console.log(
        "CUSTOMER:",
        data.email
    );

    console.log(
        "CITY:",
        data.city
    );

    console.log(
        "======================================"
    );
    await updateHotelTransactionStatus(
    data.transactionId,
    HOTEL_TRANSACTION_STATUS.SEARCHING
);

    let selectedOffer = null;
    let prebookResult = null;
  

    // ========================================================
// 🏨 APRÈS PAIEMENT UNIQUEMENT
// RECHERCHE D'UNE OFFRE LITEAPI
// ========================================================


console.log(
    "🔎 PAIEMENT CONFIRMÉ — RECHERCHE DISPONIBILITÉ LITEAPI..."
);

let fresh = null;

try {

    fresh =
        await findPrebookableOffer(
            data
        );

} catch (error) {

    console.error(
        "❌ LITEAPI — AUCUNE OFFRE RÉSERVABLE:",
        error
    );


    await sendHotelManualSearchNotification(
        data,
        error?.message ||
            "Aucune offre disponible ou réservable après paiement."
    );
    await updateHotelTransactionStatus(
    data.transactionId,
    HOTEL_TRANSACTION_STATUS.MANUAL_SEARCH_REQUIRED,
    {
        error:
            error?.message ||
            "Aucune offre disponible ou réservable après paiement."
    }
);

    throw error;

}

if (
    !fresh ||
    !fresh.offer ||
    !fresh.prebook
) {

    console.error(
        "❌ AUCUNE OFFRE DISPONIBLE APRÈS PAIEMENT"
    );

    await sendHotelManualSearchNotification(
        data,
        "Aucune offre disponible ou réservable après paiement."
    );

    throw new Error(
        "Paiement reçu mais aucune chambre disponible ou réservable."
    );

}

selectedOffer =
    fresh.offer;

prebookResult =
    fresh.prebook;


console.log(
    "✅ OFFRE TROUVÉE APRÈS PAIEMENT:",
    selectedOffer.offerId
);

// ========================================================
// 🏨 TRANSACTION → OFFER_FOUND
// ========================================================

await updateHotelTransactionStatus(

    data.transactionId,

    HOTEL_TRANSACTION_STATUS.OFFER_FOUND,

    {

        "provider.hotelId":
            selectedOffer.hotelId || null,

        "provider.hotelName":
            selectedOffer.hotelName || null,

        "provider.roomName":
            selectedOffer.roomName || null,

        "provider.offerId":
            selectedOffer.offerId || null,

        "provider.price":
            selectedOffer.price || null,

        "provider.currency":
            selectedOffer.currency || null

    }

);



    // ========================================================
// RÉCUPÉRER LE PREBOOK ID
// ========================================================

/*
 * Selon la réponse LiteAPI,
 * le prebookId peut être directement
 * dans la réponse ou dans une structure
 * imbriquée.
 */

const prebookId =
    prebookResult.prebookId ||
    prebookResult.data?.prebookId ||
    prebookResult.id ||
    prebookResult.data?.id;


// ========================================================
// 🔐 VÉRIFICATION PREBOOK ID
// ========================================================

if (!prebookId) {

    console.error(
        "❌ PREBOOK ID INTROUVABLE:"
    );

    console.error(
        JSON.stringify(
            prebookResult,
            null,
            2
        )
    );

    await updateHotelTransactionStatus(

        data.transactionId,

        HOTEL_TRANSACTION_STATUS.ERROR,

        {

            error:
                "LiteAPI n'a pas retourné de prebookId"

        }

    );

    throw new Error(
        "LiteAPI n'a pas retourné de prebookId"
    );

}


// ========================================================
// ✅ PREBOOK ID TROUVÉ
// ========================================================

console.log(
    "✅ PREBOOK ID:",
    prebookId
);


// ========================================================
// 🧾 TRANSACTION → PREBOOKED
// ========================================================

await updateHotelTransactionStatus(

    data.transactionId,

    HOTEL_TRANSACTION_STATUS.PREBOOKED,

    {

        "provider.prebookId":
            prebookId

    }

);

    // ========================================================
    // ÉTAPE 3
    // BOOK FINAL
    // ========================================================

    const bookingResult =
        await bookHotel(
            data,
            prebookId
        );

    // ========================================================
    // EXTRACTION RÉFÉRENCE
    // ========================================================

    const bookingId =
        bookingResult.bookingId ||
        bookingResult.data?.bookingId ||
        bookingResult.id ||
        bookingResult.data?.id ||
        null;

    const confirmationNumber =
        bookingResult.confirmationNumber ||
        bookingResult.data?.confirmationNumber ||
        bookingResult.booking?.confirmationNumber ||
        bookingId;

        await updateHotelTransactionStatus(
    data.transactionId,
    HOTEL_TRANSACTION_STATUS.BOOKED,
    {

        "provider.bookingId":
            bookingId,

        "provider.confirmationNumber":
            confirmationNumber

    }
);

// ========================================================
// 📅 POLITIQUE D'ANNULATION LITEAPI
// ========================================================

const bookingData =
    bookingResult.data ||
    bookingResult.booking ||
    bookingResult;

const cancellationPolicies =
    bookingData.cancellationPolicies ||
    selectedOffer.cancellationPolicies ||
    {};

const refundableTag =
    bookingData.tag ||
    bookingData.refundableTag ||
    cancellationPolicies.refundableTag ||
    null;

const cancelPolicyInfos =
    cancellationPolicies.cancelPolicyInfos ||
    [];

const cancellationDeadline =
    bookingData.lastFreeCancellationDate ||
    bookingData.last_free_cancellation_date ||
    cancelPolicyInfos[0]?.cancelTime ||
    null;

await updateHotelTransaction(
    data.transactionId,
    {
        "cancellation.allowed":
            Boolean(cancellationPolicies),

        "cancellation.deadline":
            cancellationDeadline,

        "cancellation.policy": {
            refundableTag,
            cancelPolicyInfos,
            hotelRemarks:
                cancellationPolicies.hotelRemarks || []
        },

        "cancellation.status":
            "ACTIVE"
    }
);

console.log(
    "📅 POLITIQUE D'ANNULATION ENREGISTRÉE:",
    {
        refundableTag,
        cancellationDeadline
    }
);

// ============================================================
// 🎉 BOOK LITEAPI RÉUSSI → CONFIRMED IMMÉDIATEMENT
// ============================================================

await updateHotelTransactionStatus(
    data.transactionId,
    HOTEL_TRANSACTION_STATUS.CONFIRMED,
    {
        "provider.bookingId":
            bookingId,

        "provider.confirmationNumber":
            confirmationNumber,

        "provider.hotelId":
            selectedOffer.hotelId,

        "provider.hotelName":
            selectedOffer.hotelName,

        "provider.roomName":
            selectedOffer.roomName,

        confirmedAt:
            new Date()
    }
);

console.log(
    `🎉 TRANSACTION ${data.transactionId} → CONFIRMED`
);
    // ========================================================
    // RÉSULTAT FINAL
    // ========================================================

    const finalBooking = {

        success: true,

        paymentId:
            data.paymentId,

        paymentMethod:
            data.paymentMethod,
            
            // 📧 Coordonnées client
    email: data.email,
    fullName: data.fullName,
    phone: data.phone,


        bookingId,

        confirmationNumber,

        hotelId:
            selectedOffer.hotelId ||
            data.hotelId,

        hotelName:
            selectedOffer.hotelName ||
            data.hotelName,
            hotelAddress:
    selectedOffer.hotelAddress ||
    data.hotelAddress ||
    "",

hotelOwner:
    selectedOffer.hotelOwner ||
    data.hotelOwner ||
    "",
    hotelPhone:
    selectedOffer.hotelPhone ||
    "",

hotelEmail:
    selectedOffer.hotelEmail ||
    "",

hotelWebsite:
    selectedOffer.hotelWebsite ||
    "",

        roomName:
            selectedOffer.roomName ||
            data.roomName,

        city:
            data.city,

        countryCode:
            data.countryCode,

        checkIn:
            data.checkIn,

        checkOut:
            data.checkOut,

       adults:
    data.adults,

children:
    data.children,

// 👥 VOYAGEURS
guests:
    Array.isArray(data.guests)
        ? data.guests
        : [],

totalPersons:
    Number(data.adults || 0) +
    Number(data.children || 0),

rooms:
    data.rooms,

        providerPrice:
            selectedOffer.price ||
            data.providerPrice,

        providerCurrency:
            selectedOffer.currency ||
            data.providerCurrency,

        liteApiResponse:
            bookingResult

    };

    console.log(
        "======================================"
    );

    console.log(
        "🎉 RÉSERVATION HÔTEL TERMINÉE"
    );

    console.log(
        JSON.stringify(
            {
                success:
                    finalBooking.success,

                paymentId:
                    finalBooking.paymentId,

                bookingId:
                    finalBooking.bookingId,

                confirmationNumber:
                    finalBooking.confirmationNumber,

                hotelName:
                    finalBooking.hotelName,

                city:
                    finalBooking.city,

                checkIn:
                    finalBooking.checkIn,

                checkOut:
                    finalBooking.checkOut

            },
            null,
            2
        )
    );

    console.log(
        "======================================"
    );

    // ========================================================
    // ÉTAPE SUIVANTE
    // ========================================================
    //
    // Ici nous brancherons :
    //
    // ========================================================
// GÉNÉRATION + ENVOI CONFIRMATION
// ========================================================

try {

   

    const documentResult =
        await generateAndSendHotelConfirmation(
            finalBooking
        );
       await updateHotelTransactionStatus

    finalBooking.pdfUrl =
        documentResult.pdfUrl;

    finalBooking.confirmationNumber =
        documentResult.reference;

} catch (error) {

    console.error(
        "❌ HOTEL PDF / EMAIL ERROR:",
        error
    );

    /*
     * IMPORTANT :
     *
     * La réservation LiteAPI est déjà confirmée.
     *
     * Une erreur PDF/email ne doit donc
     * PAS être considérée comme une
     * annulation de réservation.
     */

}

// ========================================================
// 📧 NOTIFICATION ADMIN
// ========================================================

try {

    await sendHotelAdminNotification(
        finalBooking,
        finalBooking.confirmationNumber
    );

    console.log(
        "📧 NOTIFICATION ADMIN ENVOYÉE"
    );

} catch (error) {

    console.error(
        "❌ NOTIFICATION ADMIN ERROR:",
        error
    );

}

// ========================================================
// RETOUR FINAL
// ========================================================

return finalBooking;
}
// ========================================================

// ============================================================
// FIN BLOC 4
// ============================================================
// ============================================================
// TOURIZIA — BLOC 5/5
// PDF HÔTEL + CLOUDINARY + EMAIL RESEND
// ============================================================

// ============================================================
// IMPORTS SUPPLÉMENTAIRES
// ============================================================
//
// IMPORTANT :
// Ces imports doivent être placés en HAUT du fichier
// avec les autres imports.
//
// Si tu les as déjà dans index.js,
// NE LES DUPLIQUE PAS.
//
// import fs from "fs";
// import path from "path";
// import { Resend } from "resend";
// import { v2 as cloudinary } from "cloudinary";
// import puppeteer from "puppeteer-core";
//
// ============================================================


// ============================================================
// CONFIGURATION RESEND
// ============================================================

const resend =
    process.env.RESEND_API_KEY
        ? new Resend(
            process.env.RESEND_API_KEY
        )
        : null;


// ============================================================
// CONFIGURATION CLOUDINARY
// ============================================================

cloudinary.config({

    cloud_name:
        process.env.CLOUDINARY_CLOUD_NAME,

    api_key:
        process.env.CLOUDINARY_API_KEY,

    api_secret:
        process.env.CLOUDINARY_API_SECRET

});


// ============================================================
// GÉNÉRER NUMÉRO DE RÉSERVATION TOURIZIA
// ============================================================

function generateHotelReference() {

    return (
        "TZH-" +
        Date.now()
            .toString(36)
            .toUpperCase()
    );

}


// ============================================================
// FORMAT DATE
// ============================================================

function formatHotelDate(
    date
) {

    if (!date) {
        return "";
    }

    const d =
        new Date(date);

    if (
        Number.isNaN(
            d.getTime()
        )
    ) {

        return date;

    }

    return d.toLocaleDateString(
        "fr-FR",
        {
            day: "2-digit",
            month: "long",
            year: "numeric"
        }
    );

}


// ============================================================
// ÉCHAPPER HTML
// ============================================================

function escapeHtml(
    value
) {

    return String(
        value ?? ""
    )
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );

}
// ============================================================
// DÉLAI D'ANNULATION HÔTEL     
// ============================================================

function getHotelCancellationDeadline(checkIn) {

    if (!checkIn) {
        return "";
    }

    const date = new Date(checkIn);

   date.setDate(date.getDate() - 3);

    return date.toLocaleDateString(
        "fr-FR",
        {
            day: "numeric",
            month: "long",
            year: "numeric"
        }
    );
}
// ============================================================
// 🌍 NOM COMPLET DU PAYS POUR LE PDF
// ============================================================

function getHotelCountryName(countryCode) {

    const code =
        String(countryCode || "")
            .trim()
            .toUpperCase();

    if (!code) {
        return "";
    }

    try {

        const displayNames =
            new Intl.DisplayNames(
                ["fr"],
                {
                    type: "region"
                }
            );

        const name =
            displayNames.of(code);

        if (name) {
            return name;
        }

    } catch (error) {

        console.warn(
            "⚠️ Impossible de convertir le pays:",
            code
        );

    }

    // Fallback
    const countries = {

        FR: "France",
        ES: "Espagne",
        SN: "Sénégal",
        GB: "Royaume-Uni",
        IT: "Italie",
        PT: "Portugal",
        DE: "Allemagne",
        BE: "Belgique",
        CH: "Suisse",
        MA: "Maroc",
        TR: "Turquie",
        AE: "Émirats arabes unis",
        US: "États-Unis",
        CA: "Canada"

    };

    return (
        countries[code] ||
        countryCode
    );
}

// ============================================================
// CONSTRUIRE HTML DU DOCUMENT HÔTEL
// ============================================================

function buildHotelPDFHTML(
    data
) {

    const reference =
        data.confirmationNumber ||
        data.bookingId ||
        generateHotelReference();

   const hotelName =
    data.hotelName ||
    "Établissement";

const hotelAddress =
    data.hotelAddress ||
    "Adresse non disponible";


const hotelOwner =
    data.hotelOwner ||
    "";

const roomName =
    data.roomName ||
    "Type de chambre non précisé";

const destination =
    data.city ||
    "";

 // ✅ PAYS AVANT TOUTE UTILISATION
    const country =
        getHotelCountryName(data.countryCode);

    const hotelAddressForPdf =
        hotelAddress.replace(
            new RegExp(
                `,\\s*${String(data.countryCode || "").trim()}$`,
                "i"
            ),
            `, ${country}`
        );


    const checkIn =
        formatHotelDate(
            data.checkIn
        );

    const checkOut =
        formatHotelDate(
            data.checkOut
        );

    const durationNights =
        Math.max(
            0,
            Math.round(
                (
                    new Date(data.checkOut) -
                    new Date(data.checkIn)
                ) /
                (1000 * 60 * 60 * 24)
            )
        );

    const adults =
        Number(data.adults || 0);

    const children =
        Number(data.children || 0);

    const rooms =
        Number(data.rooms || 1);
        const cancellationDeadline =
    getHotelCancellationDeadline(
        data.checkIn
    );

    const refundable =
        data.refundable || null;
        
const cancellationPolicy = `
Annulation gratuite jusqu'au ${cancellationDeadline},
sous réserve des conditions d'annulation confirmées
par l'établissement et LiteAPI.

Toute annulation effectuée après cette date limite
peut entraîner des frais conformément à la politique
d'annulation confirmée pour la réservation.

En cas de non-présentation à l'hôtel ou à l'établissement,
des frais peuvent être appliqués conformément à la
politique confirmée par le fournisseur.
`;


    const customer =
        data.guestName ||
        data.fullName ||
        "Client Tourizia";

    const guestType =
        data.guestType ||
        "adult";

    const guestNumber =
        Number(data.guestNumber || 1);

    const totalGuests =
        Number(data.totalGuests || 1);

    return `

<!DOCTYPE html>

<html lang="fr">

<head>

<meta charset="UTF-8">

<title>
Confirmation réservation hôtel ${escapeHtml(reference)}
</title>

<style>

* {
    box-sizing: border-box;
}

@page {
    size: A4;
    margin: 0;
}

html,
body {
    width: 210mm;
    margin: 0;
    padding: 0;
}

body {

    background: #ffffff;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

    color: #17212b;

}

.page {

    width: 210mm;
    height: 297mm;
    margin: 0;
    padding: 10mm 12mm;

    overflow: visible;

    background: #ffffff;
}

.header {

    padding: 18px 30px;

    background:
        linear-gradient(
            135deg,
            #08b8b0,
            #087f91
        );

    color: #ffffff;

}

.logo {

    font-size: 27px;

    font-weight: 800;

}

.header-subtitle {

    margin-top: 5px;

    font-size: 13px;

}

.reference {

    margin-top: 11px;

    padding-top: 11px;

    border-top:
        1px solid
        rgba(255,255,255,0.30);

    display: flex;

    justify-content:
        space-between;

}

.reference-label {

    font-size: 10px;

    text-transform:
        uppercase;

    opacity: .8;

}

.reference-value {

    margin-top: 3px;

    font-size: 17px;

    font-weight: 700;

}

.content {

    padding: 20px 30px;

}

.status {

    display: inline-block;

    padding: 5px 12px;

    border-radius: 30px;

    background: #e8f8f3;

    color: #16805d;

    font-weight: 700;

    font-size: 11px;

    margin-bottom: 14px;

}

.hotel-name {

    font-size: 22px;

    font-weight: 800;

    margin-bottom: 4px;

}

.location {

    color: #687580;

    font-size: 12px;

    line-height: 1.5;

    margin-bottom: 6px;

}

.hotel-owner {

    font-size: 11px;

    color: #7a858e;

    margin-bottom: 15px;

}

.hotel-owner strong {

    color: #17212b;

}

.grid {

    display: grid;

    grid-template-columns:
        1fr 1fr;

    gap: 8px;

}

.card {

    border:
        1px solid #e5e9ed;

    border-radius: 12px;

    padding: 11px 13px;

}

.label {

    font-size: 10px;

    text-transform:
        uppercase;

    color: #7a858e;

    margin-bottom: 4px;

}

.value {

    font-size: 14px;

    font-weight: 700;

}

.section {

    margin-top: 14px;

}

.section-title {

    font-size: 15px;

    font-weight: 800;

    margin-bottom: 7px;

}

.details {

    border:
        1px solid #e5e9ed;

    border-radius: 12px;

    overflow: hidden;

}

.row {

    display: flex;

    justify-content:
        space-between;

    padding: 7px 13px;

    border-bottom:
        1px solid #edf0f2;

    font-size: 12px;

}

.row:last-child {

    border-bottom: none;

}

.row-label {

    color: #6c7882;

}

.row-value {

    font-weight: 700;

    text-align: right;

}

.notice {

    margin-top: 13px;

    padding: 10px 13px;

    background: #f3f8fa;

    border-radius: 12px;

    color: #53616c;

    font-size: 10px;

    line-height: 1.35;

}

.footer {

    padding: 11px 30px;

    background: #f7f9fa;

    color: #7b858d;

    font-size: 9px;

    line-height: 1.3;

}

.footer strong {

    color: #17212b;

}

</style>

</head>

<body>

<div class="page">

    <div class="header">

        <div class="logo">
            TOURIZIA
        </div>

        <div class="header-subtitle">
            Confirmation de réservation hôtel
        </div>

        <div class="reference">

            <div>

                <div class="reference-label">
                    Référence
                </div>

                <div class="reference-value">
                    ${escapeHtml(reference)}
                </div>

            </div>

            <div style="text-align:right">

                <div class="reference-label">
                    Statut
                </div>

                <div class="reference-value">
                    Confirmée
                </div>

            </div>

        </div>

    </div>


    <div class="content">

        <div class="status">
            ✓ RÉSERVATION CONFIRMÉE
        </div>


       <div class="hotel-name">
    Destination
</div>

<div class="location">
    ${escapeHtml(destination)}
    ${country ? " — " + escapeHtml(country) : ""}
</div>

<div
    style="
        margin-top:12px;
        font-size:13px;
        color:#53616c;
        line-height:1.5;
    "
>
    <strong>Hôtel :</strong>
    ${escapeHtml(hotelName)}
</div>

<div
    style="
        margin-top:6px;
        font-size:13px;
        color:#53616c;
        line-height:1.5;
    "
>
    <strong>Adresse :</strong>
    ${escapeHtml(hotelAddress)}
</div>


        ${
            hotelOwner
                ? `
                    <div class="hotel-owner">
                        Propriétaire :
                        <strong>
                            ${escapeHtml(hotelOwner)}
                        </strong>
                    </div>
                  `
                : ""
        }


        <div class="grid">

            <div class="card">

                <div class="label">
                    Arrivée
                </div>

                <div class="value">
                    ${escapeHtml(checkIn)}
                </div>

            </div>


            <div class="card">

                <div class="label">
                    Départ
                </div>

                <div class="value">
                    ${escapeHtml(checkOut)}
                </div>

            </div>


            <div class="card">

                <div class="label">
                    Voyageur
                </div>

                <div class="value">
                    ${escapeHtml(customer)}
                </div>

                <div
                    style="
                        margin-top:6px;
                        font-size:11px;
                        color:#6c7882;
                    "
                >
                    Personne
                    ${guestNumber}
                    sur
                    ${totalGuests}
                </div>

                <div
                    style="
                        margin-top:3px;
                        font-size:11px;
                        color:#6c7882;
                    "
                >
                    ${
                        guestType === "child"
                            ? "Enfant"
                            : "Adulte"
                    }
                </div>

            </div>


            <div class="card">

    <div class="label">
        Adresse de l'établissement
    </div>

    <div
        class="value"
        style="
            font-size:12px;
            line-height:1.45;
        "
    >
        ${escapeHtml(hotelAddress)}
    </div>

</div>

        </div>
        <div class="section">

    <div class="section-title">
        Coordonnées de l'établissement
    </div>

    <div class="details">

        <div class="row">

            <div class="row-label">
                Hôtel
            </div>

            <div class="row-value">
                ${escapeHtml(hotelName)}
            </div>

        </div>

        <div class="row">

            <div class="row-label">
                Adresse
            </div>

            <div class="row-value">
                ${escapeHtml(hotelAddress)}
            </div>

        </div>

        ${
            data.hotelPhone
                ? `
                    <div class="row">

                        <div class="row-label">
                            Téléphone
                        </div>

                        <div class="row-value">
                            ${escapeHtml(data.hotelPhone)}
                        </div>

                    </div>
                  `
                : ""
        }

        ${
            data.hotelEmail
                ? `
                    <div class="row">

                        <div class="row-label">
                            Email
                        </div>

                        <div class="row-value">
                            ${escapeHtml(data.hotelEmail)}
                        </div>

                    </div>
                  `
                : ""
        }

        ${
            data.hotelWebsite
                ? `
                    <div class="row">

                        <div class="row-label">
                            Site web
                        </div>

                        <div class="row-value">
                            ${escapeHtml(data.hotelWebsite)}
                        </div>

                    </div>
                  `
                : ""
        }

    </div>

</div>


        <div class="section">

            <div class="section-title">
                Détails du séjour
            </div>

            <div class="details">

                <div class="row">

                    <div class="row-label">
                        Durée
                    </div>

                    <div class="row-value">

                        ${durationNights}

                        nuit${
                            durationNights > 1
                                ? "s"
                                : ""
                        }

                    </div>

                </div>


                <div class="row">

                    <div class="row-label">
                        Chambres
                    </div>

                    <div class="row-value">
                        ${rooms}
                    </div>

                </div>


                <div class="row">

                    <div class="row-label">
                        Voyageurs
                    </div>

                    <div class="row-value">
                        ${adults + children}
                    </div>

                </div>


                <div class="row">

                    <div class="row-label">
                        Adultes
                    </div>

                    <div class="row-value">
                        ${adults}
                    </div>

                </div>


                <div class="row">

                    <div class="row-label">
                        Enfants
                    </div>

                    <div class="row-value">
                        ${children}
                    </div>

                </div>


                <div class="row">

                    <div class="row-label">
                        Fournisseur
                    </div>

                    <div class="row-value">
                        LiteAPI
                    </div>

                </div>


                <div class="row">

    <div class="row-label">
        Booking ID
    </div>

    <div class="row-value">
        ${escapeHtml(
            data.bookingId ||
            "Non disponible"
        )}
    </div>

</div>

</div> 

            </div>

        </div>


        ${
            refundable
                ? `
                    <div class="section">

                        <div class="section-title">
                            Conditions tarifaires
                        </div>

                        <div class="notice">

                            ${escapeHtml(
                                typeof refundable === "string"
                                    ? refundable
                                    : JSON.stringify(
                                        refundable
                                    )
                            )}

                        </div>

                    </div>
                  `
                : ""
        }

        <div class="section">

    <div class="section-title">
        Politique d'annulation
    </div>

    <div class="notice">

        <strong>
            Restez flexible !
        </strong>

        <div style="
            margin-top:7px;
            white-space:pre-line;
        ">
            ${escapeHtml(cancellationPolicy)}
        </div>

    </div>

</div>
<div class="section">

    <div class="section-title">
        Remarques
    </div>

    <div class="notice">

        <div style="margin-bottom:4px;">
            <strong>• Arrivée :</strong>
            Pièce d'identité officielle obligatoire.
        </div>

        <div style="margin-bottom:4px;">
            <strong>• Frais supplémentaires :</strong>
            Les services non inclus peuvent être facturés par l'hôtel.
        </div>

        <div>
            <strong>• Petit-déjeuner :</strong>
            Des conditions spécifiques peuvent s'appliquer aux enfants.
        </div>

    </div>

</div>


<div class="notice">

    <strong>
        Important
    </strong>

    <div style="margin-top:4px;">
        Cette confirmation atteste de la réservation
        traitée par Tourizia auprès de son fournisseur hôtelier.
    </div>

    <div style="margin-top:3px;">
        Conservez cette référence pour votre séjour.
    </div>

</div>


<div class="footer">

    <strong>TOURIZIA</strong>

    — Votre réservation hôtel est confirmée.

    <br>

    Pour toute question concernant votre réservation,
    contactez le support Tourizia.

</div>

</div>

</body>

</html>

`;

}


// ============================================================
// GÉNÉRATION PDF AVEC PUPPETEER
// ============================================================

async function generateHotelPDF(html) {

    const possibleChromePaths = [
        "/opt/render/project/src/.puppeteer/chrome",
        "/opt/render/.cache/puppeteer",
        "/opt/render/project/src/.cache/puppeteer"
    ];

    let executablePath =
        process.env.CHROME_EXECUTABLE_PATH ||
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        null;

    const findChrome = (dir) => {

        if (!fs.existsSync(dir)) {
            return null;
        }

        for (const entry of fs.readdirSync(dir, {
            withFileTypes: true
        })) {

            const fullPath =
                path.join(dir, entry.name);

            if (
                entry.isFile() &&
                entry.name === "chrome"
            ) {
                return fullPath;
            }

            if (entry.isDirectory()) {

                const found =
                    findChrome(fullPath);

                if (found) {
                    return found;
                }
            }
        }

        return null;
    };

    if (!executablePath) {

        for (const chromePath of possibleChromePaths) {

            console.log(
                "🔎 RECHERCHE CHROME:",
                chromePath
            );

            executablePath =
                findChrome(chromePath);

            if (executablePath) {
                break;
            }
        }
    }

    if (!executablePath) {

        console.error(
            "❌ CHROME INTROUVABLE"
        );

        console.error(
            "PWD:",
            process.cwd()
        );

        console.error(
            "PUPPETEER_CACHE_DIR:",
            process.env.PUPPETEER_CACHE_DIR
        );

        throw new Error(
            "Chrome introuvable sur Render"
        );
    }

    console.log(
        "🌐 CHROME UTILISÉ:",
        executablePath
    );

    const browser =
        await puppeteer.launch({
            executablePath,
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage"
            ]
        });

    try {

        const page =
            await browser.newPage();

       await page.setContent(
    html,
    {
        waitUntil: "domcontentloaded",
        timeout: 30000
    }
);

        const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    scale: 0.82,
    margin: {
        top: "0",
        right: "0",
        bottom: "0",
        left: "0"
    }
});

        return pdf;

    } finally {

        await browser.close();

    }
}



// ============================================================
// UPLOAD PDF CLOUDINARY
// ============================================================

async function uploadHotelPDF(
    pdf,
    reference
) {

    if (!pdf) {

        throw new Error(
            "PDF hôtel vide"
        );

    }

    const tempPath =
        path.join(
            "/tmp",
            `hotel-${reference}.pdf`
        );

    fs.writeFileSync(
        tempPath,
        pdf
    );

    try {

        const result =
            await cloudinary.uploader.upload(
                tempPath,
                {
                    resource_type:
                        "raw",

                    folder:
                        "tourizia-hotels",

                    public_id:
                        `hotel-${reference}`

                }
            );

        console.log(
            "☁️ HOTEL PDF CLOUDINARY:",
            result.secure_url
        );

        return result.secure_url;

    } finally {

        if (
            fs.existsSync(
                tempPath
            )
        ) {

            fs.unlinkSync(
                tempPath
            );

        }

    }

}


// ============================================================
// ENVOYER EMAIL CLIENT
// ============================================================
async function sendHotelEmail(
    data,
    pdfs,
    reference
) {

const emailPayload = {
    from: "Tourizia <tickets@tourizia.com>",
    to: data.email,
    subject: `🏨 Votre réservation hôtel — ${reference}`,

    html: `
        <div style="
            font-family:Arial,Helvetica,sans-serif;
            max-width:650px;
            margin:auto;
            padding:30px;
            color:#17212b;
        ">

            <h2 style="margin-bottom:8px;">
                TOURIZIA
            </h2>

            <p style="
                color:#08a89f;
                font-weight:bold;
            ">
                ✓ Réservation hôtel confirmée
            </p>

            <p>
                Bonjour ${escapeHtml(
                    data.fullName || "cher client"
                )},
            </p>

            <p>
                Votre réservation hôtel a bien été confirmée.
            </p>

            <div style="
                background:#f4f8f9;
                padding:20px;
                border-radius:12px;
                margin:20px 0;
            ">

                <strong>
                    ${escapeHtml(
                        data.hotelName || "Votre hôtel"
                    )}
                </strong>

                <br>

                ${escapeHtml(data.city || "")}

                <br><br>

                <strong>Arrivée :</strong>
                ${escapeHtml(
                    formatHotelDate(data.checkIn)
                )}

                <br>

                <strong>Départ :</strong>
                ${escapeHtml(
                    formatHotelDate(data.checkOut)
                )}

                <br><br>

                <strong>Référence :</strong>
                ${escapeHtml(reference)}

            </div>

            <p>
                Vous trouverez votre confirmation de réservation
                en pièce jointe de cet email.
            </p>

            <p>
                Merci d'avoir choisi <strong>Tourizia</strong>.
            </p>

        </div>
    `,

   attachments:
    pdfs
};

console.log(
    "📨 ATTACHMENT PRESENT:",
    !!emailPayload.attachments
);

console.log(
    "📨 ATTACHMENT CONTENT TYPE:",
    typeof emailPayload.attachments[0].content
);

console.log(
    "📨 ATTACHMENT CONTENT LENGTH:",
    emailPayload.attachments[0].content.length
);

try {

    const result = await resend.emails.send(emailPayload);

    console.log(
        "📧 RESEND RESULT:",
        JSON.stringify(result, null, 2)
    );

    if (result.error) {
        throw new Error(
            `Resend error: ${result.error.name} - ${result.error.message}`
        );
    }

    return result;

} catch (error) {

    console.error(
        "❌ RESEND SEND ERROR:",
        error
    );

    throw error;
}
}
// ============================================================
// 📧 NOTIFICATION ADMIN HÔTEL
// ============================================================

async function sendHotelAdminNotification(
    data,
    reference
) {

    const adminEmail =
        "contact@tourizia.com";


    const guestsText =
        Array.isArray(data.guests)
            ? data.guests
                .map(
                    (guest, index) =>
                        `${index + 1}. ${guest.firstName || ""} ${guest.lastName || ""} (${guest.type || "adult"})`
                )
                .join("<br>")
            : "Non renseigné";


    const emailPayload = {

        from:
            "Tourizia <tickets@tourizia.com>",

        to:
            adminEmail,

        subject:
            `🏨 Nouvelle réservation hôtel — ${reference}`,

        html: `

            <div
                style="
                    font-family:Arial,Helvetica,sans-serif;
                    max-width:700px;
                    margin:auto;
                    padding:30px;
                    color:#17212b;
                "
            >

                <h2>
                    🏨 TOURIZIA — Nouvelle réservation hôtel
                </h2>

                <p
                    style="
                        color:#08a89f;
                        font-weight:bold;
                    "
                >
                    ✓ Paiement reçu et réservation traitée
                </p>


                <div
                    style="
                        background:#f4f8f9;
                        padding:20px;
                        border-radius:12px;
                        margin:20px 0;
                    "
                >

                    <strong>Référence :</strong>
                    ${escapeHtml(reference)}

                    <br><br>

                    <strong>Client :</strong>
                    ${escapeHtml(data.fullName || "")}

                    <br>

                    <strong>Email :</strong>
                    ${escapeHtml(data.email || "")}

                    <br>

                    <strong>Téléphone :</strong>
                    ${escapeHtml(data.phone || "")}

                </div>


                <div
                    style="
                        background:#ffffff;
                        border:1px solid #e5e7eb;
                        padding:20px;
                        border-radius:12px;
                    "
                >

                    <h3>
                        Réservation
                    </h3>

                    <strong>Hôtel :</strong>
                    ${escapeHtml(data.hotelName || "")}

                    <br>

                    <strong>Ville :</strong>
                    ${escapeHtml(data.city || "")}

                    <br>

                    <strong>Chambre :</strong>
                    ${escapeHtml(data.roomName || "")}

                    <br>

                    <strong>Arrivée :</strong>
                    ${escapeHtml(
                        formatHotelDate(
                            data.checkIn
                        )
                    )}

                    <br>

                    <strong>Départ :</strong>
                    ${escapeHtml(
                        formatHotelDate(
                            data.checkOut
                        )
                    )}

                    <br>

                    <strong>Adultes :</strong>
                    ${Number(data.adults || 0)}

                    <br>

                    <strong>Enfants :</strong>
                    ${Number(data.children || 0)}

                    <br>

                    <strong>Total personnes :</strong>
                    ${Number(data.totalPersons || 0)}

                    <br>

                    <strong>Chambres :</strong>
                    ${Number(data.rooms || 1)}

                </div>


                <div
                    style="
                        margin-top:20px;
                        padding:20px;
                        background:#f8fafc;
                        border-radius:12px;
                    "
                >

                    <h3>
                        👥 Voyageurs
                    </h3>

                    ${guestsText}

                </div>


                <p
                    style="
                        margin-top:25px;
                        color:#6c7882;
                    "
                >
                    Cette notification a été générée
                    automatiquement par Tourizia
                    après le paiement et le traitement
                    de la réservation hôtel.
                </p>

            </div>

        `

    };


    try {

        const result =
            await resend.emails.send(
                emailPayload
            );


        console.log(
            "📧 ADMIN HOTEL NOTIFICATION:",
            JSON.stringify(
                result,
                null,
                2
            )
        );


        if (result.error) {

            throw new Error(
                `Resend admin error: ${result.error.name} - ${result.error.message}`
            );

        }


        return result;


    } catch (error) {

        console.error(
            "❌ ADMIN HOTEL EMAIL ERROR:",
            error
        );

        // IMPORTANT :
        // Une erreur de notification admin
        // ne doit jamais annuler la réservation.

        return null;

    }

}
// ============================================================
// TRAITEMENT DOCUMENT APRÈS BOOK
// ============================================================

async function generateAndSendHotelConfirmation(
    booking
) {

    console.log(
        "📄 GÉNÉRATION DOCUMENTS HÔTEL..."
    );


    // ========================================================
    // RÉFÉRENCE UNIQUE
    // ========================================================

    const reference =
        booking.confirmationNumber ||
        booking.bookingId ||
        generateHotelReference();

    booking.confirmationNumber =
        reference;


    // ========================================================
    // VOYAGEURS
    // ========================================================

    const guests =
        Array.isArray(booking.guests) &&
        booking.guests.length
            ? booking.guests
            : [{
                type: "adult",

                firstName:
                    booking.fullName
                        ?.split(" ")[0] ||
                    "Client",

                lastName:
                    booking.fullName
                        ?.split(" ")
                        .slice(1)
                        .join(" ") ||
                    "Tourizia"
            }];


    console.log(
        "👥 NOMBRE DE VOYAGEURS:",
        guests.length
    );


    // ========================================================
    // GÉNÉRER UN PDF PAR PERSONNE
    // ========================================================

    const pdfs = [];


    for (
        let i = 0;
        i < guests.length;
        i++
    ) {

        const guest =
            guests[i];


        const guestName =
            `${guest.firstName || ""} ${guest.lastName || ""}`
                .trim();


        console.log(
            `📄 PDF VOYAGEUR ${i + 1}/${guests.length}:`,
            guestName
        );


        const guestBooking = {

            ...booking,

            // Personne concernée
            guestName,

            guestType:
                guest.type || "adult",

            guestNumber:
                i + 1,

            totalGuests:
                guests.length

        };


        // ----------------------------------------------------
        // HTML PDF
        // ----------------------------------------------------

        const html =
            buildHotelPDFHTML(
                guestBooking
            );


        // ----------------------------------------------------
        // PDF
        // ----------------------------------------------------

        const pdf =
            await generateHotelPDF(
                html
            );


        console.log(
            "📄 PDF GENERATED:",
            i + 1,
            pdf?.length || 0
        );


        // ----------------------------------------------------
        // PIÈCE JOINTE
        // ----------------------------------------------------

        pdfs.push({

    filename:
        `reservation-hotel-${reference}-personne-${i + 1}.pdf`,

    content:
        Buffer.from(pdf).toString("base64"),

    content_type:
        "application/pdf"

});

    }


    // ========================================================
    // EMAIL UNIQUE AVEC TOUS LES PDF
    // ========================================================

    await sendHotelEmail(
        booking,
        pdfs,
        reference
    );


    console.log(
        "======================================"
    );

    console.log(
        "🎉 DOCUMENTS HÔTEL ENVOYÉS"
    );

    console.log(
        "REFERENCE:",
        reference
    );

    console.log(
        "EMAIL:",
        booking.email
    );

    console.log(
        "PDF:",
        pdfs.length
    );

    console.log(
        "======================================"
    );


    return {

        reference,

        pdfUrl:
            null

    };

}

// ============================================================
// ENDPOINT DE TEST PDF HÔTEL
// ============================================================
//
// Permet de tester la génération du PDF sans
// effectuer une réservation réelle.
//
// ============================================================

app.post(
    "/api/test-hotel-pdf",
    async (req, res) => {

        try {

            const data = {

                paymentId:
                    req.body.paymentId ||
                    "TEST",

                bookingId:
                    req.body.bookingId ||
                    "TEST-BOOKING",

                confirmationNumber:
                    req.body.confirmationNumber ||
                    generateHotelReference(),

                fullName:
                    req.body.fullName ||
                    "Client Test",

                email:
                    req.body.email,

                city:
                    req.body.city ||
                    "Paris",

                countryCode:
                    req.body.countryCode ||
                    "FR",

                hotelName:
                    req.body.hotelName ||
                    "Hotel Test Tourizia",

                roomName:
                    req.body.roomName ||
                    "Double Room",

                checkIn:
                    req.body.checkIn ||
                    "2026-09-10",

                checkOut:
                    req.body.checkOut ||
                    "2026-09-12",

                adults:
                    Number(
                        req.body.adults ||
                        2
                    ),

                children:
                    Number(
                        req.body.children ||
                        0
                    ),

                rooms:
                    Number(
                        req.body.rooms ||
                        1
                    )

            };

            const html =
                buildHotelPDFHTML(
                    data
                );

            const pdf =
                await generateHotelPDF(
                    html
                );

            /*
             * On renvoie le PDF directement
             * pour faciliter le test.
             */

            res.setHeader(
                "Content-Type",
                "application/pdf"
            );

            res.setHeader(
                "Content-Disposition",
                `attachment; filename="hotel-${data.confirmationNumber}.pdf"`
            );

            res.send(
                pdf
            );

        } catch (error) {

            console.error(
                "❌ TEST HOTEL PDF ERROR:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);
// ============================================================
// TEST EMAIL PDF HÔTEL
// ============================================================

app.post(
    "/api/test-hotel-email",
    async (req, res) => {

        try {

            const data = {

                paymentId:
                    req.body.paymentId ||
                    "TEST",

                bookingId:
                    req.body.bookingId ||
                    "TEST-BOOKING",

                confirmationNumber:
                    req.body.confirmationNumber ||
                    generateHotelReference(),

                fullName:
                    req.body.fullName ||
                    "Client Test",

                email:
                    req.body.email,

                city:
                    req.body.city ||
                    "Paris",

                countryCode:
                    req.body.countryCode ||
                    "FR",

                hotelName:
                    req.body.hotelName ||
                    "Hotel Test Tourizia",

                roomName:
                    req.body.roomName ||
                    "Double Room",

                checkIn:
                    req.body.checkIn ||
                    "2026-09-10",

                checkOut:
                    req.body.checkOut ||
                    "2026-09-12",

                adults:
                    Number(
                        req.body.adults || 2
                    ),

                children:
                    Number(
                        req.body.children || 0
                    ),

                rooms:
                    Number(
                        req.body.rooms || 1
                    )
            };

            if (!data.email) {

                return res.status(400).json({
                    success: false,
                    error: "Email manquant"
                });

            }

            console.log(
                "📧 TEST EMAIL HOTEL:",
                data.email
            );

            const result =
                await generateAndSendHotelConfirmation(
                    data
                );

            return res.json({

                success: true,

                message:
                    "PDF généré et email envoyé.",

                email:
                    data.email,

                reference:
                    result.reference,

                pdfUrl:
                    result.pdfUrl

            });

        } catch (error) {

            console.error(
                "❌ TEST HOTEL EMAIL ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);
app.post("/api/ping-test", (req, res) => {
    console.log("🔥🔥🔥 PING TEST REÇU");
    res.json({
        success: true,
        message: "Route POST fonctionne"
    });
});

// ============================================================
// FIN DU BLOC 5
// ============================================================
console.log("🔥 TEST ROUTE EMAIL CHARGÉE");
console.log("🔥 PING ROUTE CHARGÉE");


/* ============================================================
   TOURIZIA — DESTINATIONS GÉOGRAPHIQUES MONDIALES
   Source : GeoNames
   Route : GET /api/hotel-destinations?q=Massy
   ============================================================ */

const geoNamesCache = new Map();
const GEONAMES_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 heures

app.get("/api/hotel-destinations", async (req, res) => {
    try {
        const query = String(req.query.q || "").trim();
        const username = process.env.GEONAMES_USERNAME;

        if (query.length < 2 || query.length > 100) {
            return res.status(400).json({
                success: false,
                error: "La destination doit contenir entre 2 et 100 caractères."
            });
        }

        if (!username) {
            console.error("GEONAMES_USERNAME manquant");

            return res.status(503).json({
                success: false,
                error: "Le service de destinations n'est pas configuré."
            });
        }

        // Cache pour limiter les appels GeoNames
        const cacheKey = query.toLocaleLowerCase("fr-FR");
        const cached = geoNamesCache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < GEONAMES_CACHE_TTL) {
            return res.json({
                success: true,
                source: "GeoNames",
                destinations: cached.destinations
            });
        }

        const url = new URL(
            "https://secure.geonames.org/searchJSON"
        );

        url.searchParams.set("q", query);
        url.searchParams.set("maxRows", "10");
        url.searchParams.set("startRow", "0");
        url.searchParams.set("featureClass", "P");
        url.searchParams.set("orderby", "relevance");
        url.searchParams.set("lang", "fr");
        url.searchParams.set("username", username);

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                "Accept": "application/json"
            },
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
            throw new Error(
                `GeoNames HTTP ${response.status}`
            );
        }

        const result = await response.json();

        if (result.status) {
            console.error("GeoNames API:", result.status);

            return res.status(502).json({
                success: false,
                error: "Le service géographique a retourné une erreur."
            });
        }

        const records = Array.isArray(result.geonames)
            ? result.geonames
            : [];

        const unique = new Map();

        for (const place of records) {
            if (!place.name || !place.countryCode) continue;

            const destination = {
                name: place.name,
                country: place.countryName || "",
                countryCode: place.countryCode.toUpperCase(),
                region: place.adminName1 || "",
                latitude: place.lat ? Number(place.lat) : null,
                longitude: place.lng ? Number(place.lng) : null,
                featureCode: place.fcode || "",
                geonameId: place.geonameId || null
            };

            const key = [
                destination.name.toLocaleLowerCase("fr-FR"),
                destination.countryCode,
                destination.region.toLocaleLowerCase("fr-FR")
            ].join("|");

            if (!unique.has(key)) {
                unique.set(key, destination);
            }
        }

        const destinations = Array.from(unique.values());

        // Cache limité pour éviter une croissance illimitée
        if (geoNamesCache.size >= 500) {
            const oldestKey = geoNamesCache.keys().next().value;
            if (oldestKey) geoNamesCache.delete(oldestKey);
        }

        geoNamesCache.set(cacheKey, {
            timestamp: Date.now(),
            destinations
        });

        return res.json({
            success: true,
            source: "GeoNames",
            destinations
        });

    } catch (error) {
        console.error(
            "❌ HOTEL DESTINATIONS ERROR:",
            error.message
        );

        return res.status(502).json({
            success: false,
            error: "Impossible de rechercher les destinations pour le moment."
        });
    }
});


// ============================================================
// 🏨 AUTOCOMPLETE HÔTELS TOURIZIA
// Recherche par ville + code pays avec LiteAPI
// ============================================================

app.get("/api/hotel-autocomplete", async (req, res) => {
    try {
        const cityName = String(
            req.query.cityName || ""
        ).trim();

        const countryCode = String(
            req.query.countryCode || ""
        ).trim().toUpperCase();

        // Les deux paramètres sont obligatoires.
        // Exemple : cityName=Paris&countryCode=FR

        if (
            cityName.length < 2 ||
            !/^[A-Z]{2}$/.test(countryCode)
        ) {
            return res.json({
                success: true,
                hotels: []
            });
        }

        // ==================================================
        // 🔎 REQUÊTE LITEAPI
        // ==================================================

        const hotelUrl = new URL(
            `${LITEAPI_BASE_URL}/data/hotels`
        );

        hotelUrl.searchParams.set(
            "cityName",
            cityName
        );

        hotelUrl.searchParams.set(
            "countryCode",
            countryCode
        );

        hotelUrl.searchParams.set(
            "limit",
            "8"
        );

        console.log(
            "🏨 HOTEL AUTOCOMPLETE:",
            cityName,
            countryCode
        );

        const response = await fetch(
            hotelUrl.toString(),
            {
                method: "GET",
                headers: {
                    "X-API-Key": LITEAPI_API_KEY,
                    "Accept": "application/json"
                }
            }
        );

        const result = await response.json();

        // ==================================================
        // ❌ ERREUR LITEAPI
        // ==================================================

        if (!response.ok) {
            console.error(
                "❌ LITEAPI HOTEL AUTOCOMPLETE:",
                result
            );

            return res.status(response.status).json({
                success: false,
                error:
                    result.message ||
                    result.error ||
                    result.description ||
                    "Erreur LiteAPI"
            });
        }

        // ==================================================
        // 🏨 NORMALISATION DES RÉSULTATS
        // ==================================================

        const hotels = Array.isArray(result.data)
            ? result.data
            : [];

        const suggestions = hotels
            .slice(0, 8)
            .map(hotel => ({
                type: "hotel",

                hotelId:
                    hotel.id || "",

                name:
                    hotel.name || "",

                city:
                    hotel.city ||
                    hotel.city_name ||
                    cityName,

                country:
                    hotel.country ||
                    hotel.country_code ||
                    countryCode,

                address:
                    hotel.address || "",

                stars:
                    hotel.stars ||
                    hotel.rating ||
                    null,

                photo:
                    hotel.thumbnail ||
                    hotel.main_photo ||
                    ""
            }));

        return res.json({
            success: true,
            hotels: suggestions
        });

    } catch (error) {
        console.error(
            "❌ HOTEL AUTOCOMPLETE EXCEPTION:",
            error
        );

        return res.status(500).json({
            success: false,
            error: "Impossible de rechercher les hôtels."
        });
    }
});

// ============================================================
// SERVER
// ============================================================

async function startServer() {

    await connectMongoDB();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

}

startServer();