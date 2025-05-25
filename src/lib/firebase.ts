
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getDatabase, type Database } from "firebase/database";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";

// IMPORTANT: Replace with your actual Firebase configuration
const firebaseConfig = {
  apiKey: "YOUR_API_KEY", // Replace
  authDomain: "YOUR_AUTH_DOMAIN", // Replace
  databaseURL: "https://astute-helper-451908-q3-default-rtdb.firebaseio.com/", // Keep if this is correct for you
  projectId: "YOUR_PROJECT_ID", // Replace
  storageBucket: "YOUR_STORAGE_BUCKET", // Replace
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID", // Replace
  appId: "YOUR_APP_ID" // Replace
};

// Pre-initialization check for placeholder values
if (firebaseConfig.apiKey === "YOUR_API_KEY" || 
    firebaseConfig.authDomain === "YOUR_AUTH_DOMAIN" || 
    firebaseConfig.projectId === "YOUR_PROJECT_ID" ||
    firebaseConfig.databaseURL === "YOUR_DATABASE_URL" || // Should have been replaced by specific URL already
    !firebaseConfig.databaseURL.startsWith("https://") ) {
  console.error(
    "CRITICAL FIREBASE CONFIGURATION ERROR: \n" +
    "One or more Firebase config values in 'src/lib/firebase.ts' are still placeholders (e.g., YOUR_API_KEY, YOUR_PROJECT_ID) or databaseURL is invalid. \n" +
    "Please update them with your actual Firebase project credentials from your Firebase project console. \n" +
    "The databaseURL should look like 'https://<YOUR-PROJECT-ID>.firebaseio.com' or 'https://<YOUR-PROJECT-ID>-default-rtdb.<region>.firebasedatabase.app'."
  );
  // Optionally, throw an error to halt execution if preferred for development
  // throw new Error("Firebase configuration is incomplete. Please check src/lib/firebase.ts");
}


let app: FirebaseApp;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

const db: Database = getDatabase(app);
const auth: Auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export { app, db, auth, googleProvider };
