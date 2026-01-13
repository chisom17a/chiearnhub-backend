import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import bodyParser from "body-parser";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🔥 FIREBASE ADMIN SETUP
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 🔐 XIXIPAY KEYS
const API_KEY = process.env.XIXI_API_KEY;
const BUSINESS_ID = process.env.XIXI_BUSINESS_ID;

// ================= INIT PAYMENT =================
app.post("/init-xixipay", async (req, res) => {
  try {
    const { amount, email, depositId } = req.body;

    if (!amount || amount < 100) {
      return res.json({ success: false, message: "Minimum deposit is ₦100" });
    }

    const ref = "CH_" + Date.now() + "_" + depositId;

    const xres = await fetch("https://api.xixipay.com/init-payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + API_KEY
      },
      body: JSON.stringify({
        business_id: BUSINESS_ID,
        amount,
        email,
        reference: ref,
        callback_url: "https://chiearnhub.vercel.app/deposit-success.html",
        metadata: { depositId }
      })
    });

    const data = await xres.json();

    if (!data.status) {
      return res.json({ success: false, message: "Xixipay failed", raw: data });
    }

    await db.collection("deposits").doc(depositId).update({
      reference: ref,
      status: "pending"
    });

    res.json({ success: true, paymentUrl: data.data.payment_url });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ================= WEBHOOK =================
app.post("/xixipay-webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.status !== "success") {
      return res.send("ignored");
    }

    const depositId = event.metadata.depositId;

    const depRef = db.collection("deposits").doc(depositId);
    const depSnap = await depRef.get();

    if (!depSnap.exists) return res.send("not found");

    const dep = depSnap.data();
    if (dep.status === "approved") return res.send("already processed");

    const userRef = db.collection("users").doc(dep.userId);

    await db.runTransaction(async (t) => {
      const u = await t.get(userRef);
      const newBal = (u.data().balance || 0) + dep.amount;

      t.update(userRef, { balance: newBal });
      t.update(depRef, { status: "approved" });
    });

    res.send("ok");
  } catch (e) {
    console.error(e);
    res.status(500).send("error");
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));
