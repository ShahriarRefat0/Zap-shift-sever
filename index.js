const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");

const admin = require("firebase-admin");
const serviceAccount = require("./zap-shift-admin-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL"; // your brand code
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

//middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  //console.log("headers in the middleware", req.headers.authorization)
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

const uri = process.env.MONGO_URL;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("zap_shift_db");
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");

    //users related apis
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      console.log(email)
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        return res.send({ message: "user exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //parcels api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.senderEmail = email;
      }
      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      //parcel created time
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    //delete parcel
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    //payment related apis
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    //old
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    //payment confirm
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // console.log("session retrieve", session);
      //block getting duplicate payment success data
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);
      console.log(paymentExist);
      if (paymentExist) {
        return res.send({
          message: "already exists",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      const trackingId = generateTrackingId();
      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const updata = {
          $set: {
            paymentStatus: "paid",
            trackingId: generateTrackingId(),
          },
        };
        const result = await parcelsCollection.updateOne(query, updata);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);
          res.send({
            success: true,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            modifyParcel: result,
            paymentInfo: resultPayment,
          });
        }
      }
      res.send({ success: true });
    });


    //payment related apis
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      console.log("headers", req.headers);

      if (email) {
        query.customerEmail = email;

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    //rider related apis
    app.get('/riders', async (req, res) => {
      const query = {}
      if (req.query.status) {
        query.status = req.query.status
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray()
      res.send(result)
})

    app.post('/riders', async (req, res) => {
      const rider = req.body;
      rider.status = 'pending';
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider)
      res.send(result)
})

    app.patch('/riders/:id', verifyFBToken, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const updateDoc = {
        $set: {
          status: status
        }
      }
      const result = await ridersCollection.updateOne(query, updateDoc);
      
      if (status === 'approved') {
        const email = req.body.email;
        const userQuery = { email }
        const updateUser = {
          $set: {
            role: 'rider'
          }

        }
        const userResult = await usersCollection.updateOne(userQuery, updateUser)
      }
      res.send(result)
    })
    
    
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap shifting is shifting");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
