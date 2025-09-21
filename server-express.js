require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const app = express();
const port = 3000;
const GitHubStrategy = require('passport-github2').Strategy;
const LocalStrategy = require('passport-local').Strategy;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // cookie session lasts 1 day
}));
app.use(passport.initialize());
app.use(passport.session());

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
    try {
        await client.connect();
        const patientCollection = client.db("A3-Webware").collection("Patient");
        const usersCollection = client.db("A3-Webware").collection("User");
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        // Simple in-memory cache to temporarily store GitHub profiles during a session
        const userCache = {};

        // Local Strategy for username/password
        passport.use(new LocalStrategy(
            async (username, password, done) => {
                try {
                    const user = await usersCollection.findOne({ username: username });
                    if (!user) {
                        return done(null, false, { message: 'Incorrect username.' });
                    }

                    if (password !== user.password) {
                        return done(null, false, { message: 'Incorrect password.' });
                    }
                    return done(null, user);
                } catch (err) {
                    return done(err);
                }
            }
        ));
        
        // GitHub Strategy
        passport.use(new GitHubStrategy({
          clientID: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,

          callbackURL: `${process.env.ROOT_URL}/auth/github/callback` 
        }, (accessToken, refreshToken, profile, done) => {
            // After a successful GitHub login, save the full profile to our cache
            userCache[profile.id] = profile;
            return done(null, profile);
        }));

        passport.serializeUser((user, done) => {
            let userIdentifier;
            if (user.provider === 'github') {
                userIdentifier = { id: user.id, type: 'github' };
            } else { 
                userIdentifier = { id: user._id.toString(), type: 'local' };
            }
            done(null, userIdentifier);
        });

        passport.deserializeUser(async (userIdentifier, done) => {
            try {
                if (userIdentifier.type === 'github') {
                    // For GitHub users, retrieve their full profile from our temporary cache.
                    done(null, userCache[userIdentifier.id]);
                } else { // For local users, retrieve them from the database.
                    const user = await usersCollection.findOne({ _id: new ObjectId(userIdentifier.id) });
                    done(null, user);
                }
            } catch (err) {
                done(err);
            }
        });

        function isLoggedIn(req, res, next) {
            if (req.isAuthenticated()) {
                return next();
            }
            res.redirect('/');
        }
        
        app.post('/login', passport.authenticate('local', {
            successRedirect: '/dashboard',
            failureRedirect: '/?error=1'
        }));

        // REGISTER (Local Username/Password)
        app.post('/register', async (req, res, next) => {
            try {
                const { username, password } = req.body;
                const existingUser = await usersCollection.findOne({ username });
                if (existingUser) {
                    return res.status(400).send('User already exists. Please <a href="/">login</a>.');
                }
                
                const userToInsert = { username, password };
                const result = await usersCollection.insertOne(userToInsert);

                const newUserForLogin = {
                    _id: result.insertedId,
                    username: username
                };

                // Automatically log the user in after they register.
                req.logIn(newUserForLogin, (err) => {
                    if (err) { return next(err); }
                    res.redirect('/dashboard');
                });
            } catch (error) {
                next(error);
            }
        });

        // LOGIN (GitHub)
        app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
        app.get('/auth/github/callback',
            passport.authenticate('github', { failureRedirect: '/' }),
            (req, res) => {
                res.redirect('/dashboard');
            }
        );
        
        app.get('/', (req, res) => {
            if (req.isAuthenticated()) {
                res.redirect('/dashboard');
            } else {
                res.sendFile(path.join(__dirname, 'public', 'index.html'));
            }
        });

        app.get('/dashboard', isLoggedIn, (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
        });

        app.get('/logout', (req, res, next) => {
            req.logout((err) => {
                if (err) { return next(err); }
                res.redirect('/');
            });
        });

        app.get('/api/user', isLoggedIn, (req, res) => {
            res.json({
                username: req.user.username || req.user.displayName,
                provider: req.user.provider || 'local'
            });
        });

        app.get("/patient", isLoggedIn, async (req, res) => {
            const userId = req.user.provider === 'github' ? req.user.id : req.user.username;
            const docs = await patientCollection.find({ github_id: userId }).toArray();
            res.json(docs);
        });

        app.post("/patient", isLoggedIn, async (req, res) => {
            const userId = req.user.provider === 'github' ? req.user.id : req.user.username;
            const userInput = req.body;
            let weight = parseFloat(userInput.weight);
            let height = parseFloat(userInput.height);
            const { weightUnit, heightUnit } = userInput;

            if (weightUnit === "lbs") weight = (weight * 0.453592);
            if (heightUnit === "ft") height = (height * 0.3048);

            const bmi = parseFloat((weight / (height * height)).toFixed(2));
            let healthiness = "";
            if (bmi < 18.5) healthiness = "Underweight";
            else if (bmi < 25) healthiness = "Healthy Weight";
            else if (bmi < 30) healthiness = "Overweight";
            else healthiness = "Obese";

            const newEntry = {
                name: userInput.name,
                weight: parseFloat(weight.toFixed(2)),
                height: parseFloat(height.toFixed(2)),
                bmi,
                healthiness,
                github_id: userId
            };
            await patientCollection.insertOne(newEntry);
            res.status(201).json(newEntry);
        });
        
        app.delete("/patient/:id", isLoggedIn, async (req, res) => {
            const userId = req.user.provider === 'github' ? req.user.id : req.user.username;
            const patientId = req.params.id;
            
            const result = await patientCollection.deleteOne({ 
                _id: new ObjectId(patientId), 
                github_id: userId
            });
            
            if (result.deletedCount === 1) {
                res.sendStatus(204);
            } else {
                res.status(404).json({ message: "Not found or permission denied." });
            }
        });

        app.put("/patient/:id", isLoggedIn, async (req, res) => {
            const userId = req.user.provider === 'github' ? req.user.id : req.user.username;
            const patientId = req.params.id;

            const updatedData = req.body;
            const filter = { _id: new ObjectId(patientId), github_id: userId };
            const originalItem = await patientCollection.findOne(filter);

            if (!originalItem) {
                return res.status(404).json({ message: "Not found or permission denied." });
            }
            
            let updatedItem = { ...originalItem, ...updatedData };
            
            const { weight, height } = updatedItem;
            const bmi = parseFloat((weight / (height * height)).toFixed(2));
            let healthiness = "";
            if (bmi < 18.5) healthiness = "Underweight";
            else if (bmi < 25) healthiness = "Healthy Weight";
            else if (bmi < 30) healthiness = "Overweight";
            else healthiness = "Obese";

            updatedItem.bmi = bmi;
            updatedItem.healthiness = healthiness;
            
            delete updatedItem._id;
            
            await patientCollection.updateOne(filter, { $set: updatedItem });
            res.status(200).json({ ...updatedItem, _id: new ObjectId(patientId) });
        });

        app.listen(process.env.PORT || port, () => {
            console.log(`BMI Simulator server running on port ${port}`);
        });

    } catch (err) {
        console.error("Failed to connect to MongoDB and start the server.", err);
        process.exit(1);
    }
}

run().catch(console.dir);