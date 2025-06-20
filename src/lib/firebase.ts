
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getDatabase, type Database } from "firebase/database";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import { getStorage, type FirebaseStorage } from "firebase/storage"; // Added for Firebase Storage

// IMPORTANT: Replace placeholder values with your actual Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDphKB2KnXoOQSNhcGhLrk0LLw3SqgwXwQ",
 authDomain: "astute-helper-451908-q3.firebaseapp.com",
  //authDomain: "blindspot-gray.vercel.app",
  databaseURL: "https://astute-helper-451908-q3-default-rtdb.firebaseio.com",
  projectId: "astute-helper-451908-q3",
  storageBucket: "astute-helper-451908-q3.appspot.com", // Ensure this is correct for storage
  messagingSenderId: "309234429946",
  appId: "1:309234429946:web:288ea4fd39298e7f5abe43",
  measurementId: "G-9DZBLN4XCJ"
};

// Pre-initialization check for placeholder values
const placeholderStrings = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  databaseURL: "YOUR_DATABASE_URL", // Generic placeholder for databaseURL
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET.appspot.com", // Common format for storage bucket
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const stillPlaceholders: string[] = [];

if (firebaseConfig.apiKey === placeholderStrings.apiKey) stillPlaceholders.push("apiKey");
if (firebaseConfig.authDomain === placeholderStrings.authDomain) stillPlaceholders.push("authDomain");
if (firebaseConfig.projectId === placeholderStrings.projectId) stillPlaceholders.push("projectId");
if (firebaseConfig.storageBucket === placeholderStrings.storageBucket || firebaseConfig.storageBucket === "YOUR_PROJECT_ID.appspot.com") {
  stillPlaceholders.push("storageBucket");
}
if (firebaseConfig.messagingSenderId === placeholderStrings.messagingSenderId) stillPlaceholders.push("messagingSenderId");
if (firebaseConfig.appId === placeholderStrings.appId) stillPlaceholders.push("appId");

let invalidDatabaseURL = false;
if (firebaseConfig.databaseURL === placeholderStrings.databaseURL || 
    (firebaseConfig.databaseURL && !firebaseConfig.databaseURL.startsWith("https://"))) {
  invalidDatabaseURL = true;
}


if (stillPlaceholders.length > 0 || invalidDatabaseURL) {
  let errorMessage = "CRITICAL FIREBASE CONFIGURATION ERROR: \n";
  if (stillPlaceholders.length > 0) {
    errorMessage += `The following Firebase config values in 'src/lib/firebase.ts' are still placeholders or need verification: ${stillPlaceholders.join(', ')}. \n`;
  }
  if (invalidDatabaseURL) {
    errorMessage += `The databaseURL ('${firebaseConfig.databaseURL}') is invalid or a placeholder. It must start with 'https://' and point to your Firebase Realtime Database. \n`;
  }
  errorMessage += "Please update ALL placeholder values in 'src/lib/firebase.ts' with your actual Firebase project credentials. \n";
  errorMessage += "You can find these in your Firebase project console (Project settings > General > Your apps > SDK setup and configuration). \n";
  errorMessage += "The databaseURL should look like 'https://<YOUR-PROJECT-ID>.firebaseio.com' or 'https://<YOUR-PROJECT-ID>-default-rtdb.<region>.firebasedatabase.app'. \n";
  errorMessage += "The storageBucket should look like '<YOUR-PROJECT-ID>.appspot.com'.";
  
  console.error(errorMessage);
}


let app: FirebaseApp;

if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

const db: Database = getDatabase(app);
const auth: Auth = getAuth(app);
const storage: FirebaseStorage = getStorage(app); // Initialize Firebase Storage
const googleProvider = new GoogleAuthProvider();

export { app, db, auth, storage, googleProvider }; // Export storage
