/* eslint-disable valid-jsdoc */
/* eslint-disable max-len */
/* eslint-disable operator-linebreak */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const he = require("he");
const crypto = require("crypto");
const fetch = require("node-fetch");
const axios = require("axios");

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {Timestamp} = require("firebase-admin/firestore");

admin.initializeApp();
const db = admin.firestore();

// ===============================
// 🔐 External Service Constants
// ===============================

const BLINK_URL = "https://secure.blinkpayment.co.uk";
const BLINK_API_KEY = "a900e61ee0ccf2c256ec3ab784f257defe958398f3061ad93e75bf0192afd437";
const BLINK_SECRET_KEY = "f42dd2ed0e8bdd8273cd5516d4d3b4faf3efa13e12ee2059440754dc74f64427";

const BLINK_API_KEY_STG = "01c90464352dea8b39e58aa8c93f1f096b5cb3847ddd8553332c66d93d9ee7f0";
const BLINK_SECRET_KEY_STG = "e07f40da0f48f62c0af43b8c195ef1523e3b224dccee2fc1aac6e2987461a68a";

const WEBFLOW_TOKEN = "b68630214480363b967cadaf06a57cd3a02c23795a9100cc8d08b0e19d3e1f32";
const WEBFLOW_COLLECTION_ID = "684f775db467cc4a8e6b3b1b";

function sanitizeForBlink(str = "") {
  return he.decode(str)
      .replace(/&/g, "and")
      .replace(/'/g, "’");
}

const WEBFLOW_ORIGINS = [
  "https://love-at-first-sign.webflow.io",
  "https://www.loveatfirstsign.co.uk",
];

function applyCors(app, methods) {
  const corsConfig = cors({
    origin: WEBFLOW_ORIGINS,
    methods: [...methods, "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  });

  app.use(corsConfig);
  app.options("*", corsConfig); // 🔑 REQUIRED
}

// ===============================
// 🔹 Create / Update Event Doc
// ===============================
exports.createEventDoc = functions.https.onRequest(async (req, res) => {
  try {
    const eventData = req.body;

    if (!eventData.eventId) {
      return res.status(400).send({
        success: false,
        error: "Missing required field: eventId",
      });
    }

    const docRef = db.collection("lafs_events_2").doc(eventData.slug);
    const now = admin.firestore.Timestamp.now();

    // ===============================
    // 🧱 Create/Update Main Event Doc
    // ===============================
    await docRef.set(
        {
          eventId: eventData.eventId,
          eventName: eventData.eventName || "",
          venueName: eventData.venueName || "",
          venueCity: eventData.venueCity || "",
          venueAddress: eventData.venueAddress || "",
          eventDate: eventData.eventDate
          ? admin.firestore.Timestamp.fromDate(new Date(eventData.eventDate))
          : null,
          formattedEventDate: eventData.formattedEventDate || "",
          ages: eventData.ages || "",
          imageUrl: eventData.imageUrl || "",
          tags: eventData.tags || [],
          currency: eventData.currency || "GBP",
          ticketPerGender: {
            male: 15,
            female: 15,
          },
          ticketsSold: {
            male: 0,
            female: 0,
          },
          totalSold: 0,

          status: "draft",
          createdAt: now,
          updatedAt: now,
        },
        {merge: true},
    );

    // ===============================
    // 💰 Handle Prices Subcollection
    // ===============================
    const pricesCollection = docRef.collection("prices");

    const discountedPrice = Number(eventData.price);
    const discountPercent = 0.2; // 20% discount

    const undiscountedPrice = Math.round(
        discountedPrice / (1 - discountPercent),
    );

    // 🟩 Price 1 — Always created
    if (eventData.price) {
      await pricesCollection.doc("1").set(
          {
            price: discountedPrice,
            undiscounted_price: undiscountedPrice,
            tag: "Early Bird", // optional label
            updatedAt: now,
          },
          {merge: true},
      );
    }

    // 🟦 Price 2 — Only if provided
    if (eventData.price2) {
      await pricesCollection.doc("2").set(
          {
            price: Number(eventData.price2),
            undiscounted_price: Number(eventData.price2) * 2,
            tag: "",
            updatedAt: now,
          },
          {merge: true},
      );
    }

    return res.status(200).send({
      success: true,
      message: `Event created successfully${
        eventData.price2 ? " with 2 prices" : ""
      }`,
      eventId: eventData.eventId,
    });
  } catch (err) {
    console.error("🔥 Error creating event:", err);
    return res.status(500).send({
      success: false,
      error: err.message,
    });
  }
});

// ===============================
// 🔹 Get Event Details (with CORS + Firestore fetch)
// ===============================
const detailsApp = express();

applyCors(detailsApp, ["GET"]);

detailsApp.get("/", async (req, res) => {
  try {
    const slug = req.query.slug;

    if (!slug) {
      return res.status(400).json({success: false, error: "Missing slug"});
    }

    const eventRef = db.collection("lafs_events_2").doc(slug);
    const eventDoc = await eventRef.get();

    if (!eventDoc.exists) {
      return res.status(404).json({success: false, error: "Event not found"});
    }

    // 🔹 Get price doc dynamically
    const priceId = req.query.priceId || "1";
    const priceDoc = await eventRef.collection("prices").doc(priceId).get();
    const priceData = priceDoc.exists ? priceDoc.data() : null;


    return res.status(200).json({
      success: true,
      event: eventDoc.data(),
      price: priceData || null,
    });
  } catch (err) {
    console.error("🔥 Error fetching event details:", err);
    return res.status(500).json({success: false, error: err.message});
  }
});

// ✅ Export as Cloud Function
exports.getEventDetails = functions.https.onRequest(detailsApp);

// ===============================
// 🔹 Validate Promo Code (POST)
// ===============================
//  SAMPLE DATA:
// {
//   "code": "SUMMER20",                // redundant but useful
//   "type": "percentage",              // "percentage" or "fixed"
//   "value": 20,                       // 20% OR 5.00 (if fixed currency)
//   "appliesTo": "all",                // "all" OR "selected"
//   "events": ["beach-party-2025"],    // only present if appliesTo == "selected"
//   "active": true,
//   "startAt": null,
//   "endAt": null,
//   "maxUses": null,                   // total uses limit (null = unlimited)
//   "uses": 0,                          // maintain (atomic increment)
//   "perUserLimit": 1,                  // optional limit per user/email
//   "createdAt": <timestamp>
// }
// ===============================
const promoApp = express();

applyCors(promoApp, ["POST"]);
promoApp.use(express.json());

promoApp.post("/", async (req, res) => {
  try {
    const {code, slug, quantity = 1, amountPerUnit} = req.body || {};
    if (!code || !amountPerUnit) {
      return res.status(400).json({
        success: false,
        error: "This code is invalid.",
      });
    }

    const upperCode = String(code).trim().toUpperCase();
    const promoRef = db.collection("lafs_promo_codes").doc(upperCode);
    const promoSnap = await promoRef.get();

    if (!promoSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "This code is invalid.",
      });
    }

    const promo = promoSnap.data();
    const now = admin.firestore.Timestamp.now();

    // 🔹 Validation (all unified errors)
    if (
      !promo.active ||
      (promo.startAt && now.toMillis() < promo.startAt.toMillis()) ||
      (promo.endAt && now.toMillis() > promo.endAt.toMillis()) ||
      (promo.appliesTo === "selected" &&
        (!Array.isArray(promo.events) || !promo.events.includes(slug))) ||
      (promo.maxUses && promo.uses >= promo.maxUses)
    ) {
      return res.status(400).json({
        success: false,
        error: "This code is invalid.",
      });
    }


    // 🔹 Calculate discount
    const qty = Math.max(1, Number(quantity));
    const unit = Number(amountPerUnit);
    if (isNaN(unit)) {
      return res.status(400).json({
        success: false,
        error: "This code is invalid.",
      });
    }

    let discountPerUnit = 0;
    if (promo.type === "percentage") {
      discountPerUnit = (promo.value / 100) * unit;
    } else if (promo.type === "fixed") {
      discountPerUnit = Number(promo.value);
    }

    if (discountPerUnit > unit) discountPerUnit = unit;

    const totalDiscount = discountPerUnit * qty;
    const discountedUnitPrice = Math.max(0, unit - discountPerUnit);
    const discountedTotalPrice = Math.max(
        0,
        discountedUnitPrice * qty,
    );

    return res.status(200).json({
      success: true,
      promo: {
        code: upperCode,
        type: promo.type,
        value: promo.value,
        tag: promo.tag || "",
      },
      discount: {
        discountPerUnit,
        totalDiscount,
        discountedUnitPrice,
        discountedTotalPrice,
      },
    });
  } catch (err) {
    console.error("🔥 Error validating promo:", err);
    return res.status(400).json({
      success: false,
      error: "This code is invalid.",
    });
  }
});

exports.validatePromo = functions.https.onRequest(promoApp);

// ===============================
// 🔹 Import ALL Webflow CMS Items + Prices + Status Mapping
// ===============================

// ===============================
// 🔹 Shared Helpers
// ===============================

/**
 * Returns a date range (start, end) for a given day offset in Europe/London timezone
 * @param {number} offsetDays e.g. -1 for yesterday, +7 for a week from now
 */
function getLondonDayRange(offsetDays = 0) {
  const now = new Date();
  const londonNow = new Date(now.toLocaleString("en-US", {timeZone: "Europe/London"}));
  londonNow.setDate(londonNow.getDate() + offsetDays);
  londonNow.setHours(0, 0, 0, 0);
  const start = londonNow;
  const end = new Date(londonNow);
  end.setHours(23, 59, 59, 999);
  return {start, end};
}

// ===============================
// 🕐 1️⃣ UNPUBLISH PAST EVENTS (Yesterday)
// ===============================
exports.unpublishPastEvents = onSchedule(
    {
      schedule: "1 0 * * *", // every day 12:01 AM UK
      timeZone: "Europe/London",
    },
    async () => {
      const {start, end} = getLondonDayRange(-1);

      console.log("🕐 End window (UK):", start, "→", end);

      const webflowHeaders = {
        "Authorization": `Bearer ${WEBFLOW_TOKEN}`,
        "Content-Type": "application/json",
      };

      try {
        const snapshot = await db
            .collection("lafs_events_2")
            .where("eventDate", ">=", Timestamp.fromDate(start))
            .where("eventDate", "<=", Timestamp.fromDate(end))
            .get();

        if (snapshot.empty) {
          console.log("✅ No events to end.");
          return null;
        }

        console.log(`📦 Found ${snapshot.size} events to end.`);

        const webflowItemIdsToPublish = [];

        for (const doc of snapshot.docs) {
          const data = doc.data();
          const eventId = data.eventId;

          if (!eventId) {
            console.warn(`⚠️ Skipping ${doc.id} — no eventId found.`);
            continue;
          }

          try {
          // 🔸 Update Webflow CMS field
            await axios.patch(
                `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/${eventId}`,
                {
                  fieldData: {
                    status: "Ended",
                  },
                },
                {headers: webflowHeaders},
            );

            console.log(`🟦 Webflow item updated: ${eventId}`);

            webflowItemIdsToPublish.push(eventId);

            // 🔸 Update Firestore
            await doc.ref.update({
              status: "ended",
              updatedAt: Timestamp.now(),
            });

            console.log(`🗂️ Firestore updated: ${doc.id}`);
          } catch (err) {
            console.error(
                `❌ Failed processing ${eventId}:`,
                err.response.data || err.message,
            );
          }
        }

        // 🔸 Batch publish Webflow items
        if (webflowItemIdsToPublish.length > 0) {
          await axios.post(
              `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/publish`,
              {
                itemIds: webflowItemIdsToPublish,
              },
              {headers: webflowHeaders},
          );

          console.log(
              `🚀 Published ${webflowItemIdsToPublish.length} Webflow items`,
          );
        }

        console.log("✅ Event end task complete.");
      } catch (err) {
        console.error("🔥 Error in unpublishPastEvents:", err);
      }

      return null;
    },
);


// ===============================
// 💰 2️⃣ REMOVE EARLY BIRD PRICING (Events 7 days from now)
// ===============================
exports.removeEarlyBirdPricing = onSchedule(
    {
      schedule: "5 0 * * *", // every day 12:05 AM UK (after unpublish runs)
      timeZone: "Europe/London",
    },
    async () => {
      const {start, end} = getLondonDayRange(6);

      console.log("🕐 Early Bird removal window (UK):", start, "→", end);

      try {
        const snapshot = await db
            .collection("lafs_events_2")
            .where("eventDate", ">=", Timestamp.fromDate(start))
            .where("eventDate", "<=", Timestamp.fromDate(end))
            .get();

        if (snapshot.empty) {
          console.log("✅ No events 1 week from now. Nothing to update.");
          return null;
        }

        console.log(`🎫 Found ${snapshot.size} events to remove Early Bird.`);

        for (const doc of snapshot.docs) {
          const data = doc.data();
          const eventId = data.eventId;
          const slug = doc.id;

          if (!eventId) {
            console.warn(`⚠️ Skipping ${doc.id} — no eventId found.`);
            continue;
          }

          // 🔹 Check if the event has a valid Early Bird tag before updating
          const priceDocRef = doc.ref.collection("prices").doc("1");
          const priceDoc = await priceDocRef.get();

          if (!priceDoc.exists) {
            console.warn(`⚠️ Skipping ${slug} — prices/1 document not found.`);
            continue;
          }

          // const priceData = priceDoc.data();
          // const tag = (priceData && priceData.tag) ? priceData.tag : "";

          // if (tag.trim() === "") {
          //   console.log(`⏭️ Skipping ${slug} — no Early Bird tag found.`);
          //   continue;
          // }

          // 🔹 Firestore: update prices/1
          try {
            await doc.ref
                .collection("prices")
                .doc("1")
                .set(
                    {
                      price: 25,
                      tag: "",
                      updatedAt: Timestamp.now(),
                    },
                    {merge: true},
                );

            console.log(`💾 Firestore Early Bird removed for: ${slug}`);
          } catch (err) {
            console.error(`❌ Firestore update failed for ${slug}:`, err.message);
          }

          // 🔹 Webflow: update Price field
          try {
            const url = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/${eventId}/live`;
            const body = {
              fieldData: {
                price: "£25.00", // change to 25 if your CMS price field is numeric
              },
            };

            await axios.patch(url, body, {
              headers: {
                "Authorization": `Bearer ${WEBFLOW_TOKEN}`,
                "Content-Type": "application/json",
              },
            });

            console.log(`💷 Webflow price updated to £25.00 for: ${eventId}`);
          } catch (err) {
            console.error(
                `❌ Webflow price update failed for ${eventId}:`,
                err.response.data || err.message,
            );
          }
        }

        console.log("✅ Early Bird removal complete.");
      } catch (err) {
        console.error("🔥 Error in removeEarlyBirdPricing:", err);
      }

      return null;
    },
);

// ===============================
// 🎟️ Create Booking Draft
// ===============================

const bookingDraftApp = express();

applyCors(bookingDraftApp, ["POST"]);
bookingDraftApp.use(express.json());

bookingDraftApp.post("/", async (req, res) => {
  try {
    const {
      orderId,
      eventData = {},
      purchaseData = {},
      userDetails = {},
      paymentProvider = "blink-paylink",
    } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: "Missing orderId",
      });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    const bookingDraftRef = db
        .collection("lafs_booking_drafts")
        .doc(orderId);

    await bookingDraftRef.set(
        {
          status: "draft",
          paymentProvider,

          eventData: {
            eventCity: eventData.eventCity || "",
            eventDate: eventData.eventDate || "",
            eventId: eventData.eventId || "",
            eventName: eventData.eventName || "",
            slug: eventData.slug || "",
            venueAddress: eventData.venueAddress || "",
            venueName: eventData.venueName || "",
          },

          purchaseData: {
            amount: Number(purchaseData.amount || 0),
            currency: purchaseData.currency || "GBP",
            priceId: purchaseData.priceId || "",
            promoCode: purchaseData.promoCode || "N/A",
            quantity: Number(purchaseData.quantity || 1),
            hearAbout: purchaseData.hearAbout || "",
          },

          userDetails: {
            name: userDetails.name || "",
            email: userDetails.email || "",
            phone: userDetails.phone || "",
            gender: userDetails.gender || "",
          },

          // Payment lifecycle fields (empty for now)
          // paymentIntentId: null,
          // transactionId: null,
          // paidAt: null,

          createdAt: now,
          updatedAt: now,
        },
        {merge: true}, // 🔐 safe re-entry
    );

    return res.status(200).json({
      success: true,
      orderId,
    });
  } catch (err) {
    console.error("🔥 createBookingDraft error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
// ✅ Export Cloud Function
exports.createBookingDraft = functions.https.onRequest(bookingDraftApp);

// ===============================
// 🔹 Create Blink Paylink STAGING
// ===============================
const blinkPaylinkAppStg = express();

applyCors(blinkPaylinkAppStg, ["POST"]);
blinkPaylinkAppStg.use(express.json());

blinkPaylinkAppStg.post("/", async (req, res) => {
  try {
    const {orderId} = req.body || {};
    if (!orderId) {
      return res.status(400).json({error: "Missing orderId"});
    }

    // 🔹 Load booking draft
    const draftRef = db.collection("lafs_booking_drafts").doc(orderId);
    const draftSnap = await draftRef.get();

    if (!draftSnap.exists) {
      return res.status(404).json({error: "Booking draft not found"});
    }

    const draft = draftSnap.data();

    // Get access token
    const tokenResp = await fetch(BLINK_URL + "/api/pay/v1/tokens", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BLINK_SECRET_KEY_STG}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "api_key": BLINK_API_KEY_STG,
        "secret_key": BLINK_SECRET_KEY_STG,
        "send_blink_receipt": true,
        "address_postcode_required": true,
        "enable_moto_payments": true,
        "application_name": "Love at First Sign",
        "source_site": "https://www.loveatfirstsign.co.uk/",
      }),
    });

    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error("❌ Blink create access token failed:", tokenData);
      return res.status(tokenResp.status).json({error: tokenData.message || "Blink error", details: tokenData});
    }

    const accessToken = tokenData.access_token;

    const merchantData = {
      orderId,
    };

    // 🔹 Create Blink Paylink
    const blinkResp = await fetch(
        BLINK_URL + "/api/paylink/v1/paylinks",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            payment_method: [
              "credit-card",
              "open-banking",
            ],
            transaction_type: "SALE",
            full_name: draft.userDetails.name || "",
            email: draft.userDetails.email || "",
            mobile_number: draft.userDetails.phone || "",
            currency: draft.purchaseData.currency || "GBP",
            is_decide_amount: false,
            amount: Number(draft.purchaseData.amount),
            transaction_unique: `${sanitizeForBlink(draft.eventData.eventName)} Ticket`,
            merchant_data: JSON.stringify(merchantData),
            redirect_url: "https://love-at-first-sign.webflow.io/success",
            notification_url:
            "https://love-at-first-sign.webflow.io/success",
          }),
        },
    );

    const data = await blinkResp.json();

    if (!blinkResp.ok) {
      console.error("❌ Blink paylink error:", data);
      return res.status(400).json({
        error: data.message || "Blink error",
        details: data,
      });
    }

    // 🔹 Persist paylink info to draft
    await draftRef.update({
      paymentIntentId: data.id,
      paymentUrl: data.paylink_url,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      url: data.paylink_url, // 👈 redirect user here
    });
  } catch (err) {
    console.error("🔥 createBlinkPaylink error:", err);
    return res.status(500).json({error: err.message});
  }
});

// ✅ Export Cloud Function
exports.createBlinkPaylinkStg = functions.https.onRequest(blinkPaylinkAppStg);

// ===============================
// 🔹 Create Blink Paylink
// ===============================
const blinkPaylinkApp = express();

applyCors(blinkPaylinkApp, ["POST"]);
blinkPaylinkApp.use(express.json());

blinkPaylinkApp.post("/", async (req, res) => {
  try {
    const {orderId} = req.body || {};
    if (!orderId) {
      return res.status(400).json({error: "Missing orderId"});
    }

    // 🔹 Load booking draft
    const draftRef = db.collection("lafs_booking_drafts").doc(orderId);
    const draftSnap = await draftRef.get();

    if (!draftSnap.exists) {
      return res.status(404).json({error: "Booking draft not found"});
    }

    const draft = draftSnap.data();

    // Get access token
    const tokenResp = await fetch(BLINK_URL + "/api/pay/v1/tokens", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BLINK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "api_key": BLINK_API_KEY,
        "secret_key": BLINK_SECRET_KEY,
        "send_blink_receipt": true,
        "address_postcode_required": true,
        "enable_moto_payments": true,
        "application_name": "Love at First Sign",
        "source_site": "https://www.loveatfirstsign.co.uk/",
      }),
    });

    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error("❌ Blink create access token failed:", tokenData);
      return res.status(tokenResp.status).json({error: tokenData.message || "Blink error", details: tokenData});
    }

    const accessToken = tokenData.access_token;

    const merchantData = {
      orderId,
    };

    // 🔹 Create Blink Paylink
    const blinkResp = await fetch(
        BLINK_URL + "/api/paylink/v1/paylinks",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            payment_method: [
              "credit-card",
              "open-banking",
            ],
            transaction_type: "SALE",
            full_name: draft.userDetails.name || "",
            email: draft.userDetails.email || "",
            mobile_number: draft.userDetails.phone || "",
            currency: draft.purchaseData.currency || "GBP",
            is_decide_amount: false,
            amount: Number(draft.purchaseData.amount),
            transaction_unique: `${sanitizeForBlink(draft.eventData.eventName)} Ticket`,
            merchant_data: JSON.stringify(merchantData),
            redirect_url: "https://www.loveatfirstsign.co.uk/success",
            notification_url:
            "https://blinkwebhook-xmismu3jga-uc.a.run.app",
          }),
        },
    );

    const data = await blinkResp.json();

    if (!blinkResp.ok) {
      console.error("❌ Blink paylink error:", data);
      return res.status(400).json({
        error: data.message || "Blink error",
        details: data,
      });
    }

    // 🔹 Persist paylink info to draft
    await draftRef.update({
      paymentIntentId: data.id,
      paymentUrl: data.paylink_url,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      url: data.paylink_url, // 👈 redirect user here
    });
  } catch (err) {
    console.error("🔥 createBlinkPaylink error:", err);
    return res.status(500).json({error: err.message});
  }
});

// ✅ Export Cloud Function
exports.createBlinkPaylink = functions.https.onRequest(blinkPaylinkApp);

// ===============================
// 🔔 Blink Webhook (Paylink – Draft Source of Truth)
// ===============================
exports.blinkWebhook = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const payload = req.body || {};
    console.log("📥 Blink webhook received:", JSON.stringify(payload, null, 2));

    const {
      status,
      transaction_id: transactionId,
      paylink_id: paylinkId,
      // amount,
      // currency,
      // email,
    } = payload;

    // Only process successful payments
    if (status !== "Paid") {
      console.log("ℹ️ Payment not Paid, ignoring:", status);
      return res.status(200).send("OK");
    }

    if (!paylinkId) {
      console.warn("⚠️ Missing paylinkId");
      return res.status(200).send("OK");
    }

    // Get access token
    const tokenResp = await fetch(BLINK_URL + "/api/pay/v1/tokens", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BLINK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "api_key": BLINK_API_KEY,
        "secret_key": BLINK_SECRET_KEY,
        "send_blink_receipt": true,
        "address_postcode_required": true,
        "enable_moto_payments": true,
        "application_name": "Love at First Sign",
        "source_site": "https://www.loveatfirstsign.co.uk/",
      }),
    });

    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error("❌ Blink create access token failed:", tokenData);
      return res.status(tokenResp.status).json({error: tokenData.message || "Blink error", details: tokenData});
    }

    const accessToken = tokenData.access_token;

    // 🔹 Create Blink Paylink
    const paylinkResp = await fetch(
        `${BLINK_URL}/api/paylink/v1/paylinks/${paylinkId}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
    );

    const paylinkDetails = await paylinkResp.json();
    console.log("ℹ️ paylinkDetails:", paylinkDetails);

    if (!paylinkResp.ok) {
      console.error("❌ Failed to fetch paylink:", paylinkDetails);
      return res.status(200).send("OK"); // prevent webhook retries
    }

    const rawMerchantData = paylinkDetails.merchant_data;

    let merchantData = null;

    if (typeof rawMerchantData === "string") {
      // Blink returned stringified JSON
      try {
        merchantData = JSON.parse(rawMerchantData);
      } catch (err) {
        console.error("❌ Failed to parse merchant_data string:", rawMerchantData);
      }
    } else if (typeof rawMerchantData === "object" && rawMerchantData !== null) {
      // Blink returned an object
      merchantData = rawMerchantData;
    } else {
      console.warn("⚠️ merchant_data missing or invalid", rawMerchantData);
    }

    const orderId = merchantData.orderId;
    if (!orderId) {
      console.error("❌ orderId missing in merchant_data");
      return res.status(200).send("OK");
    }

    const draftRef = db.collection("lafs_booking_drafts").doc(orderId);

    let draftData = null;

    // ======================================================
    // 🔒 IDEMPOTENCY + FETCH DRAFT (ATOMIC)
    // ======================================================
    const alreadyProcessed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(draftRef);

      if (!snap.exists) {
        console.warn("⚠️ Draft not found:", orderId);
        return true;
      }

      const draft = snap.data();
      draftData = draft;

      // 🚫 Already paid
      if (draft.status === "paid") {
        return true;
      }

      // ✅ First successful webhook
      tx.update(draftRef, {
        status: "paid",
        transactionId: transactionId || null,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return false;
    });

    if (alreadyProcessed) {
      console.log("⚠️ Duplicate or invalid webhook:", orderId);
      return res.status(200).send("OK");
    }

    console.log("✅ Draft locked & marked as PAID:", orderId);

    // ======================================================
    // 📦 EXTRACT DATA FROM DRAFT
    // ======================================================
    const {
      eventData = {},
      purchaseData = {},
      userDetails = {},
    } = draftData;

    const {
      slug = "",
      eventId = "",
      eventDate = "",
      venueName = "",
      venueAddress = "",
      eventCity = "",
    } = eventData;

    const {
      priceId = "",
      quantity = 1,
      promoCode = "",
      amount = 0,
    } = purchaseData;

    const {
      name = "",
      email = "",
      phone = "",
      gender = "",
    } = userDetails;

    // ======================================================
    // 💾 SAVE TO lafs_bookings
    // ======================================================
    await db.collection("lafs_bookings").doc(orderId).set({
      eventData,
      purchaseData: {
        ...purchaseData,
        orderId,
        paymentChannel: "blink",
      },
      userDetails: {
        name,
        email,
        phone,
        gender,
      },
      transactionId: transactionId || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("🔥 Booking saved:", orderId);

    // ======================================================
    // 📨 NOTIFY MAKE.COM (STRICT SCHEMA)
    // ======================================================
    try {
      await fetch("https://hook.eu2.make.com/sk87zd5qeekdh6580bgqffjgwo3s625f", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          type: "blink_payment_success",
          orderId,
          amount,
          email,
          metadata: {
            email,
            slug,
            gender,
            name,
            eventId,
            eventDate,
            phone,
            venueName,
            venueAddress,
            eventCity,
          },
        }),
      });

      console.log("📨 Sent data to Make.com");
    } catch (err) {
      console.error("❌ Failed to send to Make.com:", err);
    }

    // ======================================================
    // 🎟️ UPDATE EVENT TICKET COUNTERS
    // ======================================================
    const eventRef = db.collection("lafs_events_2").doc(slug);

    let totalSold = quantity;
    if (priceId === "2") {
      totalSold = quantity * 2;
    }

    const genderField =
      gender.toLowerCase() === "male"
        ? "ticketsSold.male"
        : "ticketsSold.female";

    await eventRef.update({
      totalSold: admin.firestore.FieldValue.increment(totalSold),
      [genderField]: admin.firestore.FieldValue.increment(totalSold),
    });

    console.log("🔥 Ticket counters updated");

    // ======================================================
    // 🟥 UPDATE WEBFLOW CMS (SOLD OUT / LAST FEW REMAINING)
    // ======================================================
    try {
      const webflowHeaders = {
        "Authorization": `Bearer ${WEBFLOW_TOKEN}`,
        "Content-Type": "application/json",
      };

      const eventSnap = await eventRef.get();

      if (!eventSnap.exists) {
        console.warn("⚠️ Event doc missing, cannot check ticket status");
      } else {
        const latest = eventSnap.data();

        const maleRemaining =
          ((latest.ticketPerGender && latest.ticketPerGender.male) || 0) -
          ((latest.ticketsSold && latest.ticketsSold.male) || 0);

        const femaleRemaining =
          ((latest.ticketPerGender && latest.ticketPerGender.female) || 0) -
          ((latest.ticketsSold && latest.ticketsSold.female) || 0);

        console.log("🎟️ Remaining:", {maleRemaining, femaleRemaining});

        const webflowItemId = latest.eventId;
        if (!webflowItemId) {
          console.warn("⚠️ Missing eventId (Webflow item ID)");
          return;
        }

        let fieldData = {};

        const genderLower = (gender || "").toLowerCase();

        // ======================================================
        // 👨 MALE STATUS
        // ======================================================
        if (genderLower === "male") {
          if (maleRemaining <= 0) {
            console.log("🟥 Male SOLD OUT");

            fieldData = {
              maleicontext: "SOLD OUT!",
              maletextcolor: "#fc0202",
            };
          } else if (maleRemaining <= 3) {
            console.log("🟥 Male LAST FEW REMAINING");

            fieldData = {
              maleicontext: "Last Few Remaining!",
              maletextcolor: "#fc0202",
            };
          }
        }

        // ======================================================
        // 👩 FEMALE STATUS
        // ======================================================
        if (genderLower === "female") {
          if (femaleRemaining <= 0) {
            console.log("🟥 Female SOLD OUT");

            fieldData = {
              femaleicontext: "SOLD OUT!",
              femaletextcolor: "#fc0202",
            };
          } else if (femaleRemaining <= 3) {
            console.log("🟥 Female LAST FEW REMAINING");

            fieldData = {
              femaleicontext: "Last Few Remaining!",
              femaletextcolor: "#fc0202",
            };
          }
        }

        // 🚫 Nothing to update
        if (Object.keys(fieldData).length === 0) {
          console.log("ℹ️ Ticket level normal — skipping Webflow update");
          return;
        }

        // 1️⃣ PATCH CMS
        await axios.patch(
            `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/${webflowItemId}`,
            {fieldData},
            {headers: webflowHeaders},
        );

        console.log("🟦 Webflow CMS updated:", fieldData);

        // 2️⃣ Publish item
        await axios.post(
            `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/publish`,
            {itemIds: [webflowItemId]},
            {headers: webflowHeaders},
        );

        console.log("🚀 Webflow item published");
      }
    } catch (err) {
      console.error(
          "❌ Webflow ticket status update failed:",
          err.response.data || err.message,
      );
    }

    // ======================================================
    // 🎟️ PROMO CODE USAGE TRACKING
    // ======================================================
    if (promoCode && promoCode !== "N/A") {
      const promoRef = db.collection("lafs_promo_codes").doc(promoCode);
      const claimRef = promoRef.collection("claims").doc(orderId);

      await db.runTransaction(async (tx) => {
        const claimSnap = await tx.get(claimRef);
        if (claimSnap.exists) return;

        tx.set(claimRef, {
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          eventId,
          slug,
          purchaseData,
        });

        tx.set(
            promoRef,
            {
              uses: admin.firestore.FieldValue.increment(quantity),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            {merge: true},
        );
      });

      console.log(`🎟️ Promo ${promoCode} incremented by ${quantity}`);
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Blink webhook error:", err);
    return res.status(500).send("Webhook Error");
  }
});

// ===============================
// 🔹 Join Event Waitlist (Per Gender)
// ===============================
const waitlistApp = express();

applyCors(waitlistApp, ["POST"]);
waitlistApp.use(express.json());

waitlistApp.post("/", async (req, res) => {
  try {
    const {
      slug,
      name,
      email,
      phone,
      gender,
      quantity = 1,
    } = req.body || {};

    if (!slug || !name || !email || !gender) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    const normalizedGender = gender.toLowerCase();
    if (!["male", "female"].includes(normalizedGender)) {
      return res.status(400).json({
        success: false,
        error: "Invalid gender",
      });
    }

    const eventRef = db.collection("lafs_events_2").doc(slug);

    const result = await db.runTransaction(async (tx) => {
      const eventSnap = await tx.get(eventRef);

      if (!eventSnap.exists) {
        throw new Error("Event not found");
      }

      const eventData = eventSnap.data();
      const waitlistCount = eventData.waitlistCount || {};
      const currentCount = Number(waitlistCount[normalizedGender] || 0);

      const nextSpot = currentCount + 1;

      // 🔢 Save waitlist entry under gender
      const waitlistRef = eventRef
          .collection("waitlist")
          .doc(normalizedGender)
          .collection("spots")
          .doc(String(nextSpot));

      tx.set(waitlistRef, {
        spot: nextSpot,
        name,
        email,
        phone: phone || "",
        gender: normalizedGender,
        quantity: Number(quantity) || 1,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 🔼 Increment gender-specific waitlist count
      tx.set(
          eventRef,
          {
            waitlistCount: {
              [normalizedGender]: nextSpot,
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          {merge: true},
      );

      return {spot: nextSpot};
    });

    return res.status(200).json({
      success: true,
      gender: normalizedGender,
      spot: result.spot,
    });
  } catch (err) {
    console.error("🔥 Join waitlist error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ✅ Export Cloud Function
exports.joinWaitlist = functions.https.onRequest(waitlistApp);

// ===============================
// 🔹 Create Blink Intent (Blink API)
// ===============================
const blinkIntentApp = express();

applyCors(blinkIntentApp, ["POST"]);
blinkIntentApp.use(express.json());

const RETURN_URL = "https://www.loveatfirstsign.co.uk/success"; // after payment completes
const NOTIFY_URL = "https://www.loveatfirstsign.co.uk/success"; // your webhook endpoint

blinkIntentApp.post("/", async (req, res) => {
  try {
    const {slug, purchaseData = {}, bookingData = {}} = req.body || {};
    if (!slug) return res.status(400).json({error: "Missing slug"});

    // Fetch eventId (same as your Stripe code)
    const eventDoc = await db.collection("lafs_events_2").doc(slug).get();
    if (!eventDoc.exists) return res.status(404).json({error: "Event not found in Firestore"});
    const eventId = eventDoc.data().eventId || "";

    // Amount must be DECIMAL (e.g., 25.00), not pence
    let {totalPrice} = purchaseData;
    if (typeof totalPrice === "string") totalPrice = parseFloat(totalPrice);
    if (isNaN(totalPrice)) return res.status(400).json({error: "Invalid totalPrice value"});

    // Optional prefill fields
    const {
      name = "", email = "", // etc if you want to map more
    } = bookingData;

    // Get access token
    const tokenResp = await fetch(BLINK_URL + "/api/pay/v1/tokens", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BLINK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "api_key": BLINK_API_KEY,
        "secret_key": BLINK_SECRET_KEY,
        "send_blink_receipt": true,
        "address_postcode_required": true,
        "enable_moto_payments": true,
        "application_name": "Love at First Sign",
        "source_site": "https://www.loveatfirstsign.co.uk/",
      }),
    });

    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error("❌ Blink create access token failed:", tokenData);
      return res.status(resp.status).json({error: tokenData.message || "Blink error", details: tokenData});
    }

    const accessToken = tokenData.access_token;

    // 🧾 Create Intent (credit card with wallets)
    const resp = await fetch(BLINK_URL + "/api/pay/v1/intents", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transaction_type: "SALE",
        payment_type: "credit-card",
        amount: Number(totalPrice), // e.g. 25.00
        currency: "GBP",
        return_url: RETURN_URL,
        notification_url: NOTIFY_URL,
        card_layout: "multi-line", // optional: basic | single-line | multi-line
        customer_name: name || "",
        customer_email: email || "",
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error("❌ Blink create intent failed:", data);
      return res.status(resp.status).json({error: data.message || "Blink error", details: data});
    }

    // data.element contains ccElement, gpElement, apElement
    const id = data && data.id;
    const element = (data && data.element) || {};

    return res.json({
      intentId: id,
      elements: {
        card: element.ccElement || "",
        googlePay: element.gpElement || "",
        applePay: element.apElement || "",
      },
      meta: {
        slug,
        eventId,
        totalPrice,
      },
    });
  } catch (err) {
    console.error("🔥 Blink intent error:", err);
    return res.status(500).json({error: err.message});
  }
});

exports.createBlinkIntent = functions.https.onRequest(blinkIntentApp);

// ===============================
// 🔹 Create Booking Session
// ===============================
const createSessionApp = express();

applyCors(createSessionApp, ["POST"]);
createSessionApp.use(express.json());

createSessionApp.post("/", async (req, res) => {
  try {
    const {slug} = req.body;
    if (!slug) return res.status(400).json({error: "Missing slug"});

    const bookingSessionId = crypto.randomUUID();

    await db
        .collection("blink_booking_sessions")
        .doc(bookingSessionId)
        .set({
          slug,
          status: "draft",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

    return res.json({bookingSessionId});
  } catch (err) {
    console.error("🔥 Create session failed:", err);
    return res.status(500).json({error: err.message});
  }
});

exports.createBookingSession = functions.https.onRequest(createSessionApp);

// ===============================
// 🔹 Save Booking Draft (Popup Autosave)
// ===============================
const saveBookingApp = express();

applyCors(saveBookingApp, ["POST"]);
saveBookingApp.use(express.json());

saveBookingApp.post("/", async (req, res) => {
  try {
    const {
      bookingSessionId,
      gender,
      dob,
      hearAbout,
      name,
      email,
      phone,
    } = req.body || {};

    if (!bookingSessionId) {
      return res.status(400).json({error: "Missing bookingSessionId"});
    }

    const ref = db
        .collection("blink_booking_sessions")
        .doc(bookingSessionId);

    // Optional: verify session exists
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({error: "Booking session not found"});
    }

    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (gender !== undefined) updates["userDetails.gender"] = gender;
    if (dob !== undefined) updates["userDetails.dob"] = dob;
    if (hearAbout !== undefined) updates["userDetails.hearAbout"] = hearAbout;
    if (name !== undefined) updates["userDetails.name"] = name;
    if (email !== undefined) updates["userDetails.email"] = email;
    if (phone !== undefined) updates["userDetails.phone"] = phone;

    await ref.update(updates);

    return res.json({success: true});
  } catch (err) {
    console.error("🔥 Save booking draft failed:", err);
    return res.status(500).json({error: err.message});
  }
});

exports.saveBookingDraft = functions.https.onRequest(saveBookingApp);
