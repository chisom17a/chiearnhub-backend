import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import bodyParser from "body-parser";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ================= FIREBASE ADMIN =================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ================= XIXAPAY KEYS =================
const API_KEY = process.env.XIXI_API_KEY;
const BUSINESS_ID = process.env.XIXI_BUSINESS_ID;

// ================= INIT PAYMENT =================
app.post("/init-xixipay", async (req, res) => {
  try {
    const { amount, email, depositId, userId } = req.body;

    if (!amount || amount < 100) {
      return res.json({ success: false, message: "Minimum deposit is ₦100" });
    }

    if (!email || !depositId || !userId) {
      return res.json({ success: false, message: "Missing parameters" });
    }

    const reference = "CH_" + Date.now() + "_" + depositId;

    // Create deposit record first
    await db.collection("deposits").doc(depositId).set({
      userId,
      email,
      amount,
      method: "Xixapay",
      reference,
      status: "initiated",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Call Xixapay
    const xres = await fetch("https://api.xixapay.com/api/v1/payment/initiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "x-business-id": BUSINESS_ID
      },
      body: JSON.stringify({
        amount: amount,
        email: email,
        reference: reference,
        callback_url: "https://chiearnhub-backend.onrender.com/xixipay-webhook",
        redirect_url: "https://chiearnhub.vercel.app/deposit-success.html",
        metadata: {
          depositId: depositId
        }
      })
    });

    const data = await xres.json();

    if (!data.status) {
      console.error("Xixapay error:", data);
      return res.json({ success: false, message: "Xixapay init failed", raw: data });
    }

    // Save payment URL
    await db.collection("deposits").doc(depositId).update({
      paymentUrl: data.data.payment_url,
      status: "pending"
    });

    res.json({
      success: true,
      paymentUrl: data.data.payment_url
    });

  } catch (e) {
    console.error("Init error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ================= WEBHOOK =================
app.post("/xixipay-webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("Webhook received:", JSON.stringify(event));

    // Adjust based on Xixapay exact payload
    if (!event || event.status !== "success") {
      return res.send("ignored");
    }

    const depositId = event.metadata?.depositId;

    if (!depositId) {
      return res.send("no depositId");
    }

    const depRef = db.collection("deposits").doc(depositId);
    const depSnap = await depRef.get();

    if (!depSnap.exists) return res.send("deposit not found");

    const dep = depSnap.data();
    if (dep.status === "approved") return res.send("already processed");

    const userRef = db.collection("users").doc(dep.userId);

    await db.runTransaction(async (t) => {
      const u = await t.get(userRef);
      const currentBal = u.data().balance || 0;
      const newBal = currentBal + dep.amount;

      t.update(userRef, { balance: newBal });
      t.update(depRef, {
        status: "approved",
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.send("ok");

  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).send("error");
  }
});

// ================= HEALTH CHECK =================
app.get("/", (req, res) => {
  res.send("Chiearnhub backend running ✅");
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
