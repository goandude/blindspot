
"use client";
import { useState, useEffect, useCallback } from 'react';
import { auth, db, googleProvider } from '@/lib/firebase';
import { onAuthStateChanged, signInWithRedirect, signOut, type User as FirebaseUser } from 'firebase/auth';
import { ref, set, onValue, off, remove, serverTimestamp, get, type DatabaseReference } from 'firebase/database';
import type { UserProfile, OnlineUser } from '@/types'; // Ensure OnlineUser is imported if used here for presence
import { useToast } from '@/hooks/use-toast';

interface AuthState {
  currentUser: FirebaseUser | null;
  userProfile: UserProfile | null;
  loading: boolean; // Overall auth process initial loading
  profileLoading: boolean; // Specifically for profile fetch/create step
  isProfileSetupNeeded: boolean;
  error: Error | null;
}

const initialAuthState: AuthState = {
  currentUser: null,
  userProfile: null,
  loading: true,
  profileLoading: false,
  isProfileSetupNeeded: false,
  error: null,
};

// Internal logger for this hook - logs to browser console
const hookDebugLog = (message: string) => {
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
  console.log(`[useAuth DEBUG] ${timestamp} - ${message}`);
};


export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);
  const { toast } = useToast();

  const fetchUserProfile = useCallback(async (userId: string): Promise<UserProfile | null> => {
    hookDebugLog(`fetchUserProfile: Attempting to fetch profile for user: ${userId}`);
    try {
      const userRef = ref(db, `users/${userId}`);
      const snapshot = await get(userRef);
      if (snapshot.exists()) {
        const profile = snapshot.val() as UserProfile;
        hookDebugLog(`fetchUserProfile: Profile found for ${userId}: ${JSON.stringify(profile)}`);
        return profile;
      }
      hookDebugLog(`fetchUserProfile: No profile found for ${userId}.`);
      return null;
    } catch (error: any) {
      hookDebugLog(`fetchUserProfile: Error fetching profile for ${userId}: ${error.message}`);
      console.error("Error fetching user profile:", error);
      setAuthState(prev => ({ ...prev, error, profileLoading: false, loading: false }));
      return null;
    }
  }, []);

  const createUserProfileInDb = useCallback(async (firebaseUser: FirebaseUser, countryCode: string): Promise<UserProfile> => {
    hookDebugLog(`createUserProfileInDb: Creating DB profile for new Google user: ${firebaseUser.uid}, Name: ${firebaseUser.displayName}, Email: ${firebaseUser.email}, Photo: ${firebaseUser.photoURL}, Country: ${countryCode}`);
    const newUserProfile: UserProfile = {
      id: firebaseUser.uid,
      name: firebaseUser.displayName || `User ${firebaseUser.uid.substring(0, 4)}`,
      email: firebaseUser.email || undefined,
      photoUrl: firebaseUser.photoURL || `https://placehold.co/96x96.png?text=${(firebaseUser.displayName || 'U').charAt(0).toUpperCase()}`,
      countryCode: countryCode,
      createdAt: serverTimestamp(),
      lastLogin: serverTimestamp(),
      // birthdate, sex, sexualOrientation will be set during profile setup step
    };
    try {
      await set(ref(db, `users/${firebaseUser.uid}`), newUserProfile);
      hookDebugLog(`createUserProfileInDb: DB Profile created for ${firebaseUser.uid}. Profile data: ${JSON.stringify(newUserProfile)}`);
      return newUserProfile;
    } catch (error: any) {
      hookDebugLog(`createUserProfileInDb: Error creating DB profile for ${firebaseUser.uid}: ${error.message}`);
      console.error("Error creating user profile in DB:", error);
      throw error; // Re-throw to be caught by caller
    }
  }, []);


  // Effect for Firebase Auth state changes
  useEffect(() => {
    hookDebugLog("Setting up onAuthStateChanged listener.");

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      hookDebugLog(`onAuthStateChanged triggered. User object: ${user ? JSON.stringify({uid: user.uid, email: user.email, displayName: user.displayName}) : 'null'}`);

      if (user) {
        hookDebugLog(`User detected: ${user.uid}. Setting intermediate state: currentUser present, profileLoading=true, loading=true (if it was initial).`);
        setAuthState(prev => ({
          ...prev,
          currentUser: user,
          profileLoading: true, // Start profile loading phase
          loading: prev.loading, // Keep initial loading true if it was, or if re-auth
          error: null
        }));

        try {
          let profile = await fetchUserProfile(user.uid);

          if (profile) {
            hookDebugLog(`Profile for ${user.uid} exists. Updating lastLogin.`);
            await set(ref(db, `users/${user.uid}/lastLogin`), serverTimestamp());
            hookDebugLog(`LastLogin updated for ${user.uid}.`);
            setAuthState(prev => ({
              ...prev,
              userProfile: profile,
              isProfileSetupNeeded: !profile.birthdate, // Check if profile is complete
              profileLoading: false,
              loading: false, // Auth and profile process complete
            }));
          } else {
            hookDebugLog(`No profile for ${user.uid}. Needs profile setup.`);
            // Don't create profile here automatically. Set flag for UI to prompt for setup.
            // A minimal profile might be created on first sign-in if desired, but profile builder is separate.
            // For now, we just flag that setup is needed.
            // If you want to create a stub profile:
            // let countryCode = 'XX'; try { const res = await fetch('https://ipapi.co/country_code/'); if(res.ok) countryCode = (await res.text()).trim(); } catch(e){}
            // profile = await createUserProfileInDb(user, countryCode); // This would create a basic one
            
            setAuthState(prev => ({
              ...prev,
              userProfile: null, // No full profile yet
              isProfileSetupNeeded: true, // Explicitly true
              profileLoading: false,
              loading: false, // Auth process complete, profile setup pending
            }));
          }
        } catch (profileError: any) {
          hookDebugLog(`Error during profile processing for ${user.uid}: ${profileError.message}`);
          setAuthState(prev => ({
            ...prev,
            userProfile: null,
            isProfileSetupNeeded: false, // Or true if error implies setup needed
            profileLoading: false,
            loading: false,
            error: profileError,
          }));
        }
      } else {
        hookDebugLog("No user found by onAuthStateChanged. Resetting auth state.");
        // Added a small delay, very speculative, likely won't fix core redirect issues
        // if caused by domain authorization or cookie problems.
        setTimeout(() => {
          setAuthState({
            currentUser: null,
            userProfile: null,
            loading: false,
            profileLoading: false,
            isProfileSetupNeeded: false,
            error: null,
          });
          hookDebugLog("Auth state reset after delay (no user).");
        }, 100);
      }
    }, (error) => {
      hookDebugLog(`Auth listener error: ${error.message}`);
      console.error("Auth listener error:", error);
      setAuthState({
        currentUser: null,
        userProfile: null,
        loading: false,
        profileLoading: false,
        isProfileSetupNeeded: false,
        error
      });
    });

    return () => {
      hookDebugLog("Cleaning up onAuthStateChanged listener.");
      unsubscribe();
    };
  }, [fetchUserProfile, createUserProfileInDb, toast]); // createUserProfileInDb was not used but good to list if it were

  // Presence for AUTHENTICATED users
  useEffect(() => {
    if (!authState.currentUser || !authState.userProfile) {
      hookDebugLog("Presence: No currentUser or no userProfile for authenticated presence. Skipping.");
      return;
    }
    const userId = authState.currentUser.uid;
    const userForPresence: OnlineUser = {
        id: userId,
        name: authState.userProfile.name,
        photoUrl: authState.userProfile.photoUrl,
        countryCode: authState.userProfile.countryCode,
        isGoogleUser: true, // This is an authenticated user
    };
    hookDebugLog(`Presence: Setting up for authenticated Google user ${userId} (${userForPresence.name})`);

    const userStatusRef: DatabaseReference = ref(db, `onlineUsers/${userId}`);
    const connectedRef = ref(db, '.info/connected');
    
    const presenceConnectionCallback = (snapshot: any) => {
      if (snapshot.val() === true) {
        hookDebugLog(`Presence: Firebase connection established for auth user ${userId}. Setting online status.`);
        const currentProfile = authState.userProfile; // Re-read from potentially updated state
        if (currentProfile) {
            const latestPresenceData: OnlineUser = {
                id: userId,
                name: currentProfile.name,
                photoUrl: currentProfile.photoUrl,
                countryCode: currentProfile.countryCode,
                isGoogleUser: true,
                timestamp: serverTimestamp(),
            };
            set(userStatusRef, latestPresenceData)
              .then(() => hookDebugLog(`Presence: Set online for auth user ${userId} with data: ${JSON.stringify(latestPresenceData)}.`))
              .catch(e => hookDebugLog(`Presence: ERROR setting online for auth user ${userId}: ${e.message || e}`));
            userStatusRef.onDisconnect().remove()
              .then(() => hookDebugLog(`Presence: onDisconnect().remove() set for auth user ${userId}.`))
              .catch(e => hookDebugLog(`Presence: ERROR setting onDisconnect for auth user ${userId}: ${e.message || e}`));
        } else {
             hookDebugLog(`Presence: Firebase connected for auth user ${userId}, but userProfile in authState is unexpectedly null. Cannot set presence.`);
        }
      } else {
        hookDebugLog(`Presence: Firebase connection lost for auth user ${userId}.`);
      }
    };
    
    onValue(connectedRef, presenceConnectionCallback);
    hookDebugLog(`Presence: Attached listener to .info/connected for auth user ${userId}`);

    return () => {
      hookDebugLog(`Presence: Cleaning up for auth user ${userId}. Detaching .info/connected listener.`);
      off(connectedRef, 'value', presenceConnectionCallback);
      // Note: onDisconnect should handle removal of userStatusRef if connection is truly lost.
      // Explicitly removing here can sometimes cause issues if the user is just navigating away
      // and onDisconnect hasn't fired yet, or if they open another tab quickly.
      // For sign-out, explicit removal is handled in signOutUser.
    };
  }, [authState.currentUser, authState.userProfile]); // Rerun if currentUser or userProfile changes


  const signInWithGoogle = async () => {
    hookDebugLog("signInWithGoogle: Attempting Google Sign-In with redirect.");
    setAuthState(prev => ({ ...prev, loading: true, profileLoading: false, error: null }));
    try {
      await signInWithRedirect(auth, googleProvider);
      // onAuthStateChanged will handle the rest after redirect.
      hookDebugLog("signInWithGoogle: signInWithRedirect initiated. Waiting for redirect and onAuthStateChanged.");
    } catch (error: any) {
      hookDebugLog(`signInWithGoogle: Error during signInWithRedirect initiation: ${error.message || error}`);
      console.error("Google Sign-In error:", error);
      setAuthState(prev => ({ ...prev, loading: false, error }));
      toast({ title: "Sign-In Error", description: error.message, variant: "destructive" });
    }
  };

  const signOutUser = async () => {
    const currentUserId = authState.currentUser?.uid;
    hookDebugLog(`signOutUser: Attempting Sign Out for user: ${currentUserId || 'N/A'}`);
    
    if (currentUserId) {
      const userStatusRef = ref(db, `onlineUsers/${currentUserId}`);
      try {
        await remove(userStatusRef);
        hookDebugLog(`signOutUser: Presence: Removed auth user ${currentUserId} from onlineUsers before sign out.`);
      } catch (error: any) {
        hookDebugLog(`signOutUser: Presence: WARN: Failed to remove auth user ${currentUserId} from onlineUsers during sign out: ${error.message}`);
      }
    }

    try {
      await signOut(auth);
      hookDebugLog("signOutUser: Sign Out successful. Auth state will be updated by onAuthStateChanged.");
      // No need to setAuthState here, onAuthStateChanged(auth, null) will fire.
      toast({ title: "Signed Out", description: "You have been signed out." });
    } catch (error: any) {
      hookDebugLog(`signOutUser: Sign Out error: ${error.message}`);
      console.error("Sign Out error:", error);
      setAuthState(prev => ({ ...prev, error, loading: false })); 
      toast({ title: "Sign Out Error", description: error.message, variant: "destructive" });
    }
  };

  const updateUserProfile = useCallback(async (profileData: Partial<UserProfile>): Promise<void> => {
    if (!authState.currentUser) {
      hookDebugLog("updateUserProfile: No current user, cannot update profile.");
      toast({ title: "Error", description: "You must be signed in to update your profile.", variant: "destructive" });
      throw new Error("User not authenticated");
    }
    const userId = authState.currentUser.uid;
    hookDebugLog(`updateUserProfile: Attempting to update profile for ${userId} with data: ${JSON.stringify(profileData)}`);
    try {
      await set(ref(db, `users/${userId}`), {
        ...authState.userProfile, // Spread existing profile to preserve fields like createdAt
        ...profileData,
        id: userId, // Ensure ID is always set
        lastLogin: serverTimestamp() // Update lastLogin on profile update too
      });
      const updatedProfile = await fetchUserProfile(userId); // Re-fetch to get server timestamp and ensure consistency
      setAuthState(prev => ({ ...prev, userProfile: updatedProfile, isProfileSetupNeeded: !updatedProfile?.birthdate }));
      hookDebugLog(`updateUserProfile: Profile updated successfully for ${userId}. New profile: ${JSON.stringify(updatedProfile)}`);
      toast({ title: "Profile Updated", description: "Your profile has been saved." });
    } catch (error: any) {
      hookDebugLog(`updateUserProfile: Error updating profile for ${userId}: ${error.message}`);
      console.error("Error updating user profile:", error);
      toast({ title: "Profile Update Error", description: error.message, variant: "destructive" });
      throw error;
    }
  }, [authState.currentUser, authState.userProfile, fetchUserProfile, toast]);


  return { ...authState, signInWithGoogle, signOutUser, updateUserProfile };
}
