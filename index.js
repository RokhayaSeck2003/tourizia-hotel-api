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
let hotelOfferCatalogues = null;

function formatHotelError(error) {
  if (typeof error === "string") return error;

  if (error instanceof Error) return error.message;

  if (error && typeof error === "object") {
    return (
      error.description ||
      error.message ||
      error.error?.description ||
      error.error?.message ||
      JSON.stringify(error)
    );
  }

  return String(error ?? "Erreur inconnue");
}

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

hotelOfferCatalogues = mongoDb.collection(
    "hotel_offer_catalogues"
);

// Un catalogue est identifié par un token unique.
await hotelOfferCatalogues.createIndex(
    { token: 1 },
    { unique: true }
);

// Un catalogue expiré est automatiquement supprimé.
await hotelOfferCatalogues.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 }
);

await hotelOfferCatalogues.createIndex({
    transactionId: 1
});

console.log("✅ Collection catalogue hôtel prête");


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

        OFFER_SELECTED: "OFFER_SELECTED",

        PREBOOKING: "PREBOOKING",

    PREBOOKED:
        "PREBOOKED",

       BOOKING: 
       "BOOKING",

BOOKING_UNKNOWN:

    "BOOKING_UNKNOWN",

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
    status: "PENDING",
    method: data.paymentMethod || null,
    paymentId: null,
    stripeSessionId: null,
    paytechReference: null,
    amount: null,
    currency: null,
    paidAt: null
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
documents: {
    hotelConfirmationPdfs: [],
    confirmationNumber: null,
    generatedAt: null,
    emailSent: false,
    storageStatus: "PENDING",
    storageErrors: [],
    emailError: null
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

async function updateHotelTransaction(transactionId, fields = {}) {
    if (!hotelTransactions) {
        throw new Error("MongoDB indisponible : documents non enregistrés");
    }

    if (!transactionId) {
        throw new Error("transactionId manquant : documents non enregistrés");
    }

    const result = await hotelTransactions.updateOne(
        { transactionId: String(transactionId) },
        {
            $set: {
                ...fields,
                updatedAt: new Date()
            }
        }
    );

    console.log("📄 HOTEL DOCUMENTS UPDATE:", {
        transactionId,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        pdfCount: fields["documents.hotelConfirmationPdfs"]?.length || 0
    });

    if (result.matchedCount === 0) {
        throw new Error(
            `Aucune transaction MongoDB trouvée pour ${transactionId}`
        );
    }

    return result;
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

const HOTEL_PAYTECH_PRICE = 100; // XOF 100 — valeur de test

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
        // ==================================================
// 🔐 3C.9 — PROTECTION GLOBALE DU WEBHOOK STRIPE
// ==================================================

try {

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

        // ==================================================
// 🔐 3C.8 — VÉRIFICATION DE L'IDENTIFIANT EVENT STRIPE
// ==================================================

if (!stripeWebhookEvents) {
    console.error("❌ STRIPE : collection webhook indisponible");
    return res.status(500).send("Webhook event storage unavailable");
}

const alreadyReceivedEvent = await stripeWebhookEvents.findOne({
    eventId: event.id
});

if (alreadyReceivedEvent?.status === "PROCESSED") {
    console.log("♻️ STRIPE : EVENT DÉJÀ TRAITÉ:", event.id);

    return res.status(200).json({
        received: true,
        alreadyProcessed: true
    });
}

        const session =
            event.data.object;
            const metadata =
    session.metadata || {};

const transactionId =
    metadata.transactionId || null;


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
// 🔎 VÉRIFIER LA TRANSACTION DANS MONGODB
// ----------------------------------------------------

if (!transactionId) {
    console.error(
        "❌ STRIPE : transactionId manquant dans les metadata"
    );

    return res.status(400).send(
        "transactionId missing"
    );
}

if (!hotelTransactions) {
    console.error(
        "❌ STRIPE : MongoDB indisponible"
    );

    return res.status(500).send(
        "Database unavailable"
    );
}

const existingTransaction =
    await hotelTransactions.findOne({
        transactionId,
        type: "hotel"
    });

if (!existingTransaction) {
    console.error(
        "❌ STRIPE : transaction hôtel introuvable:",
        transactionId
    );

    return res.status(400).send(
        "Hotel transaction not found"
    );
}

console.log(
    "✅ TRANSACTION HÔTEL VÉRIFIÉE:",
    transactionId
);

// ==================================================
// 🔐 3C.7 — VÉRIFICATION DU MONTANT STRIPE
// ==================================================

const expectedPersons =
    Number(existingTransaction.request?.adults || 0) +
    Number(existingTransaction.request?.children || 0);

const expectedAmountCents =
    HOTEL_STRIPE_PRICE * expectedPersons;

const receivedAmountCents =
    Number(session.amount_total);

const receivedCurrency =
    String(session.currency || "").toLowerCase();

if (
    expectedPersons < 1 ||
    !Number.isInteger(receivedAmountCents) ||
    receivedAmountCents !== expectedAmountCents ||
    receivedCurrency !== "usd"
) {
    console.error("❌ STRIPE : MONTANT OU DEVISE INVALIDE", {
        transactionId,
        expectedPersons,
        expectedAmountCents,
        receivedAmountCents,
        receivedCurrency
    });

    return res.status(400).send(
        "Invalid payment amount or currency"
    );
}

console.log("✅ STRIPE : MONTANT ET DEVISE VÉRIFIÉS", {
    transactionId,
    expectedAmountCents,
    receivedAmountCents,
    currency: receivedCurrency
});

        // ----------------------------------------------------
// 💰 TRANSACTION → PAID
// ----------------------------------------------------

        // ==================================================
// 🔐 3C.6 — ANTI-DOUBLE TRAITEMENT STRIPE
// ==================================================

const stripePaymentUpdate = await hotelTransactions.updateOne(
    {
        transactionId,
        type: "hotel",
        status: HOTEL_TRANSACTION_STATUS.PAYMENT_PENDING
    },
    {
        $set: {
            status: HOTEL_TRANSACTION_STATUS.PAID,
            updatedAt: new Date(),

            "payment.paymentId":
                session.payment_intent || session.id,

            "payment.stripeSessionId":
                session.id,

            "payment.amount":
                session.amount_total !== null &&
                session.amount_total !== undefined
                    ? session.amount_total / 100
                    : null,

                    "payment.status": "PAID",
"payment.method": "stripe",
"payment.paidAt": new Date(),

            "payment.currency":
                session.currency || "usd"
        },

        $push: {
            history: {
                status: HOTEL_TRANSACTION_STATUS.PAID,
                at: new Date()
            }
        }
    }
);

// Une seule notification peut faire passer PENDING → PAID.
if (stripePaymentUpdate.modifiedCount !== 1) {

    const latestTransaction =
        await hotelTransactions.findOne({
            transactionId,
            type: "hotel"
        });

    if (
        latestTransaction?.payment?.status === "PAID"
    ) {
        // L'événement Stripe est bien pris en compte,
        // même si une autre notification a déjà payé la transaction.
        await stripeWebhookEvents.updateOne(
            { eventId: event.id },
            {
                $set: {
                    eventId: event.id,
                    eventType: event.type,
                    transactionId,
                    stripeSessionId: session.id,
                    status: "PROCESSED",
                    processedAt: new Date()
                }
            },
            { upsert: true }
        );

        console.log(
            "♻️ STRIPE : TRANSACTION DÉJÀ PAYÉE:",
            transactionId
        );

        return res.status(200).json({
            received: true,
            alreadyProcessed: true
        });
    }

    console.error(
        "❌ STRIPE : TRANSITION DE PAIEMENT REFUSÉE",
        {
            transactionId,
            currentStatus: latestTransaction?.status
        }
    );

    return res.status(409).send(
        "Payment transition rejected"
    );
}

// ==================================================
// 🔐 3C.8 — ENREGISTREMENT EVENT STRIPE TRAITÉ
// ==================================================

await stripeWebhookEvents.updateOne(
    { eventId: event.id },
    {
        $set: {
            eventId: event.id,
            eventType: event.type,
            transactionId,
            stripeSessionId: session.id,
            status: "PROCESSED",
            processedAt: new Date()
        }
    },
    { upsert: true }
);

console.log("✅ STRIPE EVENT ENREGISTRÉ:", event.id);

console.log(
    "✅ STRIPE : PAIEMENT ENREGISTRÉ UNE SEULE FOIS:",
    transactionId
);
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

        phone:
    pendingPayment?.data?.phone ||
    metadata.phone ||
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

        // ----------------------------------------------------
// ✅ PAIEMENT CONFIRMÉ — EN ATTENTE DU CHOIX CLIENT
// Aucune recherche, aucun PREBOOK, aucun BOOK ici.
// ----------------------------------------------------

console.log(
    "✅ FRAIS TOURIZIA PAYÉS — CLIENT AUTORISÉ À RECHERCHER LES OFFRES:",
    transactionId
);

} catch (error) {

    console.error(
        "❌ STRIPE WEBHOOK PROCESSING ERROR:",
        error
    );

    if (res.headersSent) {
        console.error(
            "⚠️ Réponse déjà envoyée à Stripe"
        );
        return;
    }

    return res.status(500).json({
        received: false,
        error: "Webhook processing failed"
    });
}

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
// 🔐 TOURIZIA — AUTHENTIFICATION ADMINISTRATEUR
// À placer après app.use(express.json())
// ============================================================

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;

const adminLoginAttempts = new Map();

function createAdminToken() {
    const payload = {
        role: "admin",
        exp: Math.floor(Date.now() / 1000) + (8 * 60 * 60)
    };

    const encoded = Buffer
        .from(JSON.stringify(payload))
        .toString("base64url");

    const signature = crypto
        .createHmac("sha256", ADMIN_TOKEN_SECRET)
        .update(encoded)
        .digest("base64url");

    return `${encoded}.${signature}`;
}

function verifyAdminToken(token) {
    try {
        if (!ADMIN_TOKEN_SECRET || !token) return false;

        const parts = token.split(".");
        if (parts.length !== 2) return false;

        const [encoded, receivedSignature] = parts;

        const expectedSignature = crypto
            .createHmac("sha256", ADMIN_TOKEN_SECRET)
            .update(encoded)
            .digest();

        const receivedBuffer = Buffer.from(
            receivedSignature,
            "base64url"
        );

        if (
            receivedBuffer.length !== expectedSignature.length ||
            !crypto.timingSafeEqual(receivedBuffer, expectedSignature)
        ) {
            return false;
        }

        const payload = JSON.parse(
            Buffer.from(encoded, "base64url").toString("utf8")
        );

        return (
            payload.role === "admin" &&
            Number(payload.exp) > Math.floor(Date.now() / 1000)
        );

    } catch {
        return false;
    }
}

function requireAdmin(req, res, next) {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

    if (!verifyAdminToken(token)) {
        return res.status(401).json({
            success: false,
            error: "Accès administrateur refusé"
        });
    }

    next();
}

// Connexion administrateur
app.post("/api/admin/login", async (req, res) => {
    try {
        if (
            !ADMIN_EMAIL ||
            !ADMIN_PASSWORD_HASH ||
            !ADMIN_TOKEN_SECRET
        ) {
            return res.status(503).json({
                success: false,
                error: "Authentification administrateur non configurée"
            });
        }

        const ip = req.ip || "unknown";
        const now = Date.now();
        const attempts = adminLoginAttempts.get(ip);

        if (attempts && attempts.blockedUntil > now) {
            return res.status(429).json({
                success: false,
                error: "Trop de tentatives. Réessaie dans quelques minutes."
            });
        }

        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        const [salt, storedHash] = ADMIN_PASSWORD_HASH.split(":");

        if (!salt || !storedHash || !/^[a-f0-9]+$/i.test(storedHash)) {
            return res.status(503).json({
                success: false,
                error: "Configuration du mot de passe invalide"
            });
        }

        const calculatedHash = crypto.scryptSync(
            password,
            salt,
            64
        );

        const storedBuffer = Buffer.from(storedHash, "hex");

        const passwordValid =
            storedBuffer.length === calculatedHash.length &&
            crypto.timingSafeEqual(calculatedHash, storedBuffer);

        const emailValid =
            email === ADMIN_EMAIL.trim().toLowerCase();

        if (!emailValid || !passwordValid) {
            const count = (attempts?.count || 0) + 1;

            adminLoginAttempts.set(ip, {
                count,
                blockedUntil: count >= 5
                    ? now + 15 * 60 * 1000
                    : 0
            });

            return res.status(401).json({
                success: false,
                error: "Identifiants incorrects"
            });
        }

        adminLoginAttempts.delete(ip);

        return res.json({
            success: true,
            token: createAdminToken(),
            expiresIn: 8 * 60 * 60
        });

    } catch (error) {
        console.error("ADMIN LOGIN ERROR:", error);

        return res.status(500).json({
            success: false,
            error: "Erreur de connexion"
        });
    }
});

// Vérifier une session administrateur
app.get("/api/admin/verify", requireAdmin, (req, res) => {
    res.json({
        success: true,
        authenticated: true
    });
});

// ============================================================
// 🔐 ADMIN — LISTE PRIVÉE DES RÉSERVATIONS HÔTELS
// ============================================================

app.get("/api/admin/hotel-bookings", requireAdmin, async (req, res) => {
    try {
        if (!hotelTransactions) {
            return res.status(503).json({
                success: false,
                error: "MongoDB indisponible"
            });
        }

        const bookings = await hotelTransactions
            .find({})
            .sort({ createdAt: -1 })
            .limit(200)
            .toArray();

        res.set("Cache-Control", "no-store");

        return res.json({
            success: true,
            count: bookings.length,
            bookings
        });

    } catch (error) {
        console.error("ADMIN HOTEL BOOKINGS ERROR:", error);

        return res.status(500).json({
            success: false,
            error: "Impossible de récupérer les réservations hôtels"
        });
    }
});

// ============================================================
// 🔐 ADMIN — TÉLÉCHARGEMENT SÉCURISÉ PDF HÔTEL
// ============================================================

app.get(
    "/api/admin/hotel-bookings/:transactionId/documents/:guestNumber",
    requireAdmin,
    async (req, res) => {

        try {

            if (!hotelTransactions) {
                return res.status(503).json({
                    success: false,
                    error: "MongoDB indisponible"
                });
            }

            const { transactionId } = req.params;

            const guestNumber = Number(
                req.params.guestNumber
            );

            if (
                !transactionId ||
                !Number.isInteger(guestNumber) ||
                guestNumber < 1
            ) {
                return res.status(400).json({
                    success: false,
                    error: "Paramètres de téléchargement invalides"
                });
            }

            // Récupérer uniquement une transaction hôtel.
            const transaction = await hotelTransactions.findOne({
                transactionId,
                type: "hotel"
            });

            if (!transaction) {
                return res.status(404).json({
                    success: false,
                    error: "Réservation hôtel introuvable"
                });
            }

            const documents =
                transaction.documents?.hotelConfirmationPdfs || [];

            const document = documents.find(
                item => Number(item.guestNumber) === guestNumber
            );

            if (!document || !document.publicId) {
                return res.status(404).json({
                    success: false,
                    error: "PDF introuvable pour ce voyageur"
                });
            }

            if (
                !process.env.CLOUDINARY_CLOUD_NAME ||
                !process.env.CLOUDINARY_API_KEY ||
                !process.env.CLOUDINARY_API_SECRET
            ) {
                return res.status(503).json({
                    success: false,
                    error: "Configuration Cloudinary indisponible"
                });
            }

            // Générer un lien signé valable 60 secondes.
            const expiresAt =
                Math.floor(Date.now() / 1000) + 60;

            const downloadUrl =
                cloudinary.utils.private_download_url(
                    document.publicId,
                    document.format || "pdf",
                    {
                        resource_type: "raw",
                        type: "authenticated",
                        expires_at: expiresAt,
                        attachment: true
                    }
                );

            res.set("Cache-Control", "private, no-store");

            return res.json({
                success: true,
                downloadUrl,
                filename:
                    document.filename ||
                    `reservation-hotel-${transactionId}-personne-${guestNumber}.pdf`,
                expiresIn: 60
            });

        } catch (error) {

            console.error(
                "❌ ADMIN HOTEL PDF DOWNLOAD ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                error: "Impossible de générer le lien du PDF"
            });
        }
    }
);

// ============================================================
// 💰 ADMIN — BILAN FINANCIER HÔTELS
// ============================================================

app.get("/api/admin/hotel-financials", requireAdmin, async (req, res) => {
    try {
        if (!hotelTransactions) {
            return res.status(503).json({
                success: false,
                error: "MongoDB indisponible"
            });
        }

        const transactions = await hotelTransactions.find({
            type: "hotel",
            status: "PAID",
            "payment.status": "PAID",
            "payment.amount": { $gt: 0 }
        }).toArray();

        const currencies = {};
        const methods = {
            stripe: {},
            wave: {},
            orangeMoney: {},
            other: {}
        };

        const normalizeMethod = (method) => {
            const value = String(method || "").trim().toLowerCase();

            if (value === "stripe") return "stripe";
            if (value === "wave") return "wave";
            if (value.includes("orange")) return "orangeMoney";

            return "other";
        };

        for (const transaction of transactions) {
            const amount = Number(transaction.payment?.amount || 0);
            const currency = String(
                transaction.payment?.currency || "UNKNOWN"
            ).toUpperCase();

            const method = normalizeMethod(
                transaction.payment?.method
            );

            if (!Number.isFinite(amount) || amount <= 0) continue;

            currencies[currency] =
                (currencies[currency] || 0) + amount;

            methods[method][currency] =
                (methods[method][currency] || 0) + amount;
        }

        const result = {
            paidReservations: transactions.length,
            currencies,
            methods
        };

        console.log("💰 HOTEL FINANCIALS:", result);

        res.set("Cache-Control", "no-store");

        return res.json({
            success: true,
            ...result
        });

    } catch (error) {
        console.error("❌ HOTEL FINANCIALS ERROR:", error);

        return res.status(500).json({
            success: false,
            error: "Impossible de récupérer le bilan financier hôtel"
        });
    }
});


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
// 🌍 TOURIZIA — VILLES OFFICIELLES LITEAPI
// ============================================================

const liteApiCitiesCache = new Map();

async function getLiteApiCities(countryCode) {

    const code = String(countryCode || "")
        .trim()
        .toUpperCase();

    if (!/^[A-Z]{2}$/.test(code)) {
        throw new Error("Code pays ISO invalide");
    }

    // Cache de 24 heures pour éviter les appels répétés.
    const cached = liteApiCitiesCache.get(code);

    if (cached && cached.expiresAt > Date.now()) {
        return cached.cities;
    }

    const url = new URL(
        `${LITEAPI_BASE_URL}/data/cities`
    );

    url.searchParams.set("countryCode", code);

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: liteApiHeaders
    });

    const result = await response.json();

    if (!response.ok) {
        console.error(
            "❌ LITEAPI CITIES ERROR:",
            response.status,
            result
        );

        throw new Error(
            "Impossible de récupérer les villes LiteAPI"
        );
    }

    const cities = [
        ...new Set(
            (Array.isArray(result.data) ? result.data : [])
                .map(item => String(item.city || "").trim())
                .filter(Boolean)
        )
    ].sort((a, b) => a.localeCompare(b));

    console.log("🔬 LITEAPI CITY DIAGNOSTIC:", {
    countryCode: code,
    total: cities.length,
    hasBruxelles: cities.some(
        city => normalizeDestinationText(city) === "bruxelles"
    ),
    bruxellesMatches: cities.filter(
        city => normalizeDestinationText(city).includes("brux")
    )
});

    liteApiCitiesCache.set(code, {
        cities,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });

    console.log(
        `🌍 VILLES LITEAPI ${code}:`,
        cities.length
    );

    return cities;
}
// ============================================================
// 🔎 CORRESPONDANCE GEO NAMES → VILLE OFFICIELLE LITEAPI
// ============================================================


async function resolveLiteApiCity(cityName, countryCode) {
    const requestedCity = normalizeDestinationText(cityName);

    const code = String(countryCode || "")
        .trim()
        .toUpperCase();

    if (!requestedCity || !/^[A-Z]{2}$/.test(code)) {
        throw new Error("Ville ou code pays invalide.");
    }

    // 1. Essayer d'abord le catalogue classique LiteAPI.
    let liteApiCities = await getLiteApiCities(code);

    let officialCity = liteApiCities.find(city =>
        normalizeDestinationText(city) === requestedCity
    );

    if (officialCity) {
        console.log("✅ VILLE OFFICIELLE LITEAPI :", officialCity);

        return {
            cityName: officialCity,
            placeId: null,
            displayName: officialCity,
            formattedAddress: null
        };
    }

    // 2. Si la ville n'existe pas dans /data/cities,
    //    utiliser le moteur officiel LiteAPI Places.
    const countryName = new Intl.DisplayNames(
        ["fr"],
        { type: "region" }
    ).of(code);

    const searchText = `${cityName}, ${countryName || code}`;

    const placesUrl = new URL(
        `${LITEAPI_BASE_URL}/data/places`
    );

    placesUrl.searchParams.set("textQuery", searchText);
    placesUrl.searchParams.set("type", "locality");
    placesUrl.searchParams.set("language", "fr");

    console.log("🔎 LITEAPI PLACES REQUEST :", {
        cityName,
        countryCode: code,
        countryName,
        searchText
    });

    const placesResponse = await fetch(
        placesUrl.toString(),
        {
            method: "GET",
            headers: liteApiHeaders
        }
    );

    const placesResult = await placesResponse.json();

    if (!placesResponse.ok) {
        console.error(
            "❌ LITEAPI PLACES ERROR :",
            placesResponse.status,
            placesResult
        );

        throw new Error(
            `Impossible de retrouver la ville "${cityName}" avec LiteAPI Places.`
        );
    }

    const places = Array.isArray(placesResult.data)
        ? placesResult.data
        : [];

    console.log(
        "🔎 LITEAPI PLACES RESULTS :",
        places.map(place => ({
            placeId: place.placeId,
            displayName: place.displayName,
            formattedAddress: place.formattedAddress,
            types: place.types
        }))
    );

    // Ne retenir qu'une ville (locality) située dans le pays demandé.
    const matchingPlace = places.find(place => {
        const types = Array.isArray(place.types)
            ? place.types
            : [];

        const address = normalizeDestinationText(
            place.formattedAddress || ""
        );

        const localizedCountry = normalizeDestinationText(
            countryName || ""
        );

        const hasLocalityType = types.includes("locality");

        const hasCountryMatch =
            localizedCountry &&
            address.includes(localizedCountry);

        return (
            place.placeId &&
            hasLocalityType &&
            hasCountryMatch
        );
    });

    if (!matchingPlace) {
        console.error(
            "❌ AUCUNE VILLE LITEAPI PLACES CORRESPONDANTE :",
            {
                cityName,
                countryCode: code,
                countryName,
                places
            }
        );

        throw new Error(
            `LiteAPI Places n'a pas retourné de ville vérifiable pour "${cityName}" (${code}).`
        );
    }

    console.log("✅ LITEAPI PLACE ID RESOLVED :", {
        cityName,
        displayName: matchingPlace.displayName,
        formattedAddress: matchingPlace.formattedAddress,
        placeId: matchingPlace.placeId
    });

    return {
        cityName: null,
        placeId: matchingPlace.placeId,
        displayName: matchingPlace.displayName,
        formattedAddress: matchingPlace.formattedAddress
    };
}


// ============================================================
// 🔎 ENDPOINT TOURIZIA — LISTE DES VILLES LITEAPI
// ============================================================

app.get("/api/liteapi-cities", async (req, res) => {

    try {

        const countryCode = String(
            req.query.countryCode || ""
        ).trim().toUpperCase();

        if (!/^[A-Z]{2}$/.test(countryCode)) {
            return res.status(400).json({
                success: false,
                error: "countryCode ISO-2 obligatoire"
            });
        }

        const cities = await getLiteApiCities(countryCode);

        return res.json({
            success: true,
            provider: "LiteAPI",
            countryCode,
            total: cities.length,
            cities
        });

    } catch (error) {

        console.error(
            "❌ TOURIZIA CITIES ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


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


// ============================================================
// 🏨 DÉTAILS HÔTELS LITEAPI — CACHE + REQUÊTES PARTAGÉES
// ============================================================

const LITEAPI_HOTEL_DETAILS_CACHE_TTL_MS =
    6 * 60 * 60 * 1000; // 6 heures

const liteApiHotelDetailsCache = new Map();
const liteApiHotelDetailsInFlight = new Map();

async function getLiteApiHotelDetails(hotelId) {

    if (!hotelId) {
        throw new Error("hotelId LiteAPI manquant");
    }

    const key = String(hotelId);
    const now = Date.now();

    // 1. Réutiliser les détails déjà en cache.
    const cached = liteApiHotelDetailsCache.get(key);

    if (cached && cached.expiresAt > now) {
        return cached.data;
    }

    // 2. Éviter plusieurs appels simultanés pour le même hôtel.
    if (liteApiHotelDetailsInFlight.has(key)) {
        return liteApiHotelDetailsInFlight.get(key);
    }

    // 3. Appel LiteAPI si aucune donnée disponible.
    const request = (async () => {

        const url =
            `${LITEAPI_BASE_URL}/data/hotel` +
            `?hotelId=${encodeURIComponent(key)}` +
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

        const data = result.data || result;

        // 4. Enregistrer les détails pendant 6 heures.
        liteApiHotelDetailsCache.set(key, {
            data,
            expiresAt: Date.now() +
                LITEAPI_HOTEL_DETAILS_CACHE_TTL_MS
        });

        // Limiter la taille du cache.
        if (liteApiHotelDetailsCache.size > 1000) {

            for (const [cacheKey, entry] of liteApiHotelDetailsCache) {

                if (entry.expiresAt <= Date.now()) {
                    liteApiHotelDetailsCache.delete(cacheKey);
                }

                if (liteApiHotelDetailsCache.size <= 800) {
                    break;
                }
            }
        }

        return data;

    })();

    liteApiHotelDetailsInFlight.set(key, request);

    try {
        return await request;
    } finally {
        liteApiHotelDetailsInFlight.delete(key);
    }
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
// TOURIZIA — CATALOGUE D'OFFRES HÔTELIÈRES
// NORMALISATION DES CONDITIONS ET CLASSEMENT
// ============================================================


// ============================================================
// 🛡️ DÉTAILS DES CONDITIONS D'ANNULATION LITEAPI
// ============================================================

function getOfferCancellationDetails(offer) {

    const policies = offer.cancellationPolicies || {};

    const tag = String(
        policies.refundableTag ||
        policies.refundable ||
        offer.refundableTag ||
        offer.refundable ||
        ""
    ).trim().toUpperCase();

    const infos = Array.isArray(policies.cancelPolicyInfos)
        ? policies.cancelPolicyInfos
        : [];

    const penalties = infos.map(policy => {

        const cancelTime = policy.cancelTime || null;

        const amount = policy.amount ?? null;

        const parsedDate = cancelTime
            ? new Date(
                /Z$|[+-]\d{2}:\d{2}$/.test(String(cancelTime))
                    ? cancelTime
                    : `${String(cancelTime).replace(" ", "T")}Z`
            )
            : null;

        return {
            cancelTime,
            amount,
            currency: policy.currency || offer.currency || null,
            timezone: policy.timezone || null,
            parsedDate:
                parsedDate && !Number.isNaN(parsedDate.getTime())
                    ? parsedDate
                    : null
        };
    });

    const nonRefundable = [
        "NRF",
        "NRFN",
        "NONREFUNDABLE",
        "NON_REFUNDABLE"
    ].includes(tag);

    const refundable = tag === "RFN";

    const now = new Date();

    // Seules les pénalités valides et datées sont exploitables.
    const validPenalties = penalties.filter(policy =>
        policy.parsedDate &&
        policy.amount !== null &&
        Number.isFinite(Number(policy.amount)) &&
        Number(policy.amount) >= 0
    );

    // La gratuité est encore applicable uniquement si
    // une règle à zéro est datée dans le futur.
    const freeCancellationDeadlines = validPenalties
        .filter(policy =>
            Number(policy.amount) === 0 &&
            policy.parsedDate > now
        )
        .sort((a, b) =>
            b.parsedDate - a.parsedDate
        );

    const hasFreeCancellation =
        refundable &&
        freeCancellationDeadlines.length > 0;

    const freeCancellationUntil =
        hasFreeCancellation
            ? freeCancellationDeadlines[0].cancelTime
            : null;

    return {
        tag: tag || "UNKNOWN",
        refundable,
        nonRefundable,
        hasFreeCancellation,
        freeCancellationUntil,
        penalties: penalties.map(({ parsedDate, ...policy }) => policy),
        policyDetailsAvailable: validPenalties.length > 0,
        raw: policies
    };
}


// ============================================================
// 🏆 CLASSEMENT DES OFFRES HÔTELIÈRES
// ============================================================

function rankHotelOffers(offers) {

    const ranked = [...offers].map(offer => {

        const cancellation =
            getOfferCancellationDetails(offer);

        const parsedPrice = Number(offer.price);

        const price =
            offer.price !== null &&
            offer.price !== undefined &&
            offer.price !== "" &&
            Number.isFinite(parsedPrice)
                ? parsedPrice
                : null;

        let cancellationRank = 3;

        if (cancellation.hasFreeCancellation) {
            cancellationRank = 0;
        } else if (cancellation.refundable) {
            cancellationRank = 1;
        } else if (cancellation.nonRefundable) {
            cancellationRank = 2;
        }

        return {
            ...offer,
            cancellation,
            price,
            ranking: {
                cancellationRank,
                priceAvailable: price !== null
            }
        };
    });

    ranked.sort((a, b) => {

        // 1. Priorité aux conditions d'annulation.
        if (
            a.ranking.cancellationRank !==
            b.ranking.cancellationRank
        ) {
            return (
                a.ranking.cancellationRank -
                b.ranking.cancellationRank
            );
        }

        // 2. Ne pas comparer des devises différentes.
        const currencyA = String(a.currency || "").toUpperCase();
        const currencyB = String(b.currency || "").toUpperCase();

        if (currencyA !== currencyB) {
            return currencyA.localeCompare(currencyB);
        }

        // 3. Les prix connus avant les prix absents.
        if (a.price === null) return 1;
        if (b.price === null) return -1;

        // 4. Prix croissant à conditions équivalentes.
        return a.price - b.price;
    });

    return ranked.map((offer, index) => ({
        ...offer,
        position: index + 1
    }));
}


// ============================================================
// 🔐 TOURIZIA — STOCKAGE SÉCURISÉ DU CATALOGUE
// ============================================================

const HOTEL_CATALOGUE_TTL_MINUTES = 20;


// ------------------------------------------------------------
// CRÉER UN CATALOGUE APRÈS LA RECHERCHE LITEAPI
// ------------------------------------------------------------

async function createHotelOfferCatalogue(
    transactionId,
    request,
    offers
) {
    if (!hotelOfferCatalogues) {
        throw new Error("Collection catalogue MongoDB indisponible");
    }

    if (!transactionId) {
        throw new Error("transactionId manquant pour le catalogue");
    }

    if (!Array.isArray(offers) || offers.length === 0) {
        throw new Error("Aucune offre à enregistrer");
    }

    const now = new Date();

    const token = crypto.randomBytes(32).toString("hex");

    const storedOffers = offers.map(offer => {
        if (!offer.offerId) {
            throw new Error("Une offre LiteAPI ne possède pas d'offerId");
        }

        return {
            selectionId: crypto.randomBytes(16).toString("hex"),

            // Données privées : uniquement côté serveur.
            offerId: offer.offerId,

            providerOffer: offer
        };
    });

    const catalogue = {
        token,
        transactionId,

        request: {
            city: request.city,
            countryCode: request.countryCode,
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            adults: Number(request.adults || 2),
            children: Number(request.children || 0),
            rooms: Number(request.rooms || 1),
            guestNationality: request.guestNationality || "SN"
        },

        offers: storedOffers,

        createdAt: now,

        expiresAt: new Date(
            now.getTime() +
            HOTEL_CATALOGUE_TTL_MINUTES * 60 * 1000
        )
    };

    await hotelOfferCatalogues.insertOne(catalogue);

    console.log(
        "🔐 CATALOGUE HÔTEL ENREGISTRÉ:",
        transactionId,
        "| OFFRES:",
        storedOffers.length
    );

    return catalogue;
}


// ------------------------------------------------------------
// FORMATER UNE OFFRE PUBLIQUE
// Ne jamais envoyer les données brutes LiteAPI au navigateur.
// ------------------------------------------------------------

function formatPublicHotelOffer(storedOffer, index) {
    const offer = storedOffer.providerOffer || {};
    const cancellation = offer.cancellation || {};

    return {
        selectionId: storedOffer.selectionId,

        position: index + 1,

        hotel: {
    id: offer.hotelId || null,
    name: offer.hotelName || "Hôtel",
    address: offer.hotelAddress || "",
    image: offer.hotelImage || ""
},

        room: {
            name: offer.roomName || "Chambre"
        },

        price: offer.price ?? null,
        currency: offer.currency || "EUR",

        refundable: cancellation.refundable ?? (
            String(offer.refundableTag || "").toUpperCase() === "RFN"
        ),

        cancellation: {
            tag: cancellation.tag || (
                offer.refundableTag || "UNKNOWN"
            ),

            refundable: Boolean(cancellation.refundable),

            nonRefundable: Boolean(cancellation.nonRefundable),

            hasFreeCancellation: Boolean(
                cancellation.hasFreeCancellation
            ),

            freeCancellationUntil:
                cancellation.freeCancellationUntil || null,

            policyDetailsAvailable: Boolean(
                cancellation.policyDetailsAvailable
            ),

            penalties: Array.isArray(cancellation.penalties)
                ? cancellation.penalties
                : []
        }
    };
}


// ------------------------------------------------------------
// RÉCUPÉRER UN CATALOGUE VALIDE
// ------------------------------------------------------------

async function getHotelOfferCatalogue(token, transactionId) {
    if (!hotelOfferCatalogues) {
        throw new Error("Collection catalogue MongoDB indisponible");
    }

    if (!token || !transactionId) {
        return null;
    }

    return await hotelOfferCatalogues.findOne({
        token,
        transactionId,
        expiresAt: {
            $gt: new Date()
        }
    });
}


// ------------------------------------------------------------
// RETROUVER L'OFFRE CHOISIE PAR LE CLIENT
// ------------------------------------------------------------

async function getSelectedHotelOffer(
    token,
    transactionId,
    selectionId
) {
    if (!selectionId) {
        return null;
    }

    const catalogue = await getHotelOfferCatalogue(
        token,
        transactionId
    );

    if (!catalogue) {
        return null;
    }

    const selectedOffer = catalogue.offers.find(
        offer => offer.selectionId === selectionId
    );

    if (!selectedOffer) {
        return null;
    }

    return {
        catalogue,
        offer: selectedOffer.providerOffer,
        offerId: selectedOffer.offerId
    };
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
    checkin: data.checkIn,
    checkout: data.checkOut,

    currency: "USD",

    guestNationality:
        data.guestNationality || "SN",

    occupancies,

    // Accepter les tarifs remboursables et non remboursables.
    refundableRatesOnly: false,

    // Récupérer plusieurs tarifs par hôtel.
    maxRatesPerHotel: 10,

    // Augmenter le nombre d'hôtels examinés.
    limit: 5000,
    offset: 0,

    // Laisser LiteAPI travailler jusqu'à 12 secondes.
    timeout: 12,

    roomMapping: true,
    includeHotelData: true
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

    const cityLocation = await resolveLiteApiCity(
        data.city,
        data.countryCode
    );

    if (cityLocation.placeId) {

        // Ville retrouvée avec LiteAPI Places.
        requestBody.placeId = cityLocation.placeId;

        console.log("📍 RECHERCHE HÔTEL PAR PLACE ID :", {
            cityDemandee: data.city,
            villeLiteAPI: cityLocation.displayName,
            adresse: cityLocation.formattedAddress,
            placeId: cityLocation.placeId,
            countryCode: data.countryCode
        });

    } else {

        // Ville trouvée dans le catalogue classique LiteAPI.
        requestBody.cityName = cityLocation.cityName;
        requestBody.countryCode = data.countryCode;

        console.log("📍 RECHERCHE HÔTEL PAR VILLE :", {
            cityGeoNames: data.city,
            cityLiteAPI: cityLocation.cityName,
            countryCode: data.countryCode
        });
    }
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

const hotels = Array.isArray(result.data)
    ? result.data
    : result.data && typeof result.data === "object"
        ? [result.data]
        : [];
        // ============================================================
// LITEAPI — AUCUNE DISPONIBILITÉ = RÉSULTAT VIDE
// ============================================================

if (
    Number(result?.error?.code) === 2001 ||
    /no availability found/i.test(result?.error?.message || "")
) {
    console.warn("⚠️ LITEAPI : AUCUNE DISPONIBILITÉ", {
        city: data.city,
        checkIn: data.checkIn,
        checkOut: data.checkOut,
        code: result.error.code
    });

    return {
        raw: result,
        offers: [],
        totalOffers: 0
    };
}

const hotelMetadataById = new Map(
    (Array.isArray(result.hotels) ? result.hotels : [])
        .map(hotel => [
            String(hotel.id || hotel.hotelId || ""),
            hotel
        ])
        .filter(([id]) => id)
);

// ============================================================
// ⚡ TOURIZIA — PRÉCHARGEMENT PARALLÈLE DES DÉTAILS HÔTELS
// ============================================================

// ============================================================
// ⚡ TOURIZIA — RECHERCHE RAPIDE
// Les détails secondaires ne bloquent plus les offres.
// ============================================================

const hotelDetailsById = new Map();

console.log("⚡ RECHERCHE RAPIDE : détails secondaires ignorés", {
    hotels: hotels.length
});

console.log("⚡ TOURIZIA — RECHERCHE RAPIDE:", {
    hotelsReceived: hotels.length
});


console.log("🏨 LITEAPI — DIAGNOSTIC RÉPONSE:", {
    httpStatus: response.status,
    responseCode: result.code ?? null,
    responseMessage: result.message ?? null,
    hotelsReceived: hotels.length,
    metadataReceived: hotelMetadataById.size
});

if (!hotels.length) {
    console.warn(
        "⚠️ LITEAPI N'A RETOURNÉ AUCUN HÔTEL POUR CES CRITÈRES",
        {
            city: data.city,
            countryCode: data.countryCode,
            checkIn: data.checkIn,
            checkOut: data.checkOut,
            adults,
            children,
            rooms,
            guestNationality: data.guestNationality || "SN"
        }
    );
}


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

    
for (const hotel of hotels) {

    const roomTypes = Array.isArray(hotel.roomTypes)
        ? hotel.roomTypes
        : [];

    if (!roomTypes.length) {
        console.warn(
            "⚠️ HÔTEL SANS ROOMTYPES:",
            hotel.hotelId || hotel.id
        );
        continue;
    }

    const hotelId = hotel.hotelId || hotel.id;

    const hotelMetadata =
        hotelMetadataById.get(String(hotelId)) || {};

    const hotelData = {
        ...hotelMetadata,
        ...(hotel.hotelData || {})
    };
   // Détails déjà préchargés en parallèle.
const hotelDetails =
    hotelDetailsById.get(String(hotelId)) || {};

    for (const room of roomTypes) {
        const rates = Array.isArray(room.rates)
            ? room.rates
            : [];

        for (const rate of rates) {
            // L'offre doit avoir un véritable offerId.
            const offerId = rate.offerId || room.offerId;

if (!offerId) {
    console.warn(
        "⚠️ TARIF IGNORÉ — offerId manquant:",
        hotelId,
        room.name || room.roomName
    );
    continue;
}

            
const retailRate = rate.retailRate || {};

const roomRetailRate = Array.isArray(room.offerRetailRate)
    ? room.offerRetailRate[0]
    : room.offerRetailRate;

const roomInitialPrice = Array.isArray(room.offerInitialPrice)
    ? room.offerInitialPrice[0]
    : room.offerInitialPrice;

const price =
    retailRate.total?.[0]?.amount ??
    roomRetailRate?.amount ??
    roomInitialPrice?.amount ??
    null;

const currency =
    retailRate.total?.[0]?.currency ??
    roomRetailRate?.currency ??
    roomInitialPrice?.currency ??
    "USD";

            const cancellationPolicies =
                rate.cancellationPolicies ||
                rate.cancelationPolicies ||
                room.cancellationPolicies ||
                room.cancelationPolicies ||
                null;

            const refundable =
                cancellationPolicies?.refundableTag ??
                cancellationPolicies?.refundable ??
                null;

            offers.push({
    hotelId,

    // Identifiants LiteAPI conservés côté serveur
    offerId,
    rateId: rate.rateId || null,
    roomTypeId: room.roomTypeId || null,

    hotelName:
        hotelData.name ||
        hotel.name ||
        "",
                    hotelImage:
    hotelData.main_photo ||
    hotelData.mainPhoto ||
    hotelData.thumbnail ||
    hotelData.image ||
    hotelData.images?.[0]?.url ||
    hotelData.images?.[0] ||
    "",

                hotelAddress:
    formatLiteApiHotelAddress({
        ...hotelData,
        ...hotelDetails,
        address:
            hotelDetails.address ||
            hotelData.address ||
            hotelData.addressLine ||
            hotelData.address1 ||
            hotelData.street ||
            hotelData.location?.address ||
            hotelData.hotelAddress ||
            "",
        city:
            hotelDetails.city ||
            hotelDetails.city_name ||
            hotelData.city ||
            hotelData.city_name ||
            data.city,
        country:
            hotelDetails.country ||
            hotelDetails.country_code ||
            hotelData.countryName ||
            hotelData.country ||
            data.countryCode,
        zip:
            hotelDetails.zip ||
            hotelDetails.postalCode ||
            hotelData.zip ||
            hotelData.postalCode
    }),

hotelPhone:
    hotelDetails.phone ||
    hotelDetails.phoneNumber ||
    hotelDetails.telephone ||
    hotelData.phone ||
    hotelData.phoneNumber ||
    "",

hotelEmail:
    hotelDetails.email ||
    hotelDetails.contactEmail ||
    hotelData.email ||
    "",

hotelWebsite:
    hotelDetails.website ||
    hotelDetails.webSite ||
    hotelDetails.url ||
    hotelData.website ||
    "",

hotelOwner:
    hotelDetails.owner?.name ||
    hotelDetails.owner?.fullName ||
    hotelDetails.ownerName ||
    hotelData.ownerName ||
    "",

                offerId,

                roomName:
                    rate.name ||
                    room.name ||
                    room.roomName ||
                    "Chambre",

                price,
                currency,
                refundable,
                refundableTag: refundable,

                cancellationPolicies,

                retailRate,

                offerRetailRate:
                    room.offerRetailRate || null,

                offerInitialPrice:
                    room.offerInitialPrice || null,

                raw: {
                    ...room,
                    selectedRate: rate
                }
            });
        }
    }
}


    

    console.log(
        "🏨 OFFRES TROUVÉES:",
        offers.length
    );
   // ========================================================
// 🏆 CLASSEMENT DU CATALOGUE D'OFFRES
// ========================================================
console.log("========================================");
console.log("📊 BILAN RECHERCHE TOURIZIA");
console.log("========================================");

console.log("🏨 HÔTELS REÇUS:", hotels.length);
console.log("🛏️ TARIFS EXPLOITABLES:", offers.length);

console.log(
    "🆔 TARIFS AVEC OFFER ID:",
    offers.filter(o => Boolean(o.offerId)).length
);

console.log(
    "💰 TARIFS AVEC PRIX:",
    offers.filter(o => o.price !== null).length
);

console.log(
    "📍 TARIFS AVEC ADRESSE:",
    offers.filter(o => Boolean(o.hotelAddress)).length
);

console.log("========================================");


const rankedOffers = rankHotelOffers(offers);

console.log(
    "🏨 CATALOGUE LITEAPI:",
    rankedOffers.length,
    "offres"
);

return {
    raw: result,
    offers: rankedOffers,
    totalOffers: rankedOffers.length
};

}

// ============================================================
// SEARCH HOTELS
// ============================================================

// ============================================================
// 🔐 3D.1 — RECHERCHE HÔTEL APRÈS PAIEMENT CONFIRMÉ
// ============================================================


// ============================================================
// 🔐 3D.2 — RECHERCHE SÉCURISÉE, VERROUILLAGE ET RETRY
// ============================================================

app.post("/api/search-hotels", async (req, res) => {

    let transactionId = null;
    let searchClaimed = false;

    try {

        ({ transactionId } = req.body || {});

        if (!transactionId) {
            return res.status(400).json({
                success: false,
                error: "transactionId manquant"
            });
        }

        if (!hotelTransactions || !hotelOfferCatalogues) {
            return res.status(503).json({
                success: false,
                error: "Base de données indisponible"
            });
        }

        // 1. Vérifier la transaction
        const transaction = await hotelTransactions.findOne({
            transactionId,
            type: "hotel"
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: "Transaction introuvable"
            });
        }
        // Dossier déjà transmis à la recherche manuelle.
// On renvoie son état sans renvoyer un deuxième email.
if (
    transaction.status ===
    HOTEL_TRANSACTION_STATUS.MANUAL_SEARCH_REQUIRED
) {
    return res.status(200).json({
        success: true,
        available: false,
        manualSearchRequired: true,
        retryAllowed: false,
        status: HOTEL_TRANSACTION_STATUS.MANUAL_SEARCH_REQUIRED,
        transactionId,
        message: "Votre demande est prise en charge par l'équipe Tourizia."
    });
}

        // 2. Vérifier le statut
        if (transaction.status === HOTEL_TRANSACTION_STATUS.SEARCHING) {
            return res.status(409).json({
                success: false,
                error: "Une recherche est déjà en cours pour cette transaction"
            });
        }

        if (transaction.status !== HOTEL_TRANSACTION_STATUS.PAID) {
            return res.status(403).json({
                success: false,
                error: "Transaction non autorisée pour une nouvelle recherche",
                status: transaction.status
            });
        }

        // 3. Récupérer les critères enregistrés côté serveur
        const searchData = {
            city: transaction.request.city,
            countryCode: transaction.request.countryCode,
            checkIn: transaction.request.checkIn,
            checkOut: transaction.request.checkOut,
            adults: transaction.request.adults,
            children: transaction.request.children,
            rooms: transaction.request.rooms,
            guestNationality:
                transaction.request.guestNationality || "SN"
        };

        // 4. VERROUILLAGE ATOMIQUE
        // Une seule requête peut faire PAID → SEARCHING.
        const claimTime = new Date();

        const claim = await hotelTransactions.updateOne(
            {
                transactionId,
                type: "hotel",
                status: HOTEL_TRANSACTION_STATUS.PAID
            },
            {
                $set: {
                    status: HOTEL_TRANSACTION_STATUS.SEARCHING,
                    updatedAt: claimTime,
                    error: null
                },
                $push: {
                    history: {
                        status: HOTEL_TRANSACTION_STATUS.SEARCHING,
                        at: claimTime
                    }
                }
            }
        );

        if (claim.modifiedCount !== 1) {
            return res.status(409).json({
                success: false,
                error: "Recherche déjà démarrée ou transaction modifiée"
            });
        }

        searchClaimed = true;

        console.log("🔒 RECHERCHE VERROUILLÉE:", transactionId);

        // 5. Recherche LiteAPI
        const result = await searchHotelOffers(searchData);

       // ============================================================
// 6. AUCUNE OFFRE LITEAPI → RECHERCHE MANUELLE TOURIZIA
// ============================================================

if (!Array.isArray(result.offers) || result.offers.length === 0) {

    const manualTime = new Date();

    // Transition atomique : SEARCHING → MANUAL_SEARCH_REQUIRED
    // Une seule requête pourra déclencher l'email administrateur.
    const manualUpdate = await hotelTransactions.updateOne(
        {
            transactionId,
            type: "hotel",
            status: HOTEL_TRANSACTION_STATUS.SEARCHING
        },
        {
            $set: {
                status: HOTEL_TRANSACTION_STATUS.MANUAL_SEARCH_REQUIRED,
                updatedAt: manualTime,
                error: null,

                manualSearch: {
                    required: true,
                    reason: "Aucune offre LiteAPI disponible pour les critères demandés.",
                    requestedAt: manualTime,
                    notificationStatus: "PENDING"
                }
            },
            $push: {
                history: {
                    status: HOTEL_TRANSACTION_STATUS.MANUAL_SEARCH_REQUIRED,
                    at: manualTime
                }
            }
        }
    );

    searchClaimed = false;

    // Si la transition n'a pas été effectuée, ne pas envoyer de doublon.
    if (manualUpdate.modifiedCount !== 1) {

        console.warn(
            "⚠️ RECHERCHE MANUELLE : transition déjà effectuée",
            transactionId
        );

        return res.status(409).json({
            success: false,
            error: "Le dossier a déjà été traité ou son statut a changé."
        });
    }

    console.log(
        "📌 DOSSIER TRANSMIS À LA RECHERCHE MANUELLE TOURIZIA:",
        transactionId
    );

    // ============================================================
// INFORMATIONS COMMUNES : POPUP CLIENT + EMAILS
// ============================================================

const requestDetails = {
    transactionId,

    fullName: transaction.customer?.fullName || "",
    email: transaction.customer?.email || "",
    phone: transaction.customer?.phone || "",

    city: searchData.city || "",
    countryCode: searchData.countryCode || "",

    checkIn: searchData.checkIn || "",
    checkOut: searchData.checkOut || "",

    adults: Number(searchData.adults || 0),
    children: Number(searchData.children || 0),
    rooms: Number(searchData.rooms || 1),

    guestNationality: searchData.guestNationality || "SN",

    guests: Array.isArray(transaction.request?.guests)
        ? transaction.request.guests
        : []
};

// ============================================================
// EMAIL ADMINISTRATEUR
// ============================================================

const manualNotificationData = {
    ...requestDetails,

    paymentId:
        transaction.payment?.paymentId ||
        transaction.payment?.stripeSessionId ||
        transaction.payment?.paytechReference ||
        transactionId,

    paymentMethod:
        transaction.payment?.method || "",

    paytechReference:
        transaction.payment?.paytechReference || "",

    paytechAmount:
        transaction.payment?.amount || 0,

    hotelName: "",
    roomName: ""
};

let adminNotificationStatus = "FAILED";

try {

    const adminEmailResult =
        await sendHotelManualSearchNotification(
            manualNotificationData,
            "Aucune offre LiteAPI disponible pour la destination et les dates demandées."
        );

    if (adminEmailResult) {
        adminNotificationStatus = "SENT";
    }

} catch (emailError) {

    console.error(
        "❌ EMAIL ADMIN RECHERCHE MANUELLE:",
        emailError
    );
}

// ============================================================
// EMAIL CLIENT
// ============================================================

let customerNotificationStatus = "FAILED";

try {

    const customerEmailResult =
        await sendHotelManualSearchCustomerEmail(requestDetails);

    if (customerEmailResult) {
        customerNotificationStatus = "SENT";
    }

} catch (emailError) {

    console.error(
        "❌ EMAIL CLIENT RECHERCHE MANUELLE:",
        emailError
    );
}

// Enregistrer les résultats des notifications.
await hotelTransactions.updateOne(
    {
        transactionId,
        type: "hotel",
        status: HOTEL_TRANSACTION_STATUS.MANUAL_SEARCH_REQUIRED
    },
    {
        $set: {
            "manualSearch.notificationStatus": adminNotificationStatus,
            "manualSearch.notificationUpdatedAt": new Date(),
            "manualSearch.customerNotificationStatus": customerNotificationStatus,
            "manualSearch.customerNotificationUpdatedAt": new Date()
        }
    }
);

console.log("📧 NOTIFICATION ADMIN:", adminNotificationStatus);
console.log("📧 NOTIFICATION CLIENT:", customerNotificationStatus);

// ============================================================
// RÉPONSE AU FRONTEND : DONNÉES POUR LA POPUP PREMIUM
// ============================================================

return res.status(200).json({
    success: true,
    available: false,
    manualSearchRequired: true,
    retryAllowed: false,

    status: HOTEL_TRANSACTION_STATUS.MANUAL_SEARCH_REQUIRED,

    transactionId,

    message: "Votre demande est prise en charge par l'équipe Tourizia.",

    requestDetails: {
        ...requestDetails,

        checkInFormatted: formatHotelDate(requestDetails.checkIn),
        checkOutFormatted: formatHotelDate(requestDetails.checkOut)
    },

    redirectUrl: "https://tourizia.com/"
});

}

        // 7. Enregistrer le catalogue privé
        const catalogue = await createHotelOfferCatalogue(
            transactionId,
            searchData,
            result.offers
        );

        // 8. Transition atomique SEARCHING → OFFER_FOUND
        const foundTime = new Date();

        const foundUpdate = await hotelTransactions.updateOne(
            {
                transactionId,
                type: "hotel",
                status: HOTEL_TRANSACTION_STATUS.SEARCHING
            },
            {
                $set: {
                    status: HOTEL_TRANSACTION_STATUS.OFFER_FOUND,
                    updatedAt: foundTime,
                    error: null
                },
                $push: {
                    history: {
                        status: HOTEL_TRANSACTION_STATUS.OFFER_FOUND,
                        at: foundTime
                    }
                }
            }
        );

        if (foundUpdate.modifiedCount !== 1) {

            // Ne pas conserver un catalogue inutilisable.
            await hotelOfferCatalogues.deleteOne({
                token: catalogue.token,
                transactionId
            });

            searchClaimed = false;

            return res.status(409).json({
                success: false,
                error: "La transaction a changé pendant la recherche"
            });
        }

        searchClaimed = false;

        // 9. Préparer les offres publiques
        const publicOffers = catalogue.offers.map(
            (offer, index) => formatPublicHotelOffer(offer, index)
        );

        console.log(
            "✅ OFFRES DISPONIBLES:",
            transactionId,
            "|",
            publicOffers.length
        );

        return res.json({
    success: true,
    available: true,
    transactionId,
    catalogueToken: catalogue.token,

    request: catalogue.request,

    offers: publicOffers
});

    } catch (error) {

        console.error("❌ SECURE HOTEL SEARCH ERROR:", error);

        // 10. En cas d'erreur, libérer le verrou
        if (searchClaimed && transactionId && hotelTransactions) {

            try {

                const resetTime = new Date();

                await hotelTransactions.updateOne(
                    {
                        transactionId,
                        type: "hotel",
                        status: HOTEL_TRANSACTION_STATUS.SEARCHING
                    },
                    {
                        $set: {
                            status: HOTEL_TRANSACTION_STATUS.PAID,
                            updatedAt: resetTime,
                            error: "HOTEL_SEARCH_FAILED"
                        },
                        $push: {
                            history: {
                                status: HOTEL_TRANSACTION_STATUS.PAID,
                                at: resetTime
                            }
                        }
                    }
                );

            } catch (resetError) {
                console.error(
                    "❌ IMPOSSIBLE DE LIBÉRER LE VERROU:",
                    resetError
                );
            }
        }

        return res.status(500).json({
            success: false,
            retryAllowed: true,
            error: "Erreur pendant la recherche. Vous pouvez réessayer."
        });

    }

});


// ============================================================
// 🔐 3D.3 — SÉLECTION SÉCURISÉE D'UNE OFFRE HÔTEL
// ============================================================

app.post("/api/select-hotel-offer", async (req, res) => {

    console.log("🟢 TOURIZIA — REQUÊTE DE SÉLECTION REÇUE");

    console.log("📥 DONNÉES DE SÉLECTION:", {
        transactionId: req.body?.transactionId || null,
        catalogueTokenPresent: !!req.body?.catalogueToken,
        selectionId: req.body?.selectionId || null
    });

    try {

        const {
            transactionId,
            catalogueToken,
            selectionId
        } = req.body || {};

        // 1. Vérifier les paramètres
        if (!transactionId || !catalogueToken || !selectionId) {
            return res.status(400).json({
                success: false,
                error: "transactionId, catalogueToken et selectionId sont obligatoires"
            });
        }

        if (!hotelTransactions || !hotelOfferCatalogues) {
            return res.status(503).json({
                success: false,
                error: "Base de données indisponible"
            });
        }

        // 2. Vérifier la transaction
        const transaction = await hotelTransactions.findOne({
            transactionId,
            type: "hotel"
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: "Transaction introuvable"
            });
        }

        if (transaction.status !== HOTEL_TRANSACTION_STATUS.OFFER_FOUND) {
            return res.status(409).json({
                success: false,
                error: "Cette transaction ne permet pas de sélectionner une offre",
                status: transaction.status
            });
        }

        // 3. Retrouver l'offre depuis le catalogue privé
        const selected = await getSelectedHotelOffer(
            catalogueToken,
            transactionId,
            selectionId
        );

        if (!selected) {
            return res.status(404).json({
                success: false,
                error: "Offre introuvable ou catalogue expiré"
            });
        }

        const offer = selected.offer;

        if (!selected.offerId) {
            return res.status(400).json({
                success: false,
                error: "Identifiant fournisseur de l'offre manquant"
            });
        }

        // 4. Enregistrer la sélection de façon atomique
        const selectedTime = new Date();

        const selectionUpdate = await hotelTransactions.updateOne(
            {
                transactionId,
                type: "hotel",
                status: HOTEL_TRANSACTION_STATUS.OFFER_FOUND
            },
            {
                $set: {
                    status: HOTEL_TRANSACTION_STATUS.OFFER_SELECTED,
                    updatedAt: selectedTime,

                   "provider.hotelId": offer.hotelId || null,
"provider.hotelName": offer.hotelName || null,
"provider.roomName": offer.roomName || null,

// Coordonnées exactes transmises par LiteAPI
"provider.hotelAddress": offer.hotelAddress || "",
"provider.hotelPhone": offer.hotelPhone || "",
"provider.hotelEmail": offer.hotelEmail || "",
"provider.hotelWebsite": offer.hotelWebsite || "",

                    // Privé : ne jamais renvoyer cet ID au navigateur.
                    "provider.offerId": selected.offerId,

                    "provider.price": offer.price ?? null,
                    "provider.currency": offer.currency || null,

                    selectedOffer: {
                        selectionId,
                        catalogueToken,
                        hotelName: offer.hotelName || null,
                        roomName: offer.roomName || null,
                        price: offer.price ?? null,
                        currency: offer.currency || null,
                        selectedAt: selectedTime
                    },

                    error: null
                },
                $push: {
                    history: {
                        status: HOTEL_TRANSACTION_STATUS.OFFER_SELECTED,
                        at: selectedTime
                    }
                }
            }
        );

        if (selectionUpdate.modifiedCount !== 1) {
            return res.status(409).json({
                success: false,
                error: "Cette offre a déjà été sélectionnée ou la transaction a changé"
            });
        }

        console.log(
            "✅ OFFRE SÉLECTIONNÉE:",
            transactionId,
            "|",
            offer.hotelName,
            "|",
            offer.roomName
        );

        // 5. Réponse publique : aucun offerId LiteAPI exposé.
        return res.json({
            success: true,
            selected: true,
            transactionId,
            status: HOTEL_TRANSACTION_STATUS.OFFER_SELECTED,
            hotel: {
                id: offer.hotelId || null,
                name: offer.hotelName || null
            },
            room: {
                name: offer.roomName || null
            },
            price: offer.price ?? null,
            currency: offer.currency || null,
            message: "Offre sélectionnée. En attente de vérification PREBOOK."
        });

    } catch (error) {

        console.error("❌ HOTEL OFFER SELECTION ERROR:", error);

        return res.status(500).json({
            success: false,
            error: "Erreur pendant la sélection de l'offre"
        });

    }

});


// ============================================================
// 🔐 3D.4 — PREBOOK UNIQUEMENT DE L'OFFRE SÉLECTIONNÉE
// L'offerId est récupéré exclusivement depuis MongoDB.
// Le navigateur ne doit jamais envoyer cet identifiant.
// ============================================================

app.post("/api/prebook-selected-hotel", async (req, res) => {
    let transactionId = null;
    let prebookClaimed = false;

    try {
        transactionId = req.body?.transactionId;

        if (
            typeof transactionId !== "string" ||
            !transactionId.trim()
        ) {
            return res.status(400).json({
                success: false,
                error: "transactionId obligatoire"
            });
        }

        if (!hotelTransactions) {
            return res.status(503).json({
                success: false,
                error: "Base de données indisponible"
            });
        }

        // 1. Vérifier la transaction et son état.
        const transaction = await hotelTransactions.findOne({
            transactionId,
            type: "hotel"
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: "Transaction introuvable"
            });
        }

        if (
            transaction.status !==
            HOTEL_TRANSACTION_STATUS.OFFER_SELECTED
        ) {
            return res.status(409).json({
                success: false,
                error: "La transaction ne permet pas ce PREBOOK",
                status: transaction.status
            });
        }

        // 2. L'offerId vient exclusivement de MongoDB.
        const offerId = transaction.provider?.offerId;

        if (
            typeof offerId !== "string" ||
            !offerId.trim()
        ) {
            return res.status(409).json({
                success: false,
                error: "Identifiant de l'offre sélectionnée absent du dossier serveur"
            });
        }

        // 3. Vérifier les critères enregistrés côté serveur.
        const checkIn = transaction.request?.checkIn;

        if (!checkIn) {
            return res.status(409).json({
                success: false,
                error: "Date d'arrivée absente du dossier de réservation"
            });
        }

        // 4. Verrou atomique : OFFER_SELECTED -> PREBOOKING.
        const claimTime = new Date();

        const claim = await hotelTransactions.updateOne(
            {
                transactionId,
                type: "hotel",
                status: HOTEL_TRANSACTION_STATUS.OFFER_SELECTED,
                "provider.offerId": offerId
            },
            {
                $set: {
                    status: HOTEL_TRANSACTION_STATUS.PREBOOKING,
                    updatedAt: claimTime
                },
                $push: {
                    history: {
                        status: HOTEL_TRANSACTION_STATUS.PREBOOKING,
                        at: claimTime
                    }
                }
            }
        );

        if (claim.modifiedCount !== 1) {
            return res.status(409).json({
                success: false,
                error: "Un PREBOOK est déjà en cours ou la transaction a changé"
            });
        }

        prebookClaimed = true;

        // 5. Appel LiteAPI avec l'offerId récupéré dans MongoDB.
        console.log(
            "🔐 3D.4 — PREBOOK DE L'OFFRE SÉLECTIONNÉE:",
            transactionId
        );

        const prebook = await prebookHotelOffer(offerId);

        const prebookData = prebook?.data || prebook;

       // 6. POLITIQUE D'ANNULATION : PRIORITÉ À L'OFFRE LITEAPI
// Le client a choisi librement cette offre.
// Tourizia ne filtre ni ne rejette ses conditions d'annulation.

const freshPolicies =
    getPrebookCancellationPolicies(prebook);

const providerPolicies =
    freshPolicies ||
    transaction.provider?.cancellationPolicies ||
    null;

const providerRefundable =
    providerPolicies?.refundableTag ??
    providerPolicies?.refundable ??
    transaction.provider?.refundable ??
    null;

console.log("📅 POLITIQUE FOURNISSEUR CONSERVÉE:", {
    hotel: transaction.provider?.hotelName,
    room: transaction.provider?.roomName,
    refundable: providerRefundable,
    policyAvailable: Boolean(providerPolicies)
});

        // 7. Enregistrer uniquement les informations utiles.
        // Ne pas enregistrer la réponse LiteAPI complète.
       // 7. Récupérer le véritable identifiant PREBOOK LiteAPI
const prebookId =
    prebookData?.prebookId ||
    prebookData?.prebookReference ||
    prebookData?.id ||
    null;

if (!prebookId) {
    throw new Error(
        "PREBOOK validé sans prebookId LiteAPI exploitable"
    );
}

const prebookTime = new Date();

        const prebookUpdate = await hotelTransactions.updateOne(
            {
                transactionId,
                type: "hotel",
                status: HOTEL_TRANSACTION_STATUS.PREBOOKING,
                "provider.offerId": offerId
            },
            {
                $set: {
                    status: HOTEL_TRANSACTION_STATUS.PREBOOKED,
                    updatedAt: prebookTime,

                    "provider.prebookedAt": prebookTime,
                    "provider.prebookStatus": "SUCCESS",

                   "provider.cancellationPolicies": providerPolicies,
"provider.refundable": providerRefundable,

                   "provider.prebookId": prebookId,

"provider.prebookReference": prebookId
                },
                $push: {
                    history: {
                        status: HOTEL_TRANSACTION_STATUS.PREBOOKED,
                        at: prebookTime
                    }
                },
                $unset: {
                    error: ""
                }
            }
        );

        if (prebookUpdate.modifiedCount !== 1) {
            throw new Error(
                "PREBOOK effectué chez LiteAPI, mais mise à jour MongoDB impossible"
            );
        }

        prebookClaimed = false;

        console.log(
            "✅ 3D.4 PREBOOK VALIDÉ:",
            transactionId
        );

        return res.json({
            success: true,
            prebooked: true,
            transactionId,
            status: HOTEL_TRANSACTION_STATUS.PREBOOKED,

            hotel: {
                id: transaction.provider.hotelId || null,
                name: transaction.provider.hotelName || null
            },

            room: {
                name: transaction.provider.roomName || null
            },

            price: transaction.provider.price ?? null,
            currency: transaction.provider.currency || null,

            cancellation: {
    refundable: providerRefundable,
    policies: providerPolicies,
    policiesVerified: Boolean(providerPolicies),
    source: "LiteAPI"
},

            message:
                "Offre sélectionnée et PREBOOK validé par LiteAPI. Aucune réservation définitive n'a encore été effectuée."
        });

    } catch (error) {
        console.error(
            "❌ 3D.4 PREBOOK ERROR:",
            transactionId,
            error
        );

        // Si le PREBOOK échoue, permettre une nouvelle tentative.
        if (prebookClaimed && transactionId && hotelTransactions) {
            try {
                const resetTime = new Date();

                await hotelTransactions.updateOne(
                    {
                        transactionId,
                        type: "hotel",
                        status: HOTEL_TRANSACTION_STATUS.PREBOOKING
                    },
                    {
                        $set: {
                            status: HOTEL_TRANSACTION_STATUS.OFFER_SELECTED,
                            updatedAt: resetTime,
                            error: {
                                step: "PREBOOK",
                                message: error.message,
                                at: resetTime
                            }
                        },
                        $push: {
                            history: {
                                status: HOTEL_TRANSACTION_STATUS.OFFER_SELECTED,
                                at: resetTime,
                                reason: "PREBOOK_FAILED"
                            }
                        }
                    }
                );
            } catch (resetError) {
                console.error(
                    "❌ IMPOSSIBLE DE RÉTABLIR OFFER_SELECTED:",
                    resetError
                );
            }
        }

        return res.status(500).json({
            success: false,
            error: "Le PREBOOK de l'offre sélectionnée a échoué",
            message: error.message,
            retryAllowed: prebookClaimed
        });
    }
});
// ============================================================
// 🏨 BOOK DÉFINITIF — OFFRE DÉJÀ PREBOOKÉE
// ============================================================

app.post("/api/book-selected-hotel", async (req, res) => {
    const transactionId = req.body?.transactionId;

    if (
        typeof transactionId !== "string" ||
        !transactionId.trim()
    ) {
        return res.status(400).json({
            success: false,
            error: "transactionId obligatoire"
        });
    }

    if (!hotelTransactions) {
        return res.status(503).json({
            success: false,
            error: "Base de données indisponible"
        });
    }

    let bookingClaimed = false;

    try {
        // 1. Récupérer le dossier enregistré côté serveur.
        const transaction = await hotelTransactions.findOne({
            transactionId,
            type: "hotel"
        });

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: "Transaction introuvable"
            });
        }

        // Déjà confirmé : ne jamais rappeler LiteAPI.
        if (
            transaction.status ===
            HOTEL_TRANSACTION_STATUS.CONFIRMED
        ) {
            return res.json({
                success: true,
                status: "CONFIRMED",
                alreadyConfirmed: true,
                confirmationNumber:
                    transaction.provider?.confirmationNumber || null,
                bookingId:
                    transaction.provider?.bookingId || null
            });
        }

        if (
            transaction.status ===
            HOTEL_TRANSACTION_STATUS.BOOKING
        ) {
            return res.status(409).json({
                success: false,
                status: "BOOKING",
                error: "La réservation définitive est déjà en cours."
            });
        }

        if (
            transaction.status ===
            HOTEL_TRANSACTION_STATUS.BOOKING_UNKNOWN
        ) {
            return res.status(409).json({
                success: false,
                status: "BOOKING_UNKNOWN",
                error: "Le résultat du BOOK doit être vérifié auprès de LiteAPI avant toute nouvelle tentative."
            });
        }

        if (
            transaction.status !==
            HOTEL_TRANSACTION_STATUS.PREBOOKED
        ) {
            return res.status(409).json({
                success: false,
                error: "La transaction n'est pas au statut PREBOOKED.",
                status: transaction.status
            });
        }

        // 2. Récupérer le véritable identifiant PREBOOK.
        const prebookId =
            transaction.provider?.prebookId ||
            transaction.provider?.prebookReference;

        if (!prebookId) {
            return res.status(409).json({
                success: false,
                error: "Identifiant PREBOOK LiteAPI absent."
            });
        }

        // 3. Verrou atomique : une seule tentative BOOK.
        const claimTime = new Date();

        const claim = await hotelTransactions.updateOne(
            {
                transactionId,
                type: "hotel",
                status: HOTEL_TRANSACTION_STATUS.PREBOOKED
            },
            {
                $set: {
                    status: HOTEL_TRANSACTION_STATUS.BOOKING,
                    updatedAt: claimTime
                },
                $push: {
                    history: {
                        status: HOTEL_TRANSACTION_STATUS.BOOKING,
                        at: claimTime
                    }
                }
            }
        );

        if (claim.modifiedCount !== 1) {
            return res.status(409).json({
                success: false,
                error: "Une réservation est déjà en cours ou le dossier a changé."
            });
        }

        bookingClaimed = true;

        // 4. Construire les données exclusivement depuis MongoDB.
        const customer = transaction.customer || {};
        const request = transaction.request || {};
        const provider = transaction.provider || {};

        if (!customer.email || !customer.fullName) {
            throw new Error(
                "Informations client incomplètes dans la transaction."
            );
        }

        const bookingData = {
            fullName: customer.fullName,
            email: customer.email,
            phone: customer.phone || "",

            adults: request.adults || 2,
            children: request.children || 0,
            rooms: request.rooms || 1,

            city: request.city || "",
            countryCode: request.countryCode || "",
            checkIn: request.checkIn || "",
            checkOut: request.checkOut || "",
            guestNationality: request.guestNationality || "SN",

            guests: request.guests || [],

            paymentId:
                transaction.payment?.paymentId ||
                transaction.payment?.stripeSessionId ||
                transaction.payment?.paytechReference ||
                transactionId,

            hotelName: provider.hotelName || "",
            hotelId: provider.hotelId || null,
            roomName: provider.roomName || ""
        };

        // 5. Appeler le BOOK définitif LiteAPI.
        console.log(
            "🏨 BOOK DÉFINITIF — TRANSACTION:",
            transactionId
        );

        const bookingResult = await bookHotel(
            bookingData,
            prebookId
        );

        // 6. Extraire les références de réservation.
        const bookingDataResult =
            bookingResult?.data ||
            bookingResult?.booking ||
            bookingResult;

        const bookingId =
            bookingResult?.bookingId ||
            bookingDataResult?.bookingId ||
            bookingResult?.id ||
            bookingDataResult?.id ||
            null;

        const confirmationNumber =
            bookingResult?.confirmationNumber ||
            bookingDataResult?.confirmationNumber ||
            bookingDataResult?.reference ||
            bookingId;

            // ========================================================
// 📅 CONDITIONS D'ANNULATION : BOOK → PREBOOK → LITEAPI
// ========================================================

const cancellationPolicies =
    bookingDataResult?.cancellationPolicies ||
    transaction.provider?.cancellationPolicies ||
    null;

const refundableTag =
    bookingDataResult?.refundableTag ||
    cancellationPolicies?.refundableTag ||
    cancellationPolicies?.refundable ||
    transaction.provider?.refundable ||
    null;

console.log("📅 CONDITIONS D'ANNULATION POUR CONFIRMATION:", {
    source: bookingDataResult?.cancellationPolicies
        ? "BOOK_LITEAPI"
        : "PREBOOK_LITEAPI",
    policyAvailable: Boolean(cancellationPolicies),
    refundableTag
});
        // Sans référence exploitable, ne pas annoncer une confirmation.
        if (!bookingId && !confirmationNumber) {
            await hotelTransactions.updateOne(
                {
                    transactionId,
                    status: HOTEL_TRANSACTION_STATUS.BOOKING
                },
                {
                    $set: {
                        status: HOTEL_TRANSACTION_STATUS.BOOKING_UNKNOWN,
                        updatedAt: new Date(),
                        error:
                            "Réponse LiteAPI reçue sans référence de réservation exploitable."
                    },
                    $push: {
                        history: {
                            status: HOTEL_TRANSACTION_STATUS.BOOKING_UNKNOWN,
                            at: new Date()
                        }
                    }
                }
            );

            bookingClaimed = false;

            return res.status(202).json({
                success: false,
                status: "BOOKING_UNKNOWN",
                error: "Réponse LiteAPI à vérifier avant confirmation."
            });
        }

        // 7. Enregistrer la réservation définitive.
        const confirmedAt = new Date();

        const confirmationUpdate =
            await hotelTransactions.updateOne(
                {
                    transactionId,
                    status: HOTEL_TRANSACTION_STATUS.BOOKING
                },
                {
                    $set: {
                        status: HOTEL_TRANSACTION_STATUS.CONFIRMED,
                        updatedAt: confirmedAt,
                        confirmedAt,

                        "provider.bookingId": bookingId,
                        "provider.confirmationNumber":
                            confirmationNumber,

                        "provider.hotelId":
                            provider.hotelId || null,

                        "provider.hotelName":
                            provider.hotelName || null,

                       "provider.roomName":
    provider.roomName || null,
    "provider.hotelAddress": provider.hotelAddress || "",
"provider.hotelPhone": provider.hotelPhone || "",
"provider.hotelEmail": provider.hotelEmail || "",
"provider.hotelWebsite": provider.hotelWebsite || "",

"provider.cancellationPolicies":
    cancellationPolicies,

"provider.refundable":
    refundableTag,

"cancellation.allowed":
    Boolean(cancellationPolicies),

"cancellation.policy": {
    refundableTag,
    cancelPolicyInfos:
        cancellationPolicies?.cancelPolicyInfos || [],
    hotelRemarks:
        cancellationPolicies?.hotelRemarks || []
},

"cancellation.status": "ACTIVE"

                    },
                    $push: {
                        history: {
                            status: HOTEL_TRANSACTION_STATUS.CONFIRMED,
                            at: confirmedAt
                        }
                    },
                    $unset: {
                        error: ""
                    }
                }
            );

        if (confirmationUpdate.modifiedCount !== 1) {
            // Le BOOK a peut-être réussi chez LiteAPI.
            // Ne surtout pas rappeler automatiquement bookHotel().
            bookingClaimed = false;

            return res.status(202).json({
                success: false,
                status: "BOOKING_UNKNOWN",
                error: "BOOK LiteAPI effectué, mais confirmation MongoDB à vérifier."
            });
        }

                // ==================================================
        // 📄 GÉNÉRATION PDF + EMAIL APRÈS CONFIRMATION LITEAPI
        // ==================================================

        let documentSent = false;
        let documentError = null;

        try {
            const bookingDocument = {
                success: true,

                paymentId:
                    transaction.payment?.paymentId ||
                    transaction.payment?.stripeSessionId ||
                    transactionId,

                paymentMethod:
                    transaction.payment?.method || "",

                email: customer.email,
                fullName: customer.fullName,
                phone: customer.phone || "",

                bookingId,
                confirmationNumber,

                hotelId: provider.hotelId || "",
hotelName: provider.hotelName || "",
hotelAddress: provider.hotelAddress || "",

hotelPhone: provider.hotelPhone || "",
hotelEmail: provider.hotelEmail || "",
hotelWebsite: provider.hotelWebsite || "",

roomName: provider.roomName || "",

                city: request.city || "",
                countryCode: request.countryCode || "",

                checkIn: request.checkIn,
                checkOut: request.checkOut,

                adults: request.adults || 1,
                children: request.children || 0,
                rooms: request.rooms || 1,

                guests: Array.isArray(request.guests)
                    ? request.guests
                    : [],

                totalPersons:
                    Number(request.adults || 0) +
                    Number(request.children || 0),

                providerPrice: provider.price || null,
                providerCurrency: provider.currency || "",

               refundable: refundableTag,

cancellationPolicies:
    cancellationPolicies
            };

            const documentResult =
                await generateAndSendHotelConfirmation(
                    bookingDocument
                );

            documentSent = true;

            await hotelTransactions.updateOne(
                { transactionId },
                {
                    $set: {
                        documentStatus: "SENT",
                        documentSentAt: new Date(),
                        documentReference:
                            documentResult.reference
                    }
                }
            );

            console.log(
                "✅ PDF ET EMAIL ENVOYÉS:",
                customer.email
            );

        } catch (documentErrorCaught) {

            documentError =
                documentErrorCaught.message ||
                String(documentErrorCaught);

            console.error(
                "❌ ERREUR PDF / EMAIL:",
                documentError
            );

            await hotelTransactions.updateOne(
                { transactionId },
                {
                    $set: {
                        documentStatus: "ERROR",
                        documentError,
                        documentErrorAt: new Date()
                    }
                }
            );
        }
        bookingClaimed = false;

        console.log(
            "✅ RÉSERVATION HÔTEL CONFIRMÉE:",
            confirmationNumber
        );

        return res.json({
            success: true,
            status: "CONFIRMED",
            transactionId,
            bookingId,
            confirmationNumber,
                documentSent,
    documentError,
            hotel: {
                name: provider.hotelName || "",
                room: provider.roomName || ""
            },
            message: "Réservation définitive confirmée par LiteAPI."
        });

    } catch (error) {
        console.error(
            "❌ BOOK DÉFINITIF ERROR:",
            error
        );

        // En cas d'erreur pendant l'appel externe, on ne relance
        // jamais automatiquement le BOOK : le résultat peut être ambigu.
        if (bookingClaimed) {
            try {
                await hotelTransactions.updateOne(
                    {
                        transactionId,
                        status: HOTEL_TRANSACTION_STATUS.BOOKING
                    },
                    {
                        $set: {
                            status: HOTEL_TRANSACTION_STATUS.BOOKING_UNKNOWN,
                            updatedAt: new Date(),
                            error: String(error.message || error)
                        },
                        $push: {
                            history: {
                                status: HOTEL_TRANSACTION_STATUS.BOOKING_UNKNOWN,
                                at: new Date()
                            }
                        }
                    }
                );
            } catch (dbError) {
                console.error(
                    "❌ Impossible d'enregistrer BOOKING_UNKNOWN:",
                    dbError
                );
            }
        }

        return res.status(202).json({
            success: false,
            status: "BOOKING_UNKNOWN",
            error:
                "Le résultat du BOOK doit être vérifié auprès de LiteAPI avant toute nouvelle tentative."
        });
    }
});

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

       const errorMessage =
    result.error?.description ||
    result.error?.message ||
    result.message ||
    (typeof result.error === "string" ? result.error : null) ||
    JSON.stringify(result.error || result) ||
    "Impossible de pré-réserver cette offre";

throw new Error(errorMessage);
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
                // ======================================================
// TOURIZIA — LIMITE D'AFFICHAGE À 100 OFFRES
// Le catalogue complet reste conservé côté serveur.
// ======================================================

const MAX_VISIBLE_HOTEL_OFFERS = 100;

const displayedOffers = offers.slice(
    0,
    MAX_VISIBLE_HOTEL_OFFERS
);

            console.log(
                `🏨 OFFRES REÇUES: ${offers.length}`
            );

           if (!offers.length) {
    const raw = searchResult.raw || {};

    console.error("❌ LITEAPI : AUCUNE OFFRE EXTRAITE", {
        city: data.city,
        countryCode: data.countryCode,
        checkIn: data.checkIn,
        checkOut: data.checkOut,
        adults: data.adults,
        rooms: data.rooms,
        refundableRatesOnly: true,
        responseCode: raw.code ?? null,
        responseMessage: raw.message ?? null,
        dataType: Array.isArray(raw.data)
            ? "array"
            : typeof raw.data,
        dataCount: Array.isArray(raw.data)
            ? raw.data.length
            : null
    });

    lastError = new Error(
        raw.message ||
        raw.error?.message ||
        "LiteAPI n'a retourné aucune offre exploitable pour cette recherche."
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

                    
// Les informations de base sont déjà fournies
// dans result.hotels par la recherche LiteAPI.
// On évite un appel HTTP supplémentaire par hôtel.
const hotelDetails = {};



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
    offer: {
        ...prebookOffer,
        cancellationPolicies: freshPolicies,
        refundable: freshPolicies.refundableTag || null
    },
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

// Ancien endpoint désactivé :
// le client doit sélectionner une offre avant le PREBOOK.
app.post("/api/prebook-hotel", (req, res) => {
    return res.status(410).json({
        success: false,
        error: "Cet endpoint est désactivé. Utilisez d'abord /api/select-hotel-offer, puis /api/prebook-selected-hotel."
    });
});


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
  `https://tourizia.com/resultats-hotels/?hotel_payment=success&transactionId=${encodeURIComponent(transactionId)}`,

cancel_url:
  `https://tourizia.com/resultats-hotels/?hotel_payment=cancel&transactionId=${encodeURIComponent(transactionId)}`,
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

              // 📞 Téléphone international du client
    phone: String(data.phone || "").trim(),

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
  `https://tourizia.com/resultats-hotels/?hotel_payment=success&transactionId=${encodeURIComponent(transactionId)}`,

cancel_url:
  `https://tourizia.com/resultats-hotels/?hotel_payment=cancel&transactionId=${encodeURIComponent(transactionId)}`,

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
// ----------------------------------------------------
// 🔎 VÉRIFIER LA TRANSACTION DANS MONGODB
// ----------------------------------------------------

if (!hotelTransactions) {
    console.error(
        "❌ PAYTECH : MongoDB indisponible"
    );

    return res
        .status(500)
        .send("Database unavailable");
}

const existingTransaction =
    await hotelTransactions.findOne({
        transactionId,
        type: "hotel"
    });

if (!existingTransaction) {
    console.error(
        "❌ PAYTECH : transaction hôtel introuvable:",
        transactionId
    );

    return res
        .status(400)
        .send("Hotel transaction not found");
}

console.log(
    "✅ TRANSACTION PAYTECH VÉRIFIÉE:",
    transactionId
);
// ----------------------------------------------------
// 💰 VÉRIFIER LE MONTANT PAYTECH
// ----------------------------------------------------

const expectedPersons =
    Number(existingTransaction.request?.adults || 0) +
    Number(existingTransaction.request?.children || 0);

const expectedAmount =
    HOTEL_PAYTECH_PRICE * expectedPersons;

const receivedAmount =
    Number(final_item_price ?? item_price);

if (
    expectedPersons < 1 ||
    !Number.isFinite(receivedAmount) ||
    receivedAmount !== expectedAmount
) {
    console.error("❌ PAYTECH : MONTANT INVALIDE", {
        transactionId,
        expectedAmount,
        receivedAmount
    });

    return res
        .status(400)
        .send("Invalid payment amount");
}

console.log("✅ MONTANT PAYTECH VÉRIFIÉ:", {
    transactionId,
    expectedAmount,
    receivedAmount
});

// ==================================================
// 💰 TRANSACTION → PAID
// ==================================================

// ==================================================
// 🔐 3C.5 — ANTI-DOUBLE TRAITEMENT PAYTECH
// ==================================================

const paymentUpdate = await hotelTransactions.updateOne(
    {
        transactionId,
        type: "hotel",
        status: HOTEL_TRANSACTION_STATUS.PAYMENT_PENDING
    },
    {
        $set: {
            status: HOTEL_TRANSACTION_STATUS.PAID,
            updatedAt: new Date(),

          "payment.status": "PAID",
"payment.method": hotelData.paymentMethod,
"payment.paymentId": ref_command,
"payment.paytechReference": ref_command,
"payment.amount": receivedAmount,
"payment.currency": "XOF",
"payment.paidAt": new Date()
        },

        $push: {
            history: {
                status: HOTEL_TRANSACTION_STATUS.PAID,
                at: new Date()
            }
        }
    }
);

// Une seule notification peut effectuer cette transition.
if (paymentUpdate.modifiedCount !== 1) {

    const latestTransaction =
        await hotelTransactions.findOne({
            transactionId,
            type: "hotel"
        });

    if (
       latestTransaction?.payment?.status === "PAID"
    ) {
        console.log(
            "♻️ PAYTECH : NOTIFICATION DÉJÀ TRAITÉE:",
            transactionId
        );

        return res
            .status(200)
            .send("Already processed");
    }

    console.error(
        "❌ PAYTECH : TRANSITION DE PAIEMENT REFUSÉE",
        {
            transactionId,
            currentStatus: latestTransaction?.status
        }
    );

    return res
        .status(409)
        .send("Payment transition rejected");
}

console.log(
    "✅ PAYTECH : PAIEMENT ENREGISTRÉ UNE SEULE FOIS:",
    transactionId
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
// ✅ PAIEMENT PAYTECH CONFIRMÉ
// EN ATTENTE DU CHOIX DU CLIENT
// ==================================================

console.log(
    "✅ PAYTECH — FRAIS TOURIZIA PAYÉS:",
    transactionId
);

console.log(
    "⏳ EN ATTENTE DE LA SÉLECTION D'UNE OFFRE HÔTELIÈRE"
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



function formatHotelFailureReason(reason) {
    if (typeof reason === "string") {
        return reason.trim() ||
            "Aucun détail d'erreur fourni par LiteAPI.";
    }

    if (reason instanceof Error) {
        return reason.message ||
            "Erreur technique lors de la réservation.";
    }

    if (reason && typeof reason === "object") {
        const parts = [];

        function collect(value, label = "") {
            if (typeof value === "string" && value.trim()) {
                parts.push(
                    label
                        ? `${label}: ${value.trim()}`
                        : value.trim()
                );
            } else if (typeof value === "number") {
                parts.push(label ? `${label}: ${value}` : String(value));
            } else if (Array.isArray(value)) {
                value.forEach(item => collect(item, label));
            } else if (value && typeof value === "object") {
                for (const [key, item] of Object.entries(value)) {
                    if ([
                        "message",
                        "error",
                        "description",
                        "details",
                        "code",
                        "status"
                    ].includes(key)) {
                        collect(item, key);
                    }
                }
            }
        }

        collect(reason);

        if (parts.length) {
            return [...new Set(parts)].join(" — ");
        }

        try {
            return JSON.stringify(reason);
        } catch {
            return "Erreur LiteAPI : détail impossible à lire.";
        }
    }

    return "Aucun détail d'erreur fourni par LiteAPI.";
}


// ============================================================
// 📧 PAIEMENT REÇU — RECHERCHE MANUELLE ADMIN
// ============================================================

async function sendHotelManualSearchNotification(
    data,
    reason
) {

    const readableReason = formatHotelFailureReason(reason);
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
                        🔎 Pourquoi la réservation automatique a échoué
                    </h3>

                    <p>
                        ${escapeHtml(readableReason).replace(/\n/g, "<br>")}
                    </p>

                </div>


                <p style="margin-top:25px;color:#6c7882;">
    <strong>Action requise :</strong>
    vérifier le motif technique ci-dessus, rechercher une offre
    correspondant aux dates, à la ville et au nombre de voyageurs,
    puis mettre à jour le dossier et contacter le client si nécessaire.
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
// 📧 EMAIL CLIENT — DEMANDE HÔTEL EN RECHERCHE MANUELLE
// ============================================================

async function sendHotelManualSearchCustomerEmail(data) {

    if (!resend) {
        console.error("❌ RESEND NON CONFIGURÉ");
        return null;
    }

    if (!data.email) {
        console.error("❌ EMAIL CLIENT MANQUANT");
        return null;
    }

    const guestsHtml =
        Array.isArray(data.guests) && data.guests.length
            ? data.guests.map((guest, index) => `
                <div style="padding:8px 0;border-bottom:1px solid #e5eaf0;">
                    ${index + 1}. ${escapeHtml(
                        `${guest.firstName || ""} ${guest.lastName || ""}`.trim()
                    )}
                    — ${escapeHtml(guest.type || "Voyageur")}
                </div>
            `).join("")
            : `<p>Voyageurs : ${Number(data.adults || 0) + Number(data.children || 0)}</p>`;

    const html = `
    <div style="background:#f3f6fa;padding:30px 12px;font-family:Arial,sans-serif;color:#17263d;">
        <div style="max-width:620px;margin:auto;background:#101e2c;border-radius:20px;padding:30px;color:#fff;">

            <div style="text-align:center;">
                <div style="display:inline-block;background:#174b45;color:#70d8b6;padding:15px;border-radius:50%;font-size:25px;">
                    ✓
                </div>

                <h2 style="font-size:23px;margin:18px 0 8px;">
                    Votre demande est prise en charge !
                </h2>

                <div style="display:inline-block;background:#153d37;color:#37d99a;padding:6px 12px;border-radius:20px;font-size:11px;font-weight:bold;">
                    SERVICE CLIENT TOURIZIA
                </div>
            </div>

            <h3 style="text-align:center;margin-top:28px;">
                Nous recherchons votre hébergement.
            </h3>

            <p style="color:#cbd5e1;text-align:center;line-height:1.7;">
                Votre paiement a bien été reçu. Notre équipe prend le relais
                pour rechercher un hébergement correspondant à votre demande.
            </p>

            <div style="background:#203649;border-radius:13px;padding:18px;margin-top:22px;">
                <h3 style="margin-top:0;color:#70d8b6;">Votre demande de séjour</h3>

                <p><strong>Destination :</strong> ${escapeHtml(data.city)}, ${escapeHtml(data.countryCode)}</p>

                <p><strong>Arrivée :</strong> ${escapeHtml(formatHotelDate(data.checkIn))}</p>

                <p><strong>Départ :</strong> ${escapeHtml(formatHotelDate(data.checkOut))}</p>

                <p><strong>Adultes :</strong> ${Number(data.adults || 0)}</p>

                <p><strong>Enfants :</strong> ${Number(data.children || 0)}</p>

                <p><strong>Chambres :</strong> ${Number(data.rooms || 1)}</p>

                <p><strong>Nationalité :</strong> ${escapeHtml(data.guestNationality || "")}</p>

                <div style="margin-top:15px;">
                    <strong>Voyageurs :</strong>
                    ${guestsHtml}
                </div>
            </div>

            <div style="background:#17443f;border-radius:13px;padding:18px;margin-top:18px;">
                <strong style="color:#8ce3c4;">
                    Délai de retour visé : 1 à 2 heures
                </strong>

                <p style="color:#d1e5df;line-height:1.6;margin-bottom:0;">
                    Notre équipe vous contactera par email ou téléphone
                    dès qu'un résultat correspondant à votre demande sera disponible.
                </p>
            </div>

            <p style="text-align:center;font-weight:bold;line-height:1.6;margin-top:22px;">
                Votre demande est enregistrée. Merci de votre confiance !
            </p>

            <p style="text-align:center;color:#aebdca;font-size:12px;margin-top:25px;">
                Référence de demande : ${escapeHtml(data.transactionId)}
            </p>

            <p style="text-align:center;color:#94a3b8;font-size:11px;">
                Le délai annoncé est un objectif de traitement, pas une confirmation de réservation.
            </p>

        </div>
    </div>
    `;

    try {

        const result = await resend.emails.send({
            from: "Tourizia <tickets@tourizia.com>",
            to: data.email,
            subject: "Tourizia — Votre demande d'hébergement est prise en charge",
            html
        });

        if (result.error) {
            throw new Error(result.error.message || "Erreur Resend");
        }

        console.log(
            "📧 EMAIL CLIENT RECHERCHE MANUELLE ENVOYÉ:",
            data.email
        );

        return result;

    } catch (error) {

        console.error(
            "❌ ERREUR EMAIL CLIENT TOURIZIA:",
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

// Coordonnées de l'établissement
"provider.hotelAddress":
    selectedOffer.hotelAddress || "",

"provider.hotelPhone":
    selectedOffer.hotelPhone || "",

"provider.hotelEmail":
    selectedOffer.hotelEmail || "",

"provider.hotelWebsite":
    selectedOffer.hotelWebsite || "",

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

             // 📅 POLITIQUE D'ANNULATION LITEAPI
    cancellationPolicies:
        cancellationPolicies || null,

    refundable:
        refundableTag || null,
            
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

finalBooking.confirmationNumber =
    documentResult.reference;

// Enregistrement des documents dans MongoDB
await updateHotelTransaction(data.transactionId, {

    "documents.hotelConfirmationPdfs":
        documentResult.pdfDocuments,

    "documents.confirmationNumber":
        documentResult.reference,

    "documents.generatedAt":
        new Date(),

    "documents.emailSent":
        documentResult.emailSent,

    "documents.storageStatus":
        documentResult.storageStatus,

    "documents.storageErrors":
        documentResult.storageErrors,

    "documents.emailError":
        documentResult.emailError

});

console.log(
    "✅ DOCUMENTS HÔTEL ENREGISTRÉS DANS MONGODB:",
    data.transactionId,
    "| PDF:",
    documentResult.pdfDocuments.length
);

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
    // 📊 ENVOI GOOGLE SHEETS — RÉSERVATION HÔTEL CONFIRMÉE
    // ========================================================

    const totalPersons =
        Number(finalBooking.adults || 0) +
        Number(finalBooking.children || 0);

    await sendToTouriziaDashboard({

        date: new Date().toISOString(),

        service: "hotel",

        status: "confirmed",

        reference:
            finalBooking.confirmationNumber,

        payment_id:
            finalBooking.paymentId,

        client_name:
            finalBooking.fullName,

        email:
            finalBooking.email,

        phone:
            finalBooking.phone,

        destination:
            finalBooking.city,

        hotel_name:
            finalBooking.hotelName,

        room_name:
            finalBooking.roomName,

        flight_route: "",

        check_in:
            finalBooking.checkIn,

        check_out:
            finalBooking.checkOut,

        passengers: totalPersons,

        adults:
            finalBooking.adults,

        children:
            finalBooking.children,

        amount: 15,

        currency: "USD",

        payment_method:
            finalBooking.paymentMethod,

        provider: "LiteAPI",

        booking_id:
            finalBooking.bookingId,

        confirmation_number:
            finalBooking.confirmationNumber,

        pdf_url:
            finalBooking.pdfUrl || ""

    });


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
// FORMAT DATE ANNULATION
// ============================================================

function formatCancellationDate(value) {
    if (!value) return null;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return new Intl.DateTimeFormat("fr-FR", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        timeZone: "UTC"
    }).format(date);
}

function buildCancellationPolicyText(data = {}) {
    const policies = data.cancellationPolicies;

    if (!policies || typeof policies !== "object") {
        return [
            "Conditions d'annulation",
            "Consultez les conditions confirmées par le fournisseur.",
            "Aucune date limite d'annulation n'est disponible dans les données transmises."
        ].join("\n");
    }

    const tag = String(
        policies.refundableTag || data.refundable || ""
    ).trim().toUpperCase();

    const infos = Array.isArray(policies.cancelPolicyInfos)
        ? policies.cancelPolicyInfos
        : [];

    if (["NRFN", "NRF", "NONREFUNDABLE", "NON_REFUNDABLE"].includes(tag)) {
        return [
            "Tarif non remboursable",
            "Les conditions de remboursement dépendent du tarif confirmé.",
            "Vérifiez les conditions du fournisseur avant toute demande d'annulation."
        ].join("\n");
    }

    if (infos.length === 0) {
        return [
            "Conditions d'annulation",
            "Le fournisseur n'a pas transmis de détail exploitable sur les délais et pénalités.",
            "Les conditions exactes doivent être vérifiées auprès du fournisseur."
        ].join("\n");
    }

    const lines = [
        tag === "RFN"
            ? "Tarif indiqué comme remboursable par le fournisseur"
            : "Politique d'annulation du fournisseur"
    ];

    for (const policy of infos) {
        const deadline = formatCancellationDate(policy.cancelTime);
        const amount = Number(policy.amount);
        const currency = String(policy.currency || "").trim();

        if (deadline) {
            lines.push(`Date d'application de la règle : ${deadline}`);
        } else {
            lines.push("Date limite : non disponible");
        }

        if (
            policy.amount !== null &&
            policy.amount !== undefined &&
            Number.isFinite(amount) &&
            amount >= 0
        ) {
            if (amount === 0) {
                lines.push(
    "Frais d’annulation prévus : 0 (sans frais selon cette règle)"
);
            } else {
                lines.push(
                    `Montant des frais d’annulation : ${amount.toFixed(2)} ${currency}`.trim()
                );
            }
        } else {
           lines.push("Montant des frais d’annulation : non précisé");
        }

        if (policy.cancelType) {
           lines.push(`Type de frais d’annulation : ${String(policy.cancelType)}`);
        }

        lines.push("");
    }

    lines.push(
        "Les règles ci-dessus correspondent aux données reçues du fournisseur. " +
        "Les conditions finales de la réservation confirmée prévalent."
    );

    return lines.join("\n");
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

// Adresse exacte fournie par LiteAPI / le BOOK confirmé.
// Si elle est absente, ne rien afficher : ne jamais en inventer une.
const hotelAddress = String(data.hotelAddress || "").trim();


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
       
const refundable = data.refundable || null;
const providerPriceNumber = Number(data.providerPrice);

const providerPriceLabel =
    data.providerPrice !== null &&
    data.providerPrice !== undefined &&
    data.providerPrice !== "" &&
    Number.isFinite(providerPriceNumber)
        ? `${providerPriceNumber.toLocaleString("fr-FR", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
          })} ${String(data.providerCurrency || "").trim()}`.trim()
        : "";

const cancellationPolicy =
    buildCancellationPolicyText(data);



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
${
    hotelAddressForPdf
        ? `
            <div
                style="
                    margin-top:6px;
                    font-size:13px;
                    color:#53616c;
                    line-height:1.5;
                "
            >
                <strong>Adresse exacte de l'hôtel :</strong>
                ${escapeHtml(hotelAddressForPdf)}
            </div>
          `
        : ""
}


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
        ✦ VOTRE ESPACE DE SÉJOUR
    </div>

    <div class="value" style="
        font-size:13px;
        line-height:1.5;
        color:#142238;
        font-weight:750;
    ">
        ${escapeHtml(roomName)}
    </div>

    <div style="
        margin-top:5px;
        font-size:10px;
        color:#718096;
    ">
        Catégorie de chambre communiquée par l'établissement
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

       ${
    hotelAddressForPdf
        ? `
            <div class="row">
                <div class="row-label">
                    Adresse
                </div>

                <div class="row-value">
                    ${escapeHtml(hotelAddressForPdf)}
                </div>
            </div>
          `
        : ""
}


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
    refundable || providerPriceLabel
        ? `
            <div class="section">

                <div class="section-title">
                    Conditions tarifaires
                </div>

                <div class="notice">

                    ${
                        providerPriceLabel
                            ? `
                                <div style="font-weight:700; margin-bottom:6px;">
                                    Prix total de la chambre :
                                    ${escapeHtml(providerPriceLabel)}
                                </div>
                              `
                            : ""
                    }

                    ${
                        refundable
                            ? `
                                <div>
                                    ${escapeHtml(
                                        typeof refundable === "string"
                                            ? refundable
                                            : JSON.stringify(refundable)
                                    )}
                                </div>
                              `
                            : ""
                    }

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
    reference,
    guestNumber = 1
) {
    if (!pdf) {
        throw new Error("PDF hôtel vide");
    }

    const tempPath = path.join(
        "/tmp",
        `hotel-${reference}-personne-${guestNumber}.pdf`
    );

    fs.writeFileSync(tempPath, pdf);

    try {
        const result = await cloudinary.uploader.upload(
            tempPath,
            {
                resource_type: "raw",
                type: "authenticated",
                folder: "tourizia-hotels",
                public_id: `hotel-${reference}-personne-${guestNumber}`
            }
        );

        console.log(
            "☁️ HOTEL PDF ENREGISTRÉ:",
            result.public_id
        );

        return {
            publicId: result.public_id,
            resourceType: result.resource_type,
            format: result.format || "pdf",
            guestNumber
        };

    } finally {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
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
const pdfDocuments = [];
const storageErrors = [];


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
           // Enregistrement sécurisé du PDF sur Cloudinary
try {

    const storedDocument = await uploadHotelPDF(
        pdf,
        reference,
        i + 1
    );

    pdfDocuments.push({
        ...storedDocument,
        filename: `reservation-hotel-${reference}-personne-${i + 1}.pdf`
    });

} catch (uploadError) {

    console.error(
        "❌ ERREUR STOCKAGE PDF CLOUDINARY:",
        uploadError.message
    );

    storageErrors.push({
        guestNumber: i + 1,
        message: uploadError.message
    });

}


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

   let emailSent = false;
let emailError = null;

try {

    await sendHotelEmail(
        booking,
        pdfs,
        reference
    );

    emailSent = true;

    console.log(
        "✅ EMAIL CLIENT ENVOYÉ AVEC SUCCÈS"
    );

} catch (error) {

    emailError = error.message;

    console.error(
        "❌ EMAIL CLIENT NON ENVOYÉ:",
        error
    );

}


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

const storageStatus =
    pdfDocuments.length === guests.length
        ? "COMPLETE"
        : pdfDocuments.length > 0
            ? "PARTIAL"
            : "FAILED";

return {
    reference,
    pdfDocuments,
    emailSent,
    emailError,
    storageStatus,
    storageErrors
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

           return res.status(
    result.emailSent ? 200 : 502
).json({

    success: result.emailSent,

    message: result.emailSent
        ? "PDF généré et email envoyé."
        : "PDF généré, mais l'email n'a pas été envoyé.",

    email: data.email,

    reference: result.reference,

    emailSent: result.emailSent,

    emailError: result.emailError,

    storageStatus: result.storageStatus,

    pdfCount: result.pdfDocuments?.length || 0,

    storageErrors: result.storageErrors || []

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
const GEONAMES_CACHE_TTL = 6 * 60 * 60 * 1000;

function normalizeDestinationText(value = "") {
    return String(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("fr-FR")
        .trim()
        .replace(/\s+/g, " ");
}

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

        const cacheKey = normalizeDestinationText(query);
        const cached = geoNamesCache.get(cacheKey);

        if (
            cached &&
            Date.now() - cached.timestamp < GEONAMES_CACHE_TTL
        ) {
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
        url.searchParams.set("maxRows", "30");
        url.searchParams.set("startRow", "0");
        url.searchParams.set("featureClass", "P");
        url.searchParams.set("orderby", "relevance");
        url.searchParams.set("lang", "fr");
        url.searchParams.set("username", username);

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                Accept: "application/json"
            },
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
            throw new Error(`GeoNames HTTP ${response.status}`);
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

        const normalizedQuery = normalizeDestinationText(query);
        const unique = new Map();

        for (const place of records) {
            if (
                !place.name ||
                !place.countryCode ||
                !Number.isFinite(Number(place.lat)) ||
                !Number.isFinite(Number(place.lng))
            ) {
                continue;
            }

            const destination = {
    name: String(place.name).trim(),
    country: String(place.countryName || "").trim(),
    countryCode: String(place.countryCode).toUpperCase(),
    region: String(place.adminName1 || "").trim(),
    latitude: Number(place.lat),
    longitude: Number(place.lng),
    featureCode: String(place.fcode || ""),
    geonameId: place.geonameId || null,
    population: Number(place.population || 0)
};

            const normalizedName = normalizeDestinationText(
                destination.name
            );

            // Ne conserver que les résultats liés à la saisie.
            // Cela évite, par exemple, Kingston lors d'une recherche Paris.
            if (
                !normalizedName.includes(normalizedQuery) &&
                !normalizedQuery.includes(normalizedName)
            ) {
                continue;
            }

            const key = [
                normalizedName,
                destination.countryCode,
                normalizeDestinationText(destination.region)
            ].join("|");

            if (!unique.has(key)) {
                unique.set(key, destination);
            }
        }


        const destinations = Array.from(unique.values());

        // Priorité : nom exact, ville principale, puis correspondances proches.
        destinations.sort((a, b) => {
            const nameA = normalizeDestinationText(a.name);
            const nameB = normalizeDestinationText(b.name);

            const exactA = nameA === normalizedQuery ? 0 : 1;
            const exactB = nameB === normalizedQuery ? 0 : 1;

            if (exactA !== exactB) {
                return exactA - exactB;
            }

            const capitalA = a.featureCode === "PPLC" ? 0 : 1;
            const capitalB = b.featureCode === "PPLC" ? 0 : 1;

            if (capitalA !== capitalB) {
                return capitalA - capitalB;
            }

            const startsA = nameA.startsWith(normalizedQuery) ? 0 : 1;
            const startsB = nameB.startsWith(normalizedQuery) ? 0 : 1;

            if (startsA !== startsB) {
                return startsA - startsB;
            }

            return nameA.localeCompare(nameB, "fr");
        });

        // Limiter le nombre de suggestions affichées.
        const finalDestinations = destinations.slice(0, 10);

        if (geoNamesCache.size >= 500) {
            const oldestKey = geoNamesCache.keys().next().value;
            if (oldestKey) {
                geoNamesCache.delete(oldestKey);
            }
        }

        geoNamesCache.set(cacheKey, {
            timestamp: Date.now(),
            destinations: finalDestinations
        });

        return res.json({
            success: true,
            source: "GeoNames",
            destinations: finalDestinations
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
// FIN DU ROUTEUR HÔTEL GOOGLE SHEETS
// ============================================================

async function sendToTouriziaDashboard(data) {
    const url = process.env.TOURIZIA_SHEETS_WEBHOOK_URL;

    if (!url) {
        console.warn(
            "⚠️ TOURIZIA_SHEETS_WEBHOOK_URL manquante — envoi Sheets ignoré"
        );
        return { success: false, skipped: true };
    }

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
            },
            body: JSON.stringify(data),
            redirect: "follow"
        });

        const raw = await response.text();

        console.log("📊 SHEETS HTTP STATUS:", response.status);
        console.log("📊 SHEETS FINAL URL:", response.url);
        console.log("📊 SHEETS RESPONSE:", raw.slice(0, 500));

        let result;

        try {
            result = JSON.parse(raw);
        } catch {
            throw new Error(
                "Google Sheets a renvoyé du HTML au lieu du JSON"
            );
        }

        if (!response.ok || result.success !== true) {
            throw new Error(
                "Échec Google Sheets : " + raw.slice(0, 500)
            );
        }

        console.log("✅ DASHBOARD TOURIZIA:", result);

        return result;

    } catch (error) {
        console.error(
            "❌ DASHBOARD GOOGLE SHEETS ERROR:",
            error.message
        );

        // L'échec du tableau de bord ne doit pas interrompre
        // une réservation déjà confirmée par le fournisseur.
        return {
            success: false,
            error: error.message
        };
    }
}


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