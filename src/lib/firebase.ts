
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getDatabase, type Database } from "firebase/database";

// IMPORTANT: Replace with your actual Firebase configuration
const firebaseConfig = {
  apiKey: "YOUR_API_KEY", // Replace
  authDomain: "YOUR_AUTH_DOMAIN", // Replace
  databaseURL: "YOUR_DATABASE_URL", // Replace - This is crucial for Realtime Database
  projectId: "YOUR_PROJECT_ID", // Replace
  storageBucket: "YOUR_STORAGE_BUCKET", // Replace
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID", // Replace
  appId: "YOUR_APP_ID" // Replace
};

// Pre-initialization check for placeholder databaseURL
if (firebaseConfig.databaseURL === "YOUR_DATABASE_URL" || !firebaseConfig.databaseURL.startsWith("https://")) {
  throw new Error(
    "CRITICAL FIREBASE CONFIGURATION ERROR: \n" +
    "The 'databaseURL' in 'src/lib/firebase.ts' is either still the placeholder 'YOUR_DATABASE_URL' or is not a valid HTTPS URL. \n" +
    "Please update it with your actual Firebase Realtime Database URL from your Firebase project console. \n" +
    "It should look like 'https://<YOUR-PROJECT-ID>.firebaseio.com' or 'https://<YOUR-PROJECT-ID>-default-rtdb.<region>.firebasedatabase.app'."
  );
}


let app: FirebaseApp;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

const db: Database = getDatabase(app);

export { app, db };
