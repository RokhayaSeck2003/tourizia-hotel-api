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

dotenv.config();

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
    process.env.PAYTECH_ENV || "production";

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

const HOTEL_PAYTECH_PRICE = 8500; // XOF 8 500
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

        const metadata =
            session.metadata || {};

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

        globalThis.hotelStripeProcessed =
            globalThis.hotelStripeProcessed ||
            new Set();

        if (
            globalThis.hotelStripeProcessed.has(
                paymentId
            )
        ) {

            console.log(
                "⚠️ HOTEL STRIPE DÉJÀ TRAITÉ:",
                paymentId
            );

            return res.json({
                received: true,
                alreadyProcessed: true
            });

        }

        globalThis.hotelStripeProcessed.add(
            paymentId
        );

        // ----------------------------------------------------
        // DONNÉES RÉSERVATION
        // ----------------------------------------------------

        const offerToken =
    metadata.offerToken;

const pendingPayment =
    offerToken
        ? pendingHotelPayments.get(offerToken)
        : null;

const storedOffer =
    pendingPayment?.offer || null;

        const hotelData = {

    paymentId,

    stripeSessionId:
        session.id,

    paymentMethod:
        "stripe",

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

    // -----------------------------------------------
    // OFFRE LITEAPI PRÉ-SÉLECTIONNÉE
    // -----------------------------------------------

    hotelId:
        storedOffer?.hotelId ||
        metadata.hotelId,

    hotelName:
        storedOffer?.hotelName ||
        metadata.hotelName,

    roomName:
        storedOffer?.roomName ||
        metadata.roomName,

    offerId:
        storedOffer?.offerId ||
        null,

    providerPrice:
        storedOffer?.price ||
        metadata.providerPrice,

    providerCurrency:
        storedOffer?.currency ||
        metadata.providerCurrency ||
        "EUR"


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
// RECHERCHE DES OFFRES LITEAPI
// ============================================================

async function searchHotelOffers(data) {

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

    const occupancies =
        Array.from(
            {
                length: rooms
            },
            () => ({
                adults,
                children:
                    buildChildrenAges(
                        children
                    )
            })
        );

    const requestBody = {

        checkin:
            data.checkIn,

        checkout:
            data.checkOut,

        currency:
            "EUR",

        guestNationality:
            data.guestNationality ||
            "SN",

        occupancies,

        cityName:
            data.city,

        countryCode:
            data.countryCode,

        roomMapping:
            true,

        maxRatesPerHotel:
            1,

        includeHotelData:
            true

    };

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
                headers:
                    liteApiHeaders,
                body:
                    JSON.stringify(
                        requestBody
                    )
            }
        );

    const result =
        await response.json();

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

            const hotelData =
                hotel.hotelData ||
                hotel;

            offers.push({

                hotelId:
                    hotelData.hotelId ||
                    hotel.hotelId ||
                    hotel.id,

                hotelName:
                    hotelData.name ||
                    hotel.name ||
                    "Hotel",

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
                    room.refundableTag ||
                    room.rateTags ||
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
// TROUVER UNE OFFRE RÉSERVABLE
// ============================================================

async function findPrebookableOffer(data) {

    console.log(
        "🔎 RECHERCHE D'UNE OFFRE RÉSERVABLE..."
    );

    const searchResult =
        await searchHotelOffers(
            data
        );

    const offers =
        searchResult.offers || [];

    if (!offers.length) {

        throw new Error(
            "Aucune offre hôtel disponible pour ces dates"
        );

    }

    console.log(
        `🏨 ${offers.length} offre(s) trouvée(s)`
    );

    /*
     * On teste les offres une par une.
     *
     * Si une offre n'est plus disponible,
     * LiteAPI renvoie une erreur.
     *
     * On passe alors automatiquement
     * à l'offre suivante.
     */

    for (
        const offer of offers
    ) {

        try {

            console.log(
                "🧪 TEST OFFER:",
                offer.offerId
            );

            const prebook =
                await prebookHotelOffer(
                    offer.offerId
                );

            console.log(
                "✅ OFFER RÉSERVABLE:",
                offer.offerId
            );

            return {

                offer,

                prebook

            };

        } catch (error) {

            console.warn(
                "⚠️ OFFER NON RÉSERVABLE:",
                offer.offerId
            );

            console.warn(
                error.message
            );

        }

    }

    throw new Error(
        "Aucune offre hôtel n'a pu être pré-réservée"
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

app.post(
  "/create-hotel-payment",
  express.json(),
  async (req, res) => {
      try {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe n'est pas configuré."
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

    console.log("🏨 Création paiement Stripe hôtel...");
    console.log(data);

    // --------------------------------------------------------
    // IMPORTANT :
    // On ne fait PAS confiance à offerId venant du frontend.
    // Le backend recherche lui-même une offre valide.
    // --------------------------------------------------------

  const selectedOfferResult = await findPrebookableOffer(data);

if (!selectedOfferResult || !selectedOfferResult.offer) {
  return res.status(404).json({
    error: "Aucune chambre disponible ou réservable."
  });
}

const selectedOffer = selectedOfferResult.offer;

console.log(
  "✅ Offre sélectionnée :",
  selectedOffer.offerId
);
const offerToken =
  "HOTEL-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);

pendingHotelPayments.set(
  offerToken,
  {
    offer: selectedOffer,
    data
  }
);

console.log(
  "🔐 OFFER TOKEN STRIPE:",
  offerToken
);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      line_items: [
        {
          price_data: {
            currency: "usd",

            product_data: {
              name: "Réservation hôtel — Tourizia",
              description:
                `${data.city} | ${data.checkIn} → ${data.checkOut}`
            },

            unit_amount: HOTEL_STRIPE_PRICE
          },

          quantity: 1
        }
      ],

      customer_email: data.email,

      success_url:
        "https://tourizia.com/?hotel_payment=success",

      cancel_url:
        "https://tourizia.com/?hotel_payment=cancel",

      metadata: {
        type: "hotel",

        paymentMethod: "stripe",

        fullName: data.fullName || "",
        email: data.email || "",

        city: data.city,
        countryCode: data.countryCode,

        checkIn: data.checkIn,
        checkOut: data.checkOut,

        adults: String(data.adults),
        children: String(data.children),
        rooms: String(data.rooms),

        guestNationality:
          data.guestNationality || "SN",

        // Offre sélectionnée côté serveur
        hotelId: selectedOffer.hotelId || "",
hotelName: selectedOffer.hotelName || "",
roomName: selectedOffer.roomName || "",

offerToken: offerToken,

providerPrice:
    String(selectedOffer.price || ""),

providerCurrency:
    selectedOffer.currency || "EUR"
      }
    });

    console.log("💳 Stripe Checkout créé :", session.id);

    return res.json({
      success: true,
      url: session.url
    });

  } catch (error) {

    console.error(
      "❌ Erreur création Stripe hôtel :",
      error.response?.data || error.message || error
    );

    return res.status(500).json({
      error: "Impossible de créer le paiement hôtel."
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

    console.log(
      `🏨 Création paiement PayTech hôtel — ${targetPayment}`
    );

    // --------------------------------------------------------
    // Le backend sélectionne l'offre.
    // Le frontend n'envoie PAS offerId.
    // --------------------------------------------------------

   const selectedOfferResult = await findPrebookableOffer(data);

if (!selectedOfferResult || !selectedOfferResult.offer) {
  return res.status(404).json({
    error: "Aucune chambre disponible ou réservable."
  });
}

const selectedOffer = selectedOfferResult.offer;

console.log(
  "✅ Offre PayTech sélectionnée :",
  selectedOffer.offerId
);


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

      fullName: data.fullName || "",
      email: data.email || "",

      city: data.city,
      countryCode: data.countryCode,

      checkIn: data.checkIn,
      checkOut: data.checkOut,

      adults: data.adults,
      children: data.children,
      rooms: data.rooms,

      guestNationality:
        data.guestNationality || "SN",

      // Offre LiteAPI
      offerId: selectedOffer.offerId,

      hotelId:
        selectedOffer.hotelId || "",

      hotelName:
        selectedOffer.hotelName || "",

      roomName:
        selectedOffer.roomName || "",

      providerPrice:
        selectedOffer.price || "",

      providerCurrency:
        selectedOffer.currency || "EUR"
    };


    // --------------------------------------------------------
    // Requête PayTech
    // --------------------------------------------------------

    const response = await fetch(
      "https://paytech.sn/api/payment/request-payment",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",

          "API_KEY":
            process.env.PAYTECH_API_KEY,

          "API_SECRET":
            process.env.PAYTECH_API_SECRET
        },

        body: JSON.stringify({

          item_name:
            "Réservation hôtel — Tourizia",

          item_price:
            HOTEL_PAYTECH_PRICE,

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
            "https://api.tourizia.com/paytech-hotel-ipn",

          success_url:
            "https://tourizia.com/?hotel_payment=success",

          cancel_url:
            "https://tourizia.com/?hotel_payment=cancel",

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

    let selectedOffer = null;
    let prebookResult = null;

    // ========================================================
    // ÉTAPE 1
    // ESSAYER L'OFFER ID STOCKÉ
    // ========================================================

    if (data.offerId) {

        try {

            console.log(
                "🔐 Tentative PREBOOK offre payée:",
                data.offerId
            );

            prebookResult =
                await prebookHotelOffer(
                    data.offerId
                );

            selectedOffer = {

                offerId:
                    data.offerId,

                hotelId:
                    data.hotelId,

                hotelName:
                    data.hotelName,

                roomName:
                    data.roomName,

                price:
                    data.providerPrice,

                currency:
                    data.providerCurrency

            };

        } catch (error) {

            console.warn(
                "⚠️ OFFER STOCKÉE EXPIRÉE OU INDISPONIBLE"
            );

            console.warn(
                error.message
            );

        }

    }

    // ========================================================
    // ÉTAPE 2
    // SI ÉCHEC → NOUVELLE RECHERCHE
    // ========================================================

    if (
        !selectedOffer ||
        !prebookResult
    ) {

        console.log(
            "🔄 Recherche d'une nouvelle offre..."
        );

        const fresh =
            await findPrebookableOffer(
                data
            );

        selectedOffer =
            fresh.offer;

        prebookResult =
            fresh.prebook;

    }

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

        throw new Error(
            "LiteAPI n'a pas retourné de prebookId"
        );

    }

    console.log(
        "✅ PREBOOK ID:",
        prebookId
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

return finalBooking;
}

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
        "Hôtel";

    const roomName =
        data.roomName ||
        "Chambre";

    const city =
        data.city ||
        "";

    const country =
        data.countryCode ||
        "";

    const checkIn =
        formatHotelDate(
            data.checkIn
        );

    const checkOut =
        formatHotelDate(
            data.checkOut
        );

    const adults =
        Number(
            data.adults || 0
        );

    const children =
        Number(
            data.children || 0
        );

    const rooms =
        Number(
            data.rooms || 1
        );

    const customer =
        data.fullName ||
        "Client Tourizia";

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

body {

    margin: 0;

    padding: 40px;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

    background: #f5f7f9;

    color: #17212b;

}

.page {

    max-width: 820px;

    margin: 0 auto;

    background: #ffffff;

    border-radius: 18px;

    overflow: hidden;

    box-shadow:
        0 10px 35px
        rgba(0,0,0,0.08);

}

.header {

    padding: 28px 35px;

    background:
        linear-gradient(
            135deg,
            #08b8b0,
            #087f91
        );

    color: #ffffff;

}

.logo {

    font-size: 28px;

    font-weight: 800;

    letter-spacing: 0.5px;

}

.header-subtitle {

    margin-top: 7px;

    font-size: 14px;

    opacity: 0.95;

}

.reference {

    margin-top: 20px;

    padding-top: 18px;

    border-top:
        1px solid
        rgba(255,255,255,0.30);

    display: flex;

    justify-content:
        space-between;

    gap: 20px;

}

.reference-label {

    font-size: 11px;

    text-transform: uppercase;

    opacity: 0.80;

}

.reference-value {

    margin-top: 5px;

    font-size: 18px;

    font-weight: 700;

}

.content {

    padding: 35px;

}

.status {

    display: inline-block;

    padding: 8px 15px;

    border-radius: 30px;

    background: #e8f8f3;

    color: #16805d;

    font-weight: 700;

    font-size: 13px;

    margin-bottom: 25px;

}

.hotel-name {

    font-size: 25px;

    font-weight: 800;

    margin-bottom: 7px;

}

.location {

    color: #687580;

    font-size: 14px;

    margin-bottom: 30px;

}

.grid {

    display: grid;

    grid-template-columns:
        1fr 1fr;

    gap: 14px;

}

.card {

    border:
        1px solid #e5e9ed;

    border-radius: 12px;

    padding: 18px;

}

.label {

    font-size: 11px;

    text-transform: uppercase;

    color: #7a858e;

    margin-bottom: 7px;

}

.value {

    font-size: 15px;

    font-weight: 700;

}

.section {

    margin-top: 28px;

}

.section-title {

    font-size: 16px;

    font-weight: 800;

    margin-bottom: 12px;

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

    padding: 13px 16px;

    border-bottom:
        1px solid #edf0f2;

    font-size: 14px;

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

    margin-top: 28px;

    padding: 18px;

    background: #f3f8fa;

    border-radius: 12px;

    color: #53616c;

    font-size: 12px;

    line-height: 1.6;

}

.footer {

    padding: 22px 35px;

    background: #f7f9fa;

    color: #7b858d;

    font-size: 11px;

    line-height: 1.6;

}

.footer strong {

    color: #17212b;

}
/* ============================================================
   TOURIZIA — PDF A4 — UNE SEULE PAGE
   ============================================================ */

@page {
    size: A4;
    margin: 0;
}

html,
body {
    width: 210mm;
    height: 297mm;
    margin: 0;
    padding: 0;
}

body {
    background: #ffffff;
    font-family: Arial, Helvetica, sans-serif;
}

/* PAGE A4 FIXE */
.page {
    width: 210mm;
    height: 297mm;
    max-width: none;
    min-height: 0;
    margin: 0;
    padding: 0;
    border-radius: 0;
    box-shadow: none;
    overflow: hidden;
}

/* HEADER */
.header {
    padding: 18px 30px;
}

.logo {
    font-size: 27px;
}

.header-subtitle {
    margin-top: 5px;
    font-size: 13px;
}

.reference {
    margin-top: 11px;
    padding-top: 11px;
}

.reference-label {
    font-size: 10px;
}

.reference-value {
    margin-top: 3px;
    font-size: 17px;
}

/* CONTENU */
.content {
    padding: 20px 30px;
}

.status {
    padding: 5px 12px;
    font-size: 11px;
    margin-bottom: 14px;
}

.hotel-name {
    font-size: 22px;
    margin-bottom: 3px;
}

.location {
    font-size: 12px;
    margin-bottom: 15px;
}

/* CARTES */
.grid {
    gap: 8px;
}

.card {
    padding: 11px 13px;
}

.label {
    font-size: 10px;
    margin-bottom: 4px;
}

.value {
    font-size: 14px;
}

/* SECTION */
.section {
    margin-top: 14px;
}

.section-title {
    font-size: 15px;
    margin-bottom: 7px;
}

/* DETAILS */
.row {
    padding: 7px 13px;
    font-size: 12px;
}

/* NOTICE */
.notice {
    margin-top: 13px;
    padding: 10px 13px;
    font-size: 10px;
    line-height: 1.35;
}

/* FOOTER */
.footer {
    padding: 11px 30px;
    font-size: 9px;
    line-height: 1.3;
}

/* Évite les coupures */
.header,
.content,
.grid,
.card,
.section,
.details,
.notice,
.footer {
    break-inside: avoid;
    page-break-inside: avoid;
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
            ${escapeHtml(hotelName)}
        </div>

        <div class="location">
            ${escapeHtml(city)}
            ${country
                ? " — " + escapeHtml(country)
                : ""}
        </div>


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
                    Voyageur principal
                </div>

                <div class="value">
                    ${escapeHtml(customer)}
                </div>

            </div>


            <div class="card">

                <div class="label">
                    Chambre
                </div>

                <div class="value">
                    ${escapeHtml(roomName)}
                </div>

            </div>

        </div>


        <div class="section">

            <div class="section-title">
                Détails du séjour
            </div>

            <div class="details">

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
                        Référence fournisseur
                    </div>

                    <div class="row-value">
                        ${escapeHtml(
                            data.bookingId || reference
                        )}
                    </div>

                </div>

            </div>

        </div>


        <div class="notice">

            <div class="notice">
    <strong>Important</strong>

    <div style="margin-top:6px;">
        Ce document confirme la réservation
        traitée par Tourizia auprès de son
        fournisseur hôtelier.
    </div>

    <div style="margin-top:5px;">
        Veuillez conserver ce document et
        présenter votre référence de réservation
        lors de votre séjour.
    </div>
</div>

        </div>

    </div>


    <div class="footer">

        <strong>
            TOURIZIA
        </strong>

        — Votre réservation hôtel est confirmée.

        <br>

        Pour toute question concernant votre
        réservation, contactez le support Tourizia.

    </div>

</div>

</body>

</html>

`;

}


// ============================================================
// GÉNÉRATION PDF AVEC PUPPETEER
// ============================================================

async function generateHotelPDF(
    html
) {

    /*
     * Cette fonction utilise Chromium/Puppeteer.
     *
     * Selon ton environnement Render,
     * le chemin Chrome peut être fourni
     * par CHROME_EXECUTABLE_PATH.
     */

    const executablePath =
        process.env.CHROME_EXECUTABLE_PATH ||
        process.env.PUPPETEER_EXECUTABLE_PATH;

    if (!executablePath) {

        throw new Error(
            "CHROME_EXECUTABLE_PATH manquant"
        );

    }

    const browser =
        await puppeteer.launch({

            executablePath,

            headless:
                true,

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
                waitUntil:
                    "networkidle0"
            }
        );

       const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    scale: 0.90,
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
async function sendHotelEmail(data, pdfBuffer, reference) {
const attachmentBase64 = Buffer.isBuffer(pdfBuffer)
    ? pdfBuffer.toString("base64")
    : Buffer.from(pdfBuffer).toString("base64");

console.log("📎 PDF TYPE:", typeof pdfBuffer);
console.log("📎 IS BUFFER:", Buffer.isBuffer(pdfBuffer));
console.log("📎 BASE64 TYPE:", typeof attachmentBase64);
console.log("📎 BASE64 LENGTH:", attachmentBase64.length);

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

    attachments: [
        {
            filename: `reservation-hotel-${reference}.pdf`,
            content: attachmentBase64
        }
    ]
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
// TRAITEMENT DOCUMENT APRÈS BOOK
// ============================================================

async function generateAndSendHotelConfirmation(
    booking
) {

    console.log(
        "📄 GÉNÉRATION DOCUMENT HÔTEL..."
    );

    // --------------------------------------------------------
    // RÉFÉRENCE
    // --------------------------------------------------------

    const reference =
        booking.confirmationNumber ||
        booking.bookingId ||
        generateHotelReference();

    booking.confirmationNumber =
        reference;

    // --------------------------------------------------------
    // CONSTRUIRE HTML
    // --------------------------------------------------------

    const html =
        buildHotelPDFHTML(
            booking
        );

    // --------------------------------------------------------
    // GÉNÉRER PDF
    // --------------------------------------------------------

    const pdf =
        await generateHotelPDF(
            html
        );

    console.log(
        "📄 HOTEL PDF GENERATED:",
        !!pdf
    );

    console.log(
        "📄 HOTEL PDF SIZE:",
        pdf
            ? pdf.length
            : 0
    );

    // --------------------------------------------------------
    // CLOUDINARY
    // --------------------------------------------------------

    let pdfUrl = null;

    try {

        pdfUrl =
            await uploadHotelPDF(
                pdf,
                reference
            );

    } catch (error) {

        /*
         * Le PDF reste disponible en mémoire
         * pour l'envoi email même si Cloudinary
         * rencontre momentanément un problème.
         */

        console.error(
            "⚠️ CLOUDINARY HOTEL ERROR:",
            error
        );

    }

    // --------------------------------------------------------
    // EMAIL
    // --------------------------------------------------------

    console.log("📧 EMAIL DEBUG:", {
    email: booking.email,
    fullName: booking.fullName,
    hotelName: booking.hotelName,
    confirmationNumber: booking.confirmationNumber
});
    await sendHotelEmail(
        booking,
        pdf,
        reference
    );

    console.log(
        "======================================"
    );

    console.log(
        "🎉 DOCUMENT HÔTEL ENVOYÉ"
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
        "PDF URL:",
        pdfUrl
    );

    console.log(
        "======================================"
    );

    return {

        reference,

        pdfUrl

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

// ============================================================
// SERVER
// ============================================================


